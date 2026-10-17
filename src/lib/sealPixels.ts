/**
 * 印章像素算法（纯函数，可直接单测）。
 *
 * 背景：早期只处理一种输入——**规范的透明底 PNG**，做法是「alpha>0 但 RGB≈白」
 * 的像素置为全透明。但真实用户交上来的多半是**手机翻拍/扫描的照片**：
 *  · 整张图没有真正的透明像素，纸面是接近白但大于 245 的灰白，还带光照渐变；
 *  · alpha 通道要么全是 255，要么被某些「抠图」工具写成整片 50% 左右。
 *
 * 对这一类图，硬阈值几乎不起作用：半透明的墨色直接盖在合同上，
 * 下面的字会**透过来**，看起来就是「重影」。正确的做法是不要相信源图的 alpha，
 * 而是**按颜色反推墨量**：
 *
 *   d   = 该像素颜色到「纸色」的距离
 *   D   = 墨色到纸色的距离
 *   f   = D × paperNoise                           ← 死区，见下
 *   α   = d ≤ f ? 0 : clamp(d / D, 0, 1)           ← 新 alpha = 墨的覆盖率
 *   S   = paper + (c − paper) / α                  ← 反预乘，还原纯墨色
 *
 * 死区是必要的：翻拍照片的纸面有光照渐变与压缩噪声，离「平均纸色」总有
 * 百分之几的色差。不设死区的话这些像素会拿到 2%~5% 的 alpha，整张纸变成
 * 一层极淡的纱——本身就是轻度的「鬼影」。
 *
 * 注意死区只做「归零」，**不能**把剩下的区间重新拉伸到 0~1：那样低覆盖率的
 * 软边会被放大，反解出的颜色冲出 0~255 被截断，边缘反而变淡（往返等式破坏）。
 * 保持 α = d/D 不变，α·S + (1−α)·paper ≡ c 就始终成立。
 *
 * 这样合成回白纸时 α·S + (1−α)·paper ≡ c，即**与原照片在视觉上等价**：
 * 纸的地方全透明，墨的地方实心，半覆盖的边缘保持原有柔和度。
 * tests/sealPixels.test.ts 里就是这个往返等式在做断言。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface SealPalette {
  /** 纸（背景）色 */
  paper: Rgb;
  /** 墨色参考值 */
  ink: Rgb;
  /** 纸色到墨色的距离，作为归一化分母 */
  inkDistance: number;
}

/** 低于此比例的全透明像素 ⇒ 认为源图没有可用的 alpha 通道（照片/扫描件）。 */
export const REAL_ALPHA_RATIO = 0.02;

const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;

const luma = (r: number, g: number, b: number) =>
  (LUMA_R * r + LUMA_G * g + LUMA_B * b) | 0;

const dist = (r: number, g: number, b: number, c: Rgb) =>
  Math.sqrt((r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2);

/** 直方图分位：避免为了取分位数而给上千万像素排序。 */
function percentile(hist: Uint32Array, total: number, q: number): number {
  const target = total * q;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return hist.length - 1;
}

/** 源图是否真的带 alpha 通道（有足量的全透明像素）。 */
export function hasRealAlpha(data: Uint8ClampedArray, minRatio = REAL_ALPHA_RATIO): boolean {
  let transparent = 0;
  let total = 0;
  for (let i = 3; i < data.length; i += 4) {
    total++;
    if (data[i] === 0) transparent++;
  }
  return total > 0 && transparent / total >= minRatio;
}

/**
 * 估计纸色与墨色。
 * 纸色 = 亮度 82%~92% 分位那一带的均值（避开高光噪点）；
 * 墨色 = 离纸色最远的前 1% 像素的均值。
 */
export function estimatePalette(data: Uint8ClampedArray): SealPalette {
  const lumaHist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    lumaHist[luma(data[i], data[i + 1], data[i + 2])]++;
    n++;
  }
  if (n === 0) {
    return { paper: { r: 255, g: 255, b: 255 }, ink: { r: 0, g: 0, b: 0 }, inkDistance: 0 };
  }

  const bandLo = percentile(lumaHist, n, 0.82);
  const bandHi = percentile(lumaHist, n, 0.92);

  let pr = 0;
  let pg = 0;
  let pb = 0;
  let pn = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const l = luma(data[i], data[i + 1], data[i + 2]);
    if (l >= bandLo && l <= bandHi) {
      pr += data[i];
      pg += data[i + 1];
      pb += data[i + 2];
      pn++;
    }
  }
  const paper: Rgb = pn > 0
    ? { r: pr / pn, g: pg / pn, b: pb / pn }
    : { r: 255, g: 255, b: 255 };

  const distHist = new Uint32Array(512);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const d = dist(data[i], data[i + 1], data[i + 2], paper);
    distHist[Math.min(511, d | 0)]++;
  }
  const farCut = percentile(distHist, n, 0.99);

  let ir = 0;
  let ig = 0;
  let ib = 0;
  let inN = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    if (dist(data[i], data[i + 1], data[i + 2], paper) >= farCut) {
      ir += data[i];
      ig += data[i + 1];
      ib += data[i + 2];
      inN++;
    }
  }
  const ink: Rgb = inN > 0 ? { r: ir / inN, g: ig / inN, b: ib / inN } : paper;

  return { paper, ink, inkDistance: dist(ink.r, ink.g, ink.b, paper) };
}

