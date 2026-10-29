import type { PageFrame, Stamp } from './types';

/**
 * 显示空间 ↔ PDF 用户空间。
 *
 * 为什么必须有这一层：**预览与导出看的不是同一个坐标系**。
 *   · 预览：pdf.js 的 getViewport()，应用了页面 /Rotate，并以**裁切框**为界
 *   · 导出：pdf-lib 的 drawImage，直接写用户空间，不认识 /Rotate
 *
 * /Rotate ≠ 0 的 PDF（扫描件极常见：扫描仪出图方向固定，靠 /Rotate 摆正）
 * 或 CropBox ≠ MediaBox 时，两边就差一个旋转/偏移。栅格化后实测印迹：
 *   /Rotate 90 + 居中        → 偏 43.4mm
 *   /Rotate 90 + 右下角预设  → 印迹整个掉到可见页面之外（完全消失）
 *   CropBox 四周内缩 20pt    → 恒定偏 7.2mm
 * 而预览始终正常，用户要打开导出文件才会发现。
 *
 * 映射由 pdf.js 的 PageViewport.transform 反解而来（scale = 1、无 canvas offset）：
 *   R=0    x_d = u − x0        y_d = y1 − v
 *   R=90   x_d = v − y0        y_d = u − x0
 *   R=180  x_d = x1 − u        y_d = v − y0
 *   R=270  x_d = y1 − v        y_d = x1 − u
 * 取逆即下式。tests/pageSpace.test.ts 用 pdf.js 自己的 convertToPdfPoint()
 * 对四种旋转逐点比对，防止手写公式悄悄错掉。
 */

export function normalizeRotation(deg: number): 0 | 90 | 180 | 270 {
  const r = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/** 显示空间点（左上原点、y 向下、pt）→ 用户空间点（左下原点、y 向上）。 */
export function displayToUser(
  frame: PageFrame,
  dx: number,
  dy: number,
): { u: number; v: number } {
  const [x0, y0, x1, y1] = frame.view;
  const s = frame.userUnit || 1;
  const sx = dx / s;
  const sy = dy / s;
  switch (normalizeRotation(frame.rotation)) {
    case 90:
      return { u: x0 + sy, v: y0 + sx };
    case 180:
      return { u: x1 - sx, v: y0 + sy };
    case 270:
      return { u: x1 - sy, v: y1 - sx };
    default:
      return { u: x0 + sx, v: y1 - sy };
  }
}

/** 显示空间尺寸（pt）。 */
export function displaySize(frame: PageFrame): { wPt: number; hPt: number } {
  const [x0, y0, x1, y1] = frame.view;
  const s = frame.userUnit || 1;
  const w = (x1 - x0) * s;
  const h = (y1 - y0) * s;
  return normalizeRotation(frame.rotation) % 180 === 0
    ? { wPt: w, hPt: h }
    : { wPt: h, hPt: w };
}

/**
 * 印章在用户空间的绘制参数，供 pdf-lib 的 drawImage 使用。
 *
 * 两个易错点：
 *
 * 1) **旋转轴**。pdf-lib 的 drawImage 展开为 translate → rotate → scale → Do，
 *    旋转轴是图像**左下角**而非中心。必须反解 pivot，让旋转后的中心落在目标点上，
 *    否则 8° 漂 2.8mm、45° 漂 7mm——用户只会觉得「总是差一点」。
 *      center = pivot + R(α)·(w/2, h/2)  →  pivot = center − R(α)·(w/2, h/2)
 *
 * 2) **角度**。显示空间顺时针为正、用户空间逆时针为正，而页面自身还可能带 /Rotate：
 *    正确的用户空间角 = 页面旋转 − 印章倾角。（R=0 时退化为 −rotationDeg。）
 */
export function stampPlacement(
  stamp: Pick<Stamp, 'xPt' | 'yPt' | 'widthPt' | 'heightPt' | 'rotationDeg'>,
  frame: PageFrame,
): { x: number; y: number; rotationDeg: number } {
  const rot = normalizeRotation(frame.rotation);
  const { u, v } = displayToUser(
    frame,
    stamp.xPt + stamp.widthPt / 2,
    stamp.yPt + stamp.heightPt / 2,
  );
  const alphaDeg = rot - stamp.rotationDeg;
  const a = (alphaDeg * Math.PI) / 180;
  const hw = stamp.widthPt / 2;
  const hh = stamp.heightPt / 2;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return {
    x: u - (hw * cos - hh * sin),
    y: v - (hw * sin + hh * cos),
    rotationDeg: alphaDeg,
  };
}

/**
 * 从 pdf-lib 的页面对象兜底构造帧（只有导出层被单独调用时才走这里）。
 *
 * 局限：pdf-lib 不暴露 /UserUnit，且 getCropBox() 不含页树继承——真实链路
 * 一律优先用 pdf.js 采到的 PageFrame。
 */
export function frameFromPage(page: {
  getCropBox(): { x: number; y: number; width: number; height: number };
  getRotation(): { angle: number };
}): PageFrame {
  const b = page.getCropBox();
  return {
    view: [b.x, b.y, b.x + b.width, b.y + b.height],
    rotation: page.getRotation().angle,
    userUnit: 1,
  };
}
