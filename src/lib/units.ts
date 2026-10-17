/**
 * 单位与坐标换算 —— 全项目唯一真源。
 *
 * PDF 用户空间：1 pt = 1/72 inch = 25.4/72 mm。
 *
 * 本项目存储的坐标一律是**显示空间**：相对「预览里那张纸」的左上角、y 轴向下，
 * 也就是 pdf.js 的 getViewport() 那套（已应用 /Rotate、以裁切框为界）。
 * 它与 PDF 用户空间之间差着旋转与裁切偏移，换算统一在 pageSpace.ts 里做，
 * 别在业务代码里手写。
 */

export const PT_PER_MM = 72 / 25.4;
export const MM_PER_PT = 25.4 / 72;

export const mmToPt = (mm: number): number => mm * PT_PER_MM;
export const ptToMm = (pt: number): number => pt * MM_PER_PT;

/** 法定常见公章直径 */
export const STANDARD_SEAL_MM = 40;

/**
 * 印章图像在给定物理尺寸下的有效 DPI。
 * 用于上传时的「分辨率体检」——低于 300 打印会糊。
 */
export const effectiveDpi = (pixelWidth: number, widthMm: number): number =>
  pixelWidth / (widthMm / 25.4);

/** 低于此 DPI 给出提示 */
export const DPI_WARN = 300;

/*
 * 屏幕像素 ↔ pt 的换算就是「除以/乘以 zoom」，一行的事，且只在拖拽里用到，
 * 因此不再单独导出工具函数（曾经导出过 pxToPt / ptToPx，全项目零调用）。
 * 记住一点：devicePixelRatio 只影响 canvas 的像素密度，不进入任何逻辑坐标。
 */