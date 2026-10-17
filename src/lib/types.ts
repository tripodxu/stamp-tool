/** 一枚印章。坐标系见 units.ts 与 pageSpace.ts。 */
export interface Stamp {
  id: string;
  pageIndex: number;
  /** 原始 PNG 字节，导出时无损嵌入 */
  pngBytes: Uint8Array;
  /** 相对**显示空间**（预览看到的那张纸）左上角，单位 pt */
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  /** 顺时针为正，显示空间 */
  rotationDeg: number;
  opacity: number;
  /**
   * 这枚章**自己**的墨迹像素长宽比。
   *
   * 必须挂在章上，不能只存在 SealImage 里：换过印章之后，旧章仍在使用旧图，
   * 此时若宽高比取「当前加载的章」，拖一次直径滑杆就会把圆章拉成椭圆
   * （实测 40mm 圆章 → 39.8 × 53.2mm），而且预览里看不出问题。
   */
  aspect: number;
  /** 墨迹像素宽度，用于分辨率体检（同样必须按章存） */
  cropW: number;
}

/**
 * 页面的几何参照。
 *
 * ⚠️ 必须来自 pdf.js（预览层），不要用 pdf-lib 的 getSize()：
 * 前者应用了 /Rotate 且以裁切框为界，后者只认 MediaBox 且不认旋转。
 */
export interface PageFrame {
  /** 用户空间裁切框 [x0, y0, x1, y1]，即 pdf.js 的 page.view */
  view: [number, number, number, number];
  /** 页面 /Rotate，顺时针为正，恒为 90 的倍数 */
  rotation: number;
  /** PDF 的 /UserUnit，通常为 1 */
  userUnit: number;
}

export interface PageInfo extends PageFrame {
  /** 显示空间尺寸（预览里那张纸的宽高，pt） */
  wPt: number;
  hPt: number;
}

/** 处理后的印章图像：已去白边、已裁剪到墨迹边界。 */
export interface SealImage {
  name: string;
  pngBytes: Uint8Array;
  objectUrl: string;
  /** 原始像素尺寸（用户上传时） */
  srcW: number;
  srcH: number;
  /** 去边裁剪后的像素尺寸（导出实际使用） */
  cropW: number;
  cropH: number;
  aspect: number;
  /** 原始像素数中「alpha>0 但 RGB≈255」的占比，0..1 */
  fringeRatio: number;
  dpiScale: number;
  hadFringe: boolean;
  trimmed: boolean;
  /**
   * 走的是哪条去背路线：
   *  · 'alpha' —— 源图带真透明通道，尊重它自己的 alpha（只清白色毛边）
   *  · 'paper' —— 翻拍/扫描件：源 alpha 不可信，按纸色反推墨量
   */
  bgMode: 'alpha' | 'paper';
}
