import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { stampDocument } from '../src/lib/exporter';
import type { PageFrame, Stamp } from '../src/lib/types';

/**
 * P0 回归（文件级）：导出后 PDF 内容流里的图像矩阵，必须把印章中心放在
 * **pdf.js 说的那个位置**。
 *
 * 断言对象是真实产出的 /cm 矩阵，不是我们的中间变量，所以这条测试卡住的
 * 正是「预览/导出各说各话」这一类 bug：/Rotate 90 的页面上它曾经偏 43mm，
 * 「右下角」预设甚至会把章整个画到可见页面之外。
 */

async function frameOf(doc: PDFDocument, pageIndex = 0) {
  const bytes = await doc.save();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const pdf = await task.promise;
  const page = await pdf.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const frame: PageFrame = {
    view: [page.view[0], page.view[1], page.view[2], page.view[3]],
    rotation: page.rotate,
    userUnit: page.userUnit ?? 1,
  };
  return { frame, viewport, release: () => task.destroy() };
}

type Mat = { a: number; b: number; c: number; d: number; e: number; f: number };
const IDENT: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** 行向量约定下的矩阵拼接：p' = p · M */
const mul = (m: Mat, n: Mat): Mat => ({
  a: m.a * n.a + m.b * n.c,
  b: m.a * n.b + m.b * n.d,
  c: m.c * n.a + m.d * n.c,
  d: m.c * n.b + m.d * n.d,
  e: m.e * n.a + m.f * n.c + n.e,
  f: m.e * n.b + m.f * n.d + n.f,
});

const TOKEN = /\/[^\s/<>\[\]()]+|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|q|Q|cm|Do/g;

/**
 * 取出图像 XObject 的**完整 CTM**。
 *
 * pdf-lib 的 drawImage 会展开成一串独立的算子：
 *   q  1 0 0 1 x y cm  cos sin -sin cos 0 0 cm  w 0 0 h 0 0 cm  /Im0 Do  Q
 * 只取紧挨着 Do 的那个 cm 会得到"S 缩放矩阵"而不是最终位置，所以必须按
 * PDF 语义把 q 之后的所有 cm 依次拼起来（中间隔着 q/Q 的图形状态要还原）。
 */
function lastImageMatrix(text: string): Mat {
  const tokens = text.match(TOKEN) ?? [];
  const stack: Mat[] = [];
  let ctm: Mat = IDENT;
  let lastName = '';
  let operands: number[] = [];
  let found: Mat | null = null;

  for (const t of tokens) {
    if (t === 'q') {
      stack.push(ctm);
      operands = [];
    } else if (t === 'Q') {
      ctm = stack.pop() ?? IDENT;
      operands = [];
    } else if (t === 'cm') {
      const [a, b, c, d, e, f] = operands.slice(-6);
      ctm = mul({ a, b, c, d, e, f }, ctm);
      operands = [];
    } else if (t === 'Do') {
      if (lastName) found = ctm;
      operands = [];
    } else if (t.startsWith('/')) {
      lastName = t;
    } else {
      operands.push(Number(t));
    }
  }
  if (!found) throw new Error('内容流里没有找到图像绘制（Do）');
  return found;
}

/** 内容流可能是 FlateDecode 压过的，压过就解一次。 */
function decodeStream(bytes: Uint8Array): string {
  const plain = new TextDecoder('latin1').decode(bytes);
  if (plain.includes(' Do')) return plain;
  try {
    return new TextDecoder('latin1').decode(inflateSync(bytes));
  } catch {
    return plain;
  }
}

/** 页面内容流可能有多段（原始内容 + 我们追加的），全部拼起来。 */
async function contentText(out: Uint8Array, pageIndex = 0): Promise<string> {
  const doc = await PDFDocument.load(out);
  const entry = doc.getPage(pageIndex).node.Contents();
  const node = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;

  const parts: Uint8Array[] = [];
  const take = (obj: unknown) => {
    const s = obj as { getContents?: () => Uint8Array };
    if (typeof s?.getContents !== 'function') {
      throw new Error(`不支持的内容流类型：${(obj as object)?.constructor?.name}`);
    }
    parts.push(s.getContents());
  };
  if (node instanceof PDFArray) {
    for (let i = 0; i < node.size(); i++) take(node.lookup(i));
  } else {
    take(node);
  }

  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    joined.set(p, at);
    at += p.length;
    joined[at++] = 0x0a;
  }
  return decodeStream(joined);
}

/** 文档里的图像 XObject（含 alpha 通道生成的 /SMask）。 */
async function imageObjects(out: Uint8Array) {
  const doc = await PDFDocument.load(out);
  return doc.context
    .enumerateIndirectObjects()
    .filter(
      ([, obj]) =>
        obj instanceof PDFRawStream &&
        obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'),
    );
}

const PNG_1x1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (ch) => ch.charCodeAt(0),
);

const WIDTH_PT = 113.3858; // 40mm

