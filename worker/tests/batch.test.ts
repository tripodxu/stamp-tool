import { describe, expect, it } from 'vitest';
import {
  batchStamps,
  fileKey,
  isPdfFile,
  pageIndices,
  parsePageSpec,
  pickNewPdfs,
  stampedName,
  zipName,
  type BatchSeed,
} from '../src/lib/batch';
import type { PageInfo } from '../src/lib/types';
import { mmToPt } from '../src/lib/units';

const A4: [number, number] = [595.28, 841.89];

const page = (wPt: number, hPt: number, rotation = 0): PageInfo => ({
  wPt,
  hPt,
  view: [0, 0, wPt, hPt],
  rotation,
  userUnit: 1,
});

const SEED: BatchSeed = {
  pngBytes: new Uint8Array([1, 2, 3, 4]),
  widthPt: mmToPt(40),
  heightPt: mmToPt(40),
  rotationDeg: -8,
  opacity: 0.85,
  aspect: 1,
  cropW: 400,
};

describe('parsePageSpec', () => {
  it('留空 = 全部页', () => {
    expect(parsePageSpec('')).toEqual({ pages: [], last: false });
    expect(parsePageSpec('   ')).toEqual({ pages: [], last: false });
  });

  it('支持逗号、区间、中文标点与空格', () => {
    expect(parsePageSpec('1,3,5-8').pages).toEqual([1, 3, 5, 6, 7, 8]);
    expect(parsePageSpec('1，3、5-8').pages).toEqual([1, 3, 5, 6, 7, 8]);
    expect(parsePageSpec('8-5').pages).toEqual([5, 6, 7, 8]);
    expect(parsePageSpec(' 2 4 ').pages).toEqual([2, 4]);
  });

  it('末页是每份文件各自的最后一页', () => {
    expect(parsePageSpec('末页')).toEqual({ pages: [], last: true });
    expect(parsePageSpec('last')).toEqual({ pages: [], last: true });
    expect(parsePageSpec('末页, 2')).toEqual({ pages: [2], last: true });
  });

  it('看不懂的写法报错，不猜', () => {
    expect(() => parsePageSpec('第三页')).toThrow(/页码/);
    expect(() => parsePageSpec('1-')).toThrow(/页码/);
    expect(() => parsePageSpec('0')).toThrow('页码从 1 开始');
    expect(() => parsePageSpec('全部,1')).toThrow(/不能和具体页码/);
  });
});

describe('pageIndices', () => {
  it('空选择器 = 这份文件的全部页', () => {
    expect(pageIndices(parsePageSpec(''), 3)).toEqual([0, 1, 2]);
    expect(pageIndices(parsePageSpec(''), 0)).toEqual([]);
  });

  it('越界页码忽略（批量里各文件页数不同）', () => {
    expect(pageIndices(parsePageSpec('1,5-9'), 3)).toEqual([0]);
  });

  it('末页落到这份文件自己的最后一页', () => {
    expect(pageIndices(parsePageSpec('末页'), 7)).toEqual([6]);
    expect(pageIndices(parsePageSpec('1,末页'), 7)).toEqual([0, 6]);
  });

  it('全越界 → 空集（调用方据此跳过这个文件）', () => {
    expect(pageIndices(parsePageSpec('9'), 3)).toEqual([]);
  });
});

