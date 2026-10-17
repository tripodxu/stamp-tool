import { describe, expect, it } from 'vitest';
import {
  clamp,
  defaultOpacity,
  defaultPlacement,
  presetPatch,
  PRESET_LABELS,
} from '../src/lib/geometry';
import { mmToPt, STANDARD_SEAL_MM } from '../src/lib/units';
import type { PageInfo } from '../src/lib/types';

const a4: PageInfo = {
  wPt: 595.28,
  hPt: 841.89,
  view: [0, 0, 595.28, 841.89],
  rotation: 0,
  userUnit: 1,
};
// 42mm 直径的正圆章
const side = mmToPt(42);
const size = { widthPt: side, heightPt: side };

describe('位置预设', () => {
  it('落款处 / 右下角把章完整放在页面内', () => {
    for (const kind of ['signature', 'rightBottom'] as const) {
      const p = presetPatch(size, a4, kind);
      expect(p.xPt, kind).toBeGreaterThanOrEqual(0);
      expect(p.yPt, kind).toBeGreaterThanOrEqual(0);
      expect(p.xPt + size.widthPt, kind).toBeLessThanOrEqual(a4.wPt + 0.001);
      expect(p.yPt + size.heightPt, kind).toBeLessThanOrEqual(a4.hPt + 0.001);
    }
  });

  it('骑缝（右）刻意一半在页外（章心压右边缘）', () => {
    const p = presetPatch(size, a4, 'bindingEdgeRight');
    expect(p.xPt + size.widthPt).toBeGreaterThan(a4.wPt);
    expect(p.xPt).toBeLessThan(a4.wPt);
  });

  it('骑缝（左）章心压左边缘，一半在页外（左侧装订的合同）', () => {
    const p = presetPatch(size, a4, 'bindingEdgeLeft');
    expect(p.xPt + size.widthPt / 2).toBeCloseTo(0, 6);
    expect(p.xPt).toBeLessThan(0);
    expect(p.xPt + size.widthPt).toBeGreaterThan(0);
  });

  it('右下角距边 12mm', () => {
    const p = presetPatch(size, a4, 'rightBottom');
    expect(a4.wPt - (p.xPt + size.widthPt)).toBeCloseTo(mmToPt(12), 6);
    expect(a4.hPt - (p.yPt + size.heightPt)).toBeCloseTo(mmToPt(12), 6);
  });

  it('两种骑缝的章心分别压在左右边缘（多页才能天然对齐）', () => {
    const right = presetPatch(size, a4, 'bindingEdgeRight');
    expect(right.xPt + size.widthPt / 2).toBeCloseTo(a4.wPt, 6);
    const left = presetPatch(size, a4, 'bindingEdgeLeft');
    expect(left.xPt + size.widthPt / 2).toBeCloseTo(0, 6);
    // 纵向位置一致：只有横向不同
    expect(left.yPt).toBeCloseTo(right.yPt, 6);
  });

  it('骑缝的纵向：章顶在页面高度的 28% 处（自页顶算，左右一致）', () => {
    // 量的是显示坐标（原点在页面左上角），所以「28%」是自上而下的 28%。
    // 之前这里没有断言，验收脚本里的期望值一度按「自页底算」写反了，
    // 靠真实导出文件的像素才把语义钉住（见 scripts/acceptance-batch.py）。
    for (const kind of ['bindingEdgeLeft', 'bindingEdgeRight'] as const) {
      const p = presetPatch(size, a4, kind);
      expect(p.yPt, kind).toBeCloseTo(a4.hPt * 0.28, 6);
      // 章心 = 28% + 半个章（42mm 章 → 21mm，A4 高 297mm）
      expect((p.yPt + size.heightPt / 2) / a4.hPt, kind).toBeCloseTo(0.28 + 21 / 297, 3);
    }
  });

  it('每个预设都有标签（漏一个界面上就是空白按钮）', () => {
    expect(Object.keys(PRESET_LABELS).sort()).toEqual(
      ['bindingEdgeLeft', 'bindingEdgeRight', 'rightBottom', 'signature'],
    );
  });
});

describe('defaultPlacement', () => {
  it('水平居中，纵向落在页面下方 72% 处', () => {
    const p = defaultPlacement(size, a4);
    expect(p.xPt + size.widthPt / 2).toBeCloseTo(a4.wPt / 2, 6);
    expect(p.yPt + size.heightPt / 2).toBeCloseTo(a4.hPt * 0.72, 6);
  });

  it('章比页面还宽时 x 夹到 0，不产生负坐标', () => {
    const huge = { widthPt: a4.wPt + 100, heightPt: size.heightPt };
    expect(defaultPlacement(huge, a4).xPt).toBe(0);
  });
});

describe('clamp', () => {
  it('双向夹紧且不越界', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
    // lo > hi 时取 hi（跨页复制会用页面宽度算上界）
    expect(clamp(3, 10, 0)).toBe(0);
  });
});

describe('常量', () => {
  it('法定章径 40mm', () => {
    expect(STANDARD_SEAL_MM).toBe(40);
  });

  it('翻拍件默认不压透明度（否则底下的字会透上来 = 重影）', () => {
    expect(defaultOpacity('paper')).toBe(1);
    expect(defaultOpacity('alpha')).toBe(0.85);
  });
});