async function runCase(opts: {
  rotation: number;
  cropInset?: number;
  stampRotation: number;
  displayX: number;
  displayY: number;
}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  if (opts.cropInset) {
    const k = opts.cropInset;
    page.setCropBox(k, k, 595.28 - 2 * k, 841.89 - 2 * k);
  }
  if (opts.rotation) page.setRotation(degrees(opts.rotation));

  const { frame, viewport, release } = await frameOf(doc);
  const stamp: Stamp = {
    id: 's1',
    pageIndex: 0,
    pngBytes: PNG_1x1,
    xPt: opts.displayX,
    yPt: opts.displayY,
    widthPt: WIDTH_PT,
    heightPt: WIDTH_PT,
    rotationDeg: opts.stampRotation,
    opacity: 1,
    aspect: 1,
    cropW: 1000,
  };
  const out = await stampDocument(await PDFDocument.load(await doc.save()), [stamp], {
    frames: [frame],
  });
  // oracle：这个显示坐标在用户空间到底是哪儿
  const [wantU, wantV] = viewport.convertToPdfPoint(
    stamp.xPt + WIDTH_PT / 2,
    stamp.yPt + WIDTH_PT / 2,
  );
  await release();
  return { matrix: lastImageMatrix(await contentText(out)), wantU, wantV };
}

describe('stampDocument 把印章画在 pdf.js 指的位置', () => {
  const cases: Array<[string, Parameters<typeof runCase>[0]]> = [
    ['普通页 · 倾角 -8°', { rotation: 0, stampRotation: -8, displayX: 200, displayY: 300 }],
    ['普通页 · 不倾斜', { rotation: 0, stampRotation: 0, displayX: 40, displayY: 40 }],
    ['/Rotate 90 · 居中', { rotation: 90, stampRotation: -8, displayX: 364.25, displayY: 240.95 }],
    ['/Rotate 90 · 右下角预设', { rotation: 90, stampRotation: -8, displayX: 694.49, displayY: 447.9 }],
    ['/Rotate 180', { rotation: 180, stampRotation: 12, displayX: 120, displayY: 500 }],
    ['/Rotate 270', { rotation: 270, stampRotation: 25, displayX: 500, displayY: 120 }],
    ['裁切框内缩 20pt', { rotation: 0, cropInset: 20, stampRotation: -8, displayX: 200, displayY: 300 }],
    ['裁切框内缩 + /Rotate 90', { rotation: 90, cropInset: 20, stampRotation: -8, displayX: 200, displayY: 300 }],
  ];

  for (const [name, opts] of cases) {
    it(name, async () => {
      const { matrix, wantU, wantV } = await runCase(opts);
      // 图像占满单位方形，中心 = M · (0.5, 0.5)
      const gotU = matrix.e + 0.5 * (matrix.a + matrix.c);
      const gotV = matrix.f + 0.5 * (matrix.b + matrix.d);
      expect(gotU, '中心 u').toBeCloseTo(wantU, 6);
      expect(gotV, '中心 v').toBeCloseTo(wantV, 6);
      // 角度：用户空间逆时针为正
      const angle = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
      const want = opts.rotation - opts.stampRotation;
      const diff = ((angle - want + 540) % 360) - 180;
      expect(Math.abs(diff), `角度 ${angle} vs ${want}`).toBeLessThan(1e-6);
    });
  }
});

describe('stampDocument 的其他行为', () => {
  const baseStamp = (over: Partial<Stamp> = {}): Stamp => ({
    id: 's1',
    pageIndex: 0,
    pngBytes: PNG_1x1,
    xPt: 10,
    yPt: 10,
    widthPt: 50,
    heightPt: 50,
    rotationDeg: 0,
    opacity: 1,
    aspect: 1,
    cropW: 10,
    ...over,
  });

  it('低于不透明度阈值的章不写入', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    const out = await stampDocument(doc, [baseStamp({ opacity: 0.001 })]);
    expect(await imageObjects(out)).toHaveLength(0);
  });

  it('同一张图在多页只嵌入一次', async () => {
    const once = await PDFDocument.create();
    once.addPage([595.28, 841.89]);
    once.addPage([595.28, 841.89]);
    const onePage = await stampDocument(once, [baseStamp()]);

    const twice = await PDFDocument.create();
    twice.addPage([595.28, 841.89]);
    twice.addPage([595.28, 841.89]);
    const bothPages = await stampDocument(twice, [
      baseStamp(),
      baseStamp({ id: 's2', pageIndex: 1 }),
    ]);

    // 图像 + alpha 通道的 /SMask 是固定开销；关键是复制到第二页后不再增加
    const a = await imageObjects(onePage);
    const b = await imageObjects(bothPages);
    expect(b.length).toBe(a.length);
  });

  it('内容流里的图像矩阵是可解析的（回归测试自身的前提）', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    const out = await stampDocument(doc, [baseStamp()]);
    expect(await contentText(out)).toMatch(/cm\s*\/\S+\s+Do/);
  });
});