describe('batchStamps', () => {
  it('偏移模式：每页用同一偏移，保留画布上的角度', () => {
    const pages = [page(...A4), page(...A4)];
    const stamps = batchStamps({
      seed: SEED,
      origin: { xPt: 100, yPt: 200 },
      placement: { mode: 'offset' },
      pages,
      selector: parsePageSpec(''),
      idPrefix: 'b0',
    });
    expect(stamps).toHaveLength(2);
    expect(stamps.map((s) => s.pageIndex)).toEqual([0, 1]);
    for (const s of stamps) {
      expect(s.xPt).toBe(100);
      expect(s.yPt).toBe(200);
      expect(s.rotationDeg).toBe(-8);
    }
    expect(new Set(stamps.map((s) => s.id)).size).toBe(2);
  });

  it('偏移模式：页面装不下时夹回来，至少留四分之一在页内', () => {
    const stamps = batchStamps({
      seed: SEED,
      origin: { xPt: 100, yPt: 200 },
      placement: { mode: 'offset' },
      pages: [page(200, 200)],
      selector: parsePageSpec(''),
      idPrefix: 'b0',
    });
    expect(stamps[0].yPt).toBeCloseTo(200 - SEED.heightPt * 0.25, 6);
    expect(stamps[0].yPt).toBeLessThan(200);
  });

  it('预设模式：按每页尺寸重算，连角度一起换', () => {
    const pages = [page(...A4), page(300, 400)];
    const stamps = batchStamps({
      seed: SEED,
      origin: { xPt: 0, yPt: 0 },
      placement: { mode: 'preset', preset: 'rightBottom' },
      pages,
      selector: parsePageSpec(''),
      idPrefix: 'b0',
    });
    expect(stamps[0].xPt).toBeCloseTo(A4[0] - SEED.widthPt - mmToPt(12), 6);
    expect(stamps[0].yPt).toBeCloseTo(A4[1] - SEED.heightPt - mmToPt(12), 6);
    expect(stamps[1].xPt).toBeCloseTo(300 - SEED.widthPt - mmToPt(12), 6);
    expect(stamps[1].yPt).toBeCloseTo(400 - SEED.heightPt - mmToPt(12), 6);
    expect(stamps.every((s) => s.rotationDeg === -8)).toBe(true);
  });

  it('只给选中的页生成', () => {
    const stamps = batchStamps({
      seed: SEED,
      origin: { xPt: 10, yPt: 10 },
      placement: { mode: 'offset' },
      pages: [page(...A4), page(...A4), page(...A4)],
      selector: parsePageSpec('3'),
      idPrefix: 'b0',
    });
    expect(stamps).toHaveLength(1);
    expect(stamps[0].pageIndex).toBe(2);
  });

  it('尺寸、浓度、图像与像素宽度都随种子走（不因页而异）', () => {
    const stamps = batchStamps({
      seed: SEED,
      origin: { xPt: 10, yPt: 10 },
      placement: { mode: 'offset' },
      pages: [page(...A4), page(300, 400)],
      selector: parsePageSpec(''),
      idPrefix: 'b0',
    });
    for (const s of stamps) {
      expect(s.widthPt).toBe(SEED.widthPt);
      expect(s.heightPt).toBe(SEED.heightPt);
      expect(s.opacity).toBe(SEED.opacity);
      expect(s.aspect).toBe(SEED.aspect);
      expect(s.cropW).toBe(SEED.cropW);
      expect(s.pngBytes).toBe(SEED.pngBytes);
    }
  });
});

describe('命名', () => {
  it('输出文件名', () => {
    expect(stampedName('合同.pdf')).toBe('合同-已盖章.pdf');
    expect(stampedName('无后缀')).toBe('无后缀-已盖章.pdf');
    expect(stampedName('a.b.pdf')).toBe('a.b-已盖章.pdf');
  });

  it('压缩包名字带份数与时间', () => {
    expect(zipName(3, new Date(2026, 9, 17, 9, 5))).toBe('已盖章 3 份 20261017 0905.zip');
  });
});

describe('拖进来的文件先过一遍：fileKey / isPdfFile / pickNewPdfs', () => {
  const f = (name: string, size = 1, lastModified = 1, type = '') =>
    ({ name, size, lastModified, type }) as File;

  it('fileKey 认名字+大小+时间：同名的两份不同文件不会被当成同一份', () => {
    expect(fileKey(f('a.pdf', 10, 111))).toBe('a.pdf|10|111');
    expect(fileKey(f('a.pdf', 10, 222))).not.toBe(fileKey(f('a.pdf', 10, 111)));
  });

  it('isPdfFile 认 MIME，也认扩展名（有些来源拖进来 type 是空的）', () => {
    expect(isPdfFile(f('a.pdf'))).toBe(true);
    expect(isPdfFile(f('a.PDF'))).toBe(true);
    expect(isPdfFile(f('a.bin', 1, 1, 'application/pdf'))).toBe(true);
    expect(isPdfFile(f('a.png', 1, 1, 'image/png'))).toBe(false);
  });

  it('pickNewPdfs 丢掉非 PDF，也丢掉清单里已有的（同一份拖两次不该出现两行）', () => {
    const out = pickNewPdfs(
      ['a.pdf|1|1'],
      [f('a.pdf'), f('b.pdf', 2, 2), f('c.png', 3, 3, 'image/png')],
    );
    expect(out.map((x) => x.name)).toEqual(['b.pdf']);
  });

  it('没给已有清单时原样收下所有 PDF', () => {
    const out = pickNewPdfs([], [f('a.pdf'), f('b.pdf', 2, 2)]);
    expect(out).toHaveLength(2);
  });
});

