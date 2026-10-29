import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  displaySize,
  displayToUser,
  normalizeRotation,
  stampPlacement,
} from '../src/lib/pageSpace';
import type { PageFrame, Stamp } from '../src/lib/types';

/**
 * P0 回归：显示空间 → 用户空间的映射。
 *
 * 这里**不重复实现**一遍公式去自证，而是拿 pdf.js 自己的
 * PageViewport.convertToPdfPoint() 当 oracle——渲染预览用的就是它。
 * 手写公式跟着它走，两边就不可能再各说各话。
 */

type Layout = { name: string; build: (doc: PDFDocument) => void };

const LAYOUTS: Layout[] = [
  { name: 'A4 竖版，无旋转', build: (d) => void d.addPage([595.28, 841.89]) },
  {
    name: 'A4 竖版 + /Rotate 90',
    build: (d) => void d.addPage([595.28, 841.89]).setRotation(degrees(90)),
  },
  {
    name: 'A4 竖版 + /Rotate 180',
    build: (d) => void d.addPage([595.28, 841.89]).setRotation(degrees(180)),
  },
  {
    name: 'A4 竖版 + /Rotate 270',
    build: (d) => void d.addPage([595.28, 841.89]).setRotation(degrees(270)),
  },
  {
    name: 'A4 横版 + /Rotate 90',
    build: (d) => void d.addPage([841.89, 595.28]).setRotation(degrees(90)),
  },
  {
    name: '裁切框四周内缩 20pt',
    build: (d) => void d.addPage([595.28, 841.89]).setCropBox(20, 20, 555.28, 801.89),
  },
  {
    name: '裁切框偏移 + /Rotate 270',
    build: (d) => {
      const p = d.addPage([595.28, 841.89]);
      p.setCropBox(12, 7, 560, 810);
      p.setRotation(degrees(270));
    },
  },
  {
    name: 'MediaBox 原点非零 + /Rotate 90',
    build: (d) => {
      const p = d.addPage([595.28, 841.89]);
      p.setMediaBox(15, 9, 595.28, 841.89);
      p.setRotation(degrees(90));
    },
  },
];

async function fixture(layout: Layout) {
  const doc = await PDFDocument.create();
  layout.build(doc);
  const bytes = await doc.save();

  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const frame: PageFrame = {
    view: [page.view[0], page.view[1], page.view[2], page.view[3]],
    rotation: page.rotate,
    userUnit: page.userUnit ?? 1,
  };
  return {
    frame,
    viewport,
    /** oracle：pdf.js 把显示坐标换算回用户空间 */
    toUser: (x: number, y: number) => viewport.convertToPdfPoint(x, y),
    release: () => task.destroy(),
  };
}

describe('displayToUser 与 pdf.js 的换算逐点一致', () => {
  for (const layout of LAYOUTS) {
    it(layout.name, async () => {
      const f = await fixture(layout);
      try {
        const { width: w, height: h } = f.viewport;
        const samples: Array<[number, number]> = [
          [0, 0],
          [w, 0],
          [0, h],
          [w, h],
          [w / 2, h / 2],
          [w * 0.13, h * 0.77],
          [w * 0.91, h * 0.04],
        ];
        for (const [x, y] of samples) {
          const mine = displayToUser(f.frame, x, y);
          const [ou, ov] = f.toUser(x, y);
          expect(mine.u, `u @(${x},${y})`).toBeCloseTo(ou, 9);
          expect(mine.v, `v @(${x},${y})`).toBeCloseTo(ov, 9);
        }
        // 显示空间尺寸也要与 pdf.js 报的一致
        const size = displaySize(f.frame);
        expect(size.wPt).toBeCloseTo(w, 9);
        expect(size.hPt).toBeCloseTo(h, 9);
      } finally {
        await f.release();
      }
    });
  }
});

describe('normalizeRotation', () => {
  it('归一到 0/90/180/270，含负值与超界', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-450)).toBe(270);
    expect(normalizeRotation(360)).toBe(0);
  });
});

const baseStamp: Pick<Stamp, 'xPt' | 'yPt' | 'widthPt' | 'heightPt' | 'rotationDeg'> = {
  xPt: 100,
  yPt: 120,
  widthPt: 113.386,
  heightPt: 113.386,
  rotationDeg: -8,
};

describe('stampPlacement', () => {
  const identity: PageFrame = { view: [0, 0, 595.28, 841.89], rotation: 0, userUnit: 1 };

  it('旋转轴是图像左下角：反解出的 pivot 让印章中心落在目标点上', () => {
    const p = stampPlacement(baseStamp, identity);
    const a = (p.rotationDeg * Math.PI) / 180;
    const hw = baseStamp.widthPt / 2;
    const hh = baseStamp.heightPt / 2;
    const cx = p.x + (hw * Math.cos(a) - hh * Math.sin(a));
    const cy = p.y + (hw * Math.sin(a) + hh * Math.cos(a));
    expect(cx).toBeCloseTo(baseStamp.xPt + hw, 9);
    expect(cy).toBeCloseTo(identity.view[3] - (baseStamp.yPt + hh), 9);
  });

  it('用户空间角 = 页面旋转 − 印章倾角（/Rotate 页面上章不会躺倒）', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const frame: PageFrame = { view: [0, 0, 595.28, 841.89], rotation, userUnit: 1 };
      const p = stampPlacement(baseStamp, frame);
      expect(p.rotationDeg).toBe(rotation - baseStamp.rotationDeg);
    }
  });

  it('无旋转、无裁切偏移时退化为改造前的公式', () => {
    const theta = (-baseStamp.rotationDeg * Math.PI) / 180;
    const hw = baseStamp.widthPt / 2;
    const hh = baseStamp.heightPt / 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const p = stampPlacement(baseStamp, identity);
    expect(p.x).toBeCloseTo(baseStamp.xPt + hw - (hw * cos - hh * sin), 9);
    expect(p.y).toBeCloseTo(
      identity.view[3] - (baseStamp.yPt + hh) - (hw * sin + hh * cos),
      9,
    );
  });
});
