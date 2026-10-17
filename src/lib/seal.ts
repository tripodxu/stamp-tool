import type { SealImage } from './types';
import { DPI_WARN, effectiveDpi } from './units';
import {
  estimatePalette,
  hasRealAlpha,
  inkBounds,
  removePaperBackground,
  removeWhiteFringe,
} from './sealPixels';

/**
 * 印章图像预处理（负责 canvas 与文件 IO，像素算法都在 sealPixels.ts）。
 *
 * 背景两个必须解决的问题：
 *
 * 1) 白边。Photoshop 导出的「透明 PNG」实为「未预乘 alpha + 白底」，
 *    盖在有色内容上会出现白色毛边。判据是「alpha>0 但 RGB≈255」的像素——
 *    真正的印章墨迹不会是纯白。
 *
 * 2) 画布留白。透明 PNG 常带一圈空白，裁掉后既能贴合视觉边界，
 *    也能让「40mm」这个尺寸参数真正对应印章直径而非画布边长。
 *
 * 3) 【后补】**翻拍照片**。用户交上来的常常不是透明 PNG，而是手机拍的：
 *    整张图没有真正的透明像素，或者 alpha 被抠图工具写成整片半透明。
 *    这时绝不能相信源 alpha——半透明的墨会让合同上的字透上来，
 *    看起来就是「重影」。改走 sealPixels.removePaperBackground()：
 *    按颜色反推墨量当 alpha，并把颜色反预乘回实心墨色。
 */

export interface SealProcessOptions {
  /** 去白边的 RGB 阈值 */
  fringeThreshold?: number;
  /** 裁剪时保留的边距（像素） */
  padding?: number;
}

const DEFAULT_OPTS: Required<SealProcessOptions> = {
  fringeThreshold: 245,
  padding: 2,
};

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('印章图片解码失败'));
    img.src = url;
  });

const toPngBytes = (canvas: HTMLCanvasElement) =>
  new Promise<Uint8Array>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('PNG 编码失败'));
      blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject);
    }, 'image/png');
  });

export interface SealProcessResult {
  canvas: HTMLCanvasElement;
  cropW: number;
  cropH: number;
  /** 被去掉的白边像素占非透明像素的比例 */
  fringeRatio: number;
  trimmed: boolean;
  /** 走的是哪条路线：尊重源 alpha，还是按纸色反推墨量 */
  bgMode: 'alpha' | 'paper';
}

/** 像素级处理，返回裁剪后的 canvas 与诊断信息。 */
export function processSealPixels(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  opts: SealProcessOptions = {},
): SealProcessResult {
  const { fringeThreshold, padding } = { ...DEFAULT_OPTS, ...opts };

  const full = document.createElement('canvas');
  full.width = srcW;
  full.height = srcH;
  const fctx = full.getContext('2d', { willReadFrequently: true });
  if (!fctx) throw new Error('无法创建 2D 绘图上下文');
  fctx.drawImage(source, 0, 0, srcW, srcH);

  const img = fctx.getImageData(0, 0, srcW, srcH);
  const d = img.data;

  let bgMode: 'alpha' | 'paper' = 'alpha';
  let fringeRatio = 0;
  if (hasRealAlpha(d)) {
    // 规范透明底：尊重它自己的 alpha，只清掉白色毛边
    fringeRatio = removeWhiteFringe(d, fringeThreshold);
  } else {
    // 翻拍/扫描件：不信 alpha，按「离纸色多远」反推墨量
    bgMode = 'paper';
    if (!removePaperBackground(d, estimatePalette(d))) {
      // 几乎没有墨迹（纯白纸/纯色块）——退回老路线，行为可预期
      bgMode = 'alpha';
      fringeRatio = removeWhiteFringe(d, fringeThreshold);
    }
  }
  fctx.putImageData(img, 0, 0);

  const bounds = inkBounds(d, srcW, srcH, padding);

  // 整张图都是白边 → 图像不透明，退回原图由用户自行处理
  if (!bounds) {
    return {
      canvas: full,
      cropW: srcW,
      cropH: srcH,
      fringeRatio: bgMode === 'paper' ? 0 : 1,
      trimmed: false,
      bgMode,
    };
  }

  const { x, y, w, h } = bounds;
  const trimmed = !(x === 0 && y === 0 && w === srcW && h === srcH);
  if (!trimmed) {
    return { canvas: full, cropW: srcW, cropH: srcH, fringeRatio, trimmed: false, bgMode };
  }

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  if (!octx) throw new Error('无法创建 2D 绘图上下文');
  octx.drawImage(full, x, y, w, h, 0, 0, w, h);

  return { canvas: out, cropW: w, cropH: h, fringeRatio, trimmed, bgMode };
}

/** 读取文件 → 预处理 → 得到可直接用于预览与嵌入的印章。 */
export async function loadSealFile(
  file: File,
  opts?: SealProcessOptions,
): Promise<SealImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('请选择图片文件（PNG 透明底效果最佳）');
  }

  const rawUrl = URL.createObjectURL(file);
  let img: HTMLImageElement;
  try {
    img = await loadImage(rawUrl);
  } catch (e) {
    URL.revokeObjectURL(rawUrl);
    throw e;
  }

  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  if (!srcW || !srcH) throw new Error('印章图片尺寸无效');

  const { canvas, cropW, cropH, fringeRatio, trimmed, bgMode } = processSealPixels(
    img, srcW, srcH, opts,
  );
  URL.revokeObjectURL(rawUrl);

  const pngBytes = await toPngBytes(canvas);
  const objectUrl = URL.createObjectURL(
    new Blob([pngBytes as BlobPart], { type: 'image/png' }),
  );

  return {
    name: file.name,
    pngBytes,
    objectUrl,
    srcW,
    srcH,
    cropW,
    cropH,
    aspect: cropW / cropH,
    fringeRatio,
    hadFringe: fringeRatio > 0.005,
    trimmed,
    dpiScale: srcW / cropW,
    bgMode,
  };
}

export interface SealQuality {
  level: 'good' | 'warn' | 'bad';
  text: string;
}

/**
 * 分辨率体检。
 *
 * 收的是**像素宽度**而不是 SealImage：印章可以换，旧章仍然用旧图，
 * 若拿「当前加载的章」的像素数去算，报出来的 DPI 是另一枚章的。
 * 印章直径对应的是裁剪后的墨迹宽度 cropW，所以调用方传 stamp.cropW。
 */
export function assessSealQuality(cropW: number, widthMm: number): SealQuality {
  const dpi = effectiveDpi(cropW, widthMm);
  if (dpi >= DPI_WARN) {
    return { level: 'good', text: `有效分辨率约 ${Math.round(dpi)} DPI，印刷清晰` };
  }
  if (dpi >= DPI_WARN * 0.6) {
    return {
      level: 'warn',
      text: `有效分辨率约 ${Math.round(dpi)} DPI，屏幕够用，印刷可能发糊（建议 ≥ ${DPI_WARN}）`,
    };
  }
  return {
    level: 'bad',
    text: `有效分辨率约 ${Math.round(dpi)} DPI，印出来会明显模糊，请换更高分辨率的印章图`,
  };
}
