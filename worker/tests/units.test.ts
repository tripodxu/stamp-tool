import { describe, expect, it } from 'vitest';
import { effectiveDpi, mmToPt, ptToMm, DPI_WARN } from '../src/lib/units';
import { assessSealQuality } from '../src/lib/seal';

describe('单位换算', () => {
  it('40mm = 113.386pt（1pt = 1/72 inch）', () => {
    expect(mmToPt(40)).toBeCloseTo(113.38582677165354, 10);
  });

  it('往返无损', () => {
    for (const mm of [0, 1, 12, 40, 42, 210, 297]) {
      expect(ptToMm(mmToPt(mm))).toBeCloseTo(mm, 10);
    }
  });
});

describe('分辨率体检', () => {
  it('有效 DPI = 像素宽 / 英寸', () => {
    // 40mm 直径下 472px ≈ 299.7 DPI（设计文档里的「合格下限」量级）
    expect(effectiveDpi(472, 40)).toBeCloseTo(299.72, 2);
    expect(effectiveDpi(945, 40)).toBeCloseTo(600.075, 3);
  });

  it('三档阈值：300 达标 / 180~300 警告 / 以下不合格', () => {
    expect(assessSealQuality(473, 40).level).toBe('good');
    expect(assessSealQuality(472, 40).level).toBe('warn'); // 299.7，差一点
    expect(assessSealQuality(400, 40).level).toBe('warn');
    expect(assessSealQuality(284, 40).level).toBe('warn'); // 180.3，刚过下限
    expect(assessSealQuality(280, 40).level).toBe('bad'); // 177.8
    expect(DPI_WARN).toBe(300);
  });

  it('提示语里带上实测 DPI', () => {
    expect(assessSealQuality(400, 40).text).toContain('254');
  });
});