/**
 * 照片/扫描件路线：按颜色反推墨量作为新 alpha，并反预乘还原纯墨色（原地改写）。
 *
 * @returns 是否可用；墨迹过淡（几乎全是纸）时返回 false，交由调用方走别的路。
 */
export function removePaperBackground(
  data: Uint8ClampedArray,
  palette: SealPalette,
  minInk = 0.004,
  paperNoise = 0.06,
): boolean {
  // 距离太小说明这张图根本没有墨（纯白纸、纯色块），别硬做
  if (palette.inkDistance < 24) return false;
  // 纸必须是亮的。若「背景色」本身就暗（比如一张几乎不透光的深色章），
  // 那就不是翻拍纸底的场景，交回透明 PNG 那条路，行为可预期。
  if (luma(palette.paper.r, palette.paper.g, palette.paper.b) < 180) return false;

  const floor = palette.inkDistance * paperNoise;

  let inked = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const dd = dist(r, g, b, palette.paper);
    const a = dd <= floor ? 0 : Math.min(1, dd / palette.inkDistance);
    if (a <= minInk) {
      data[i + 3] = 0;
      continue;
    }
    // 反预乘：c = α·S + (1−α)·paper  ⇒  S = paper + (c − paper)/α
    data[i] = palette.paper.r + (r - palette.paper.r) / a;
    data[i + 1] = palette.paper.g + (g - palette.paper.g) / a;
    data[i + 2] = palette.paper.b + (b - palette.paper.b) / a;
    data[i + 3] = Math.round(a * 255);
    inked++;
  }
  return inked > 0;
}

/**
 * 透明 PNG 路线：把「alpha>0 但 RGB≈白」的像素置为全透明（去白边）。
 * @returns 被去掉的像素占非透明像素的比例
 */
export function removeWhiteFringe(data: Uint8ClampedArray, threshold = 245): number {
  let opaque = 0;
  let fringe = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    opaque++;
    if (data[i] >= threshold && data[i + 1] >= threshold && data[i + 2] >= threshold) {
      data[i + 3] = 0;
      fringe++;
    }
  }
  return opaque > 0 ? fringe / opaque : 0;
}

/**
 * 把「全透明」像素的颜色漂白（默认白）。返回被改动的像素数。
 *
 * 存在的理由是一个**渲染器兼容性**问题，不是审美问题：透明 PNG 的透明区
 * 通常留着 (0,0,0) 纯黑，这块颜色会被原样嵌进导出的 PDF（透明度走 /SMask）。
 * 规范渲染器按软掩膜合成、颜色根本不参与，看起来毫无问题；但**忽略 /SMask
 * 的渲染器会把它当实色画出来**——于是印章周围多出一个黑色方块，
 * 用户看到的就是「导出后章有个黑框」，而预览（pdf.js）一切正常。
 *
 * 漂白之后：合规渲染器完全不受影响（α=0 的颜色本就不可见），
 * 不合规的渲染器画出白底，落在白纸上等于看不见。
 *
 * 只动 α===0 的像素。α∈(1,254) 的软边颜色是**未预乘**的真实墨色，
 * 改它会破坏边缘。
 */
export function bleachTransparent(
  data: Uint8ClampedArray,
  r = 255,
  g = 255,
  b = 255,
): number {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 0) continue;
    if (data[i] === r && data[i + 1] === g && data[i + 2] === b) continue;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    n++;
  }
  return n;
}

/**
 * 两枚印章的墨迹是不是同一份（去重用）。
 *
 * 逐像素比 alpha，并且在 alpha>0 处比颜色；**唯独放行全透明像素的颜色差异**。
 * 这正是「同一张图被两种编码器写过」的样子：canvas 按预乘 alpha 存像素，
 * 透明区一律写成 (0,0,0)；自写编码器把它刷成白（见 bleachTransparent）。
 * 两份字节在视觉上完全一致（透明区看不见），却会让印章库里多出一条同名条目。
 *
 * 比较对象必须来自同一条解码路径（decodeSealPixels），否则预乘往返的
 * 舍入会让「相同」的像素差 1~2 个数——那不叫重复，也不该被合并。
 */
export function sameInkPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] !== b[i + 3]) return false;
    if (a[i + 3] === 0) continue;
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) return false;
  }
  return true;
}

/** alpha>0 像素的包围盒（含 padding）。整张图全透明时返回 null。 */
export function inkBounds(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  padding = 2,
): { x: number; y: number; w: number; h: number } | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(row + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);
  return {
    x,
    y,
    w: Math.min(w, maxX + 1 + padding) - x,
    h: Math.min(h, maxY + 1 + padding) - y,
  };
}
