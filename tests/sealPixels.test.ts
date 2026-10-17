import { describe, expect, it } from 'vitest';
import {
  estimatePalette,
  hasRealAlpha,
  inkBounds,
  removePaperBackground,
  removeWhiteFringe,
} from '../src/lib/sealPixels';

/**
 * 回归：翻拍照片版印章的「重影」。
 *
 * 症状：手机拍的印章图整张没有真透明像素（或被抠图工具写成整片半透明），
 * 旧实现相信源 alpha，于是半透明的墨直接盖在合同上，**底下的字透上来**，
 * 看着就是重影。修复后 alpha 由「离纸色多远」反推，墨是实心的。
 */

const PAPER = { r: 250, g: 248, b: 246 };
const INK = { r: 198, g: 28, b: 38 };
const W = 140;
const H = 140;

/** 造一张翻拍图：纸底 + 圆环墨迹（带软边）。cover(x,y) ∈ [0,1] 是真实的墨覆盖率。 */
function photoLike(opts: { alpha?: number; gradient?: boolean } = {}) {
  const data = new Uint8ClampedArray(W * H * 4);
  const cx = W / 2;
  const cy = H / 2;
  const rIn = 44;
  const rOut = 54;
  const cover = (x: number, y: number) => {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= rIn) return 1;
    if (d >= rOut) return 0;
    return 1 - (d - rIn) / (rOut - rIn);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const t = cover(x, y);
      // 真实照片纸底不是均匀的：加一点横向亮度渐变
      const shade = opts.gradient ? 1 - 0.05 * (x / W) : 1;
      data[i] = (t * INK.r + (1 - t) * PAPER.r) * shade;
      data[i + 1] = (t * INK.g + (1 - t) * PAPER.g) * shade;
      data[i + 2] = (t * INK.b + (1 - t) * PAPER.b) * shade;
      data[i + 3] = opts.alpha ?? 255;
    }
  }
  return data;
}

const at = (d: Uint8ClampedArray, x: number, y: number) => {
  const i = (y * W + x) * 4;
  return { r: d[i], g: d[i + 1], b: d[i + 2], a: d[i + 3] };
};

describe('hasRealAlpha：区分「规范透明 PNG」与「翻拍照片」', () => {
  it('整片不透明 → 不是真 alpha', () => {
    expect(hasRealAlpha(photoLike({ alpha: 255 }))).toBe(false);
  });

  it('整片半透明（抠图工具的产物）→ 也不是真 alpha', () => {
    expect(hasRealAlpha(photoLike({ alpha: 128 }))).toBe(false);
  });

  it('有足量全透明像素 → 是真 alpha', () => {
    const d = photoLike();
    for (let i = 0; i < d.length; i += 4) if (d[i] === PAPER.r && d[i + 1] === PAPER.g) d[i + 3] = 0;
    expect(hasRealAlpha(d)).toBe(true);
  });
});

describe('removePaperBackground：反推墨量、还原实心墨色', () => {
  it('纸的地方变全透明，墨的地方接近不透明（这正是「重影」的修复点）', () => {
    const d = photoLike({ alpha: 128 });
    const palette = estimatePalette(d);
    expect(palette.inkDistance).toBeGreaterThan(200); // 纸→墨距离足够大才敢做
    expect(removePaperBackground(d, palette)).toBe(true);

    expect(at(d, 2, 2).a, '角落纸底').toBe(0);
    // d=40 落在实心墨内（rIn=44 以内），d=49 是软边中点
    const ring = at(d, W / 2 + 40, H / 2);
    expect(ring.a, '实心墨 alpha').toBeGreaterThan(250);
    // 颜色被反预乘回实心墨色，而不是半透明混合出来的粉红
    expect(Math.abs(ring.r - INK.r)).toBeLessThan(12);
    expect(Math.abs(ring.g - INK.g)).toBeLessThan(12);
    expect(Math.abs(ring.b - INK.b)).toBeLessThan(12);
  });

  it('往返等式：α·S + (1−α)·纸色 ≡ 原像素（纸底均匀时几乎精确）', () => {
    const d = photoLike();
    const orig = Uint8ClampedArray.from(d);
    const palette = estimatePalette(d);
    removePaperBackground(d, palette);

    let worst = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      if (a < 0.15) continue;
      for (let c = 0; c < 3; c++) {
        const paper = [palette.paper.r, palette.paper.g, palette.paper.b][c];
        const back = a * d[i + c] + (1 - a) * paper;
        worst = Math.max(worst, Math.abs(back - orig[i + c]));
      }
    }
    expect(worst).toBeLessThan(1.5);
  });

  it('纸底有光照渐变时依然成立（纸的地方仍然全透明）', () => {
    const d = photoLike({ gradient: true });
    const palette = estimatePalette(d);
    expect(removePaperBackground(d, palette)).toBe(true);
    expect(at(d, 2, 2).a).toBe(0);
    expect(at(d, W - 3, 2).a).toBe(0);
    expect(at(d, W / 2 + 40, H / 2).a).toBeGreaterThan(250);
  });

  it('软边保留渐变，不会变成硬边', () => {
    const d = photoLike();
    const palette = estimatePalette(d);
    removePaperBackground(d, palette);
    const alphas: number[] = [];
    for (let r = 44; r <= 54; r++) alphas.push(at(d, Math.round(W / 2 + r), H / 2).a);
    const middle = alphas.filter((a) => a > 8 && a < 247);
    expect(middle.length, '过渡带应有中间值').toBeGreaterThan(5);
  });

  it('背景本来就暗（不是纸底）时不做，交回另一条路', () => {
    const dark = photoLike();
    for (let i = 0; i < dark.length; i += 4) {
      dark[i] = 40;
      dark[i + 1] = 30;
      dark[i + 2] = 30;
      dark[i + 3] = 255;
    }
    expect(removePaperBackground(dark, estimatePalette(dark))).toBe(false);
  });

  it('几乎没有墨迹的图直接放弃，不硬做', () => {
    const blank = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < blank.length; i += 4) {
      blank[i] = PAPER.r;
      blank[i + 1] = PAPER.g;
      blank[i + 2] = PAPER.b;
      blank[i + 3] = 255;
    }
    expect(removePaperBackground(blank, estimatePalette(blank))).toBe(false);
  });
});

describe('规范透明 PNG 的老路线不受影响', () => {
  it('去白边只清「非透明且 RGB≈白」的像素', () => {
    const d = new Uint8ClampedArray(4 * 4 * 4);
    const put = (i: number, r: number, g: number, b: number, a: number) => {
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a;
    };
    put(0, 255, 255, 255, 255); // 白边 → 去掉
    put(1, 250, 250, 250, 255); // 近白 → 去掉
    put(2, 200, 30, 40, 255);   // 墨 → 留下
    put(3, 255, 255, 255, 0);   // 本来就透明 → 不计入
    expect(removeWhiteFringe(d)).toBeCloseTo(2 / 3, 5);
    expect(at(d, 0, 0).a).toBe(0);
    expect(at(d, 2, 0).a).toBe(255);
  });

  it('inkBounds 裁到墨迹边界并留边距', () => {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 20; y < 40; y++) for (let x = 30; x < 50; x++) d[(y * W + x) * 4 + 3] = 200;
    expect(inkBounds(d, W, H, 2)).toEqual({ x: 28, y: 18, w: 24, h: 24 });
  });

  it('全透明图返回 null', () => {
    expect(inkBounds(new Uint8ClampedArray(W * H * 4), W, H, 2)).toBeNull();
  });
});
