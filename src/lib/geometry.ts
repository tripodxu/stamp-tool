import type { PageInfo, SealDefaults, Stamp } from './types';
import { mmToPt, STANDARD_SEAL_MM } from './units';

/**
 * 本文件只放**几何决策**（摆哪儿、多大），不放坐标变换。
 *
 * 曾经这里还有 stampCenter / stampTransform / hitTest / snapToGrid 四个导出，
 * 没有任何调用方——而其中 stampCenter 的 cy 少写了一个 `/2`，白躺了很久。
 * 死代码不会报错，只会等着在接入点选/吸附时变成极难排查的「总是差一点」。
 * 要用再加回来，别提前屯着。
 */

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/**
 * 一键摆放预设。
 *
 * 骑缝分左右：章要压在**装订边**那一侧。中文合同多数左侧装订，
 * 但也有右侧装订（右翻本、部分港澳台合同），所以两个方向都给。
 */
export type StampPreset =
  | 'signature'
  | 'rightBottom'
  | 'bindingEdgeLeft'
  | 'bindingEdgeRight';

export const PRESET_LABELS: Record<StampPreset, string> = {
  signature: '落款处',
  rightBottom: '右下角',
  bindingEdgeLeft: '骑缝（左）',
  bindingEdgeRight: '骑缝（右）',
};

const MARGIN = mmToPt(12);

/**
 * 预设位置的返回值一律是**左上角**坐标（与 Stamp.xPt/yPt 同一定义，
 * 即显示坐标：原点在页面左上角、y 向下；导出时才按该页 /Rotate 换算）。
 *
 * 「骑缝（左/右）」刻意让章心压在页面左/右边缘（xPt + w/2 = 0 或 page.wPt）：
 * 它按相对页边的量计算，多页之间天然对齐——这正是骑缝章的技术要求。
 * 一半在页外是有意为之：装订后两半才对得上（导出时也照原样写进 PDF）。
 * 纵向：章顶落在页面高度的 28% 处（自页顶算），左右两枚完全一致。
 */
export function presetPatch(
  s: Pick<Stamp, 'widthPt' | 'heightPt'>,
  page: PageInfo,
  kind: StampPreset,
): Pick<Stamp, 'xPt' | 'yPt' | 'rotationDeg'> {
  switch (kind) {
    case 'rightBottom':
      return {
        xPt: page.wPt - s.widthPt - MARGIN,
        yPt: page.hPt - s.heightPt - MARGIN,
        rotationDeg: -8,
      };
    case 'bindingEdgeLeft':
      return {
        xPt: -s.widthPt / 2,
        yPt: page.hPt * 0.28,
        rotationDeg: 0,
      };
    case 'bindingEdgeRight':
      return {
        xPt: page.wPt - s.widthPt / 2,
        yPt: page.hPt * 0.28,
        rotationDeg: 0,
      };
    case 'signature':
    default:
      return {
        xPt: mmToPt(30),
        yPt: page.hPt - s.heightPt - mmToPt(35),
        rotationDeg: -8,
      };
  }
}

/**
 * 新章的默认浓度。
 *
 *  · 透明底 PNG：0.85。干净的数字章按 85% 盖下去更像真印油，不会死板。
 *  · 翻拍/扫描件：1。照片本身已经带上了真实印迹的浓淡（笔画内部覆盖率
 *    实测约 0.93），再乘 0.85 只会让合同上的字从墨里透上来——用户看到
 *    的就是「重影」。这类图必须原样落地。
 */
export function defaultOpacity(bgMode: 'alpha' | 'paper'): number {
  return bgMode === 'paper' ? 1 : 0.85;
}

/** 新章的默认角度：真实盖章很少是正的。 */
export const DEFAULT_ROTATION_DEG = -8;

/**
 * 一枚新章的默认参数。
 *
 * 三样一起给（而不是各写各的），是为了让「换一枚章」= 「换一整套参数」：
 * 直径回到 40mm、角度回到 −8°、浓度按这枚章自己的去背路线定
 * （翻拍件必须是 1，见 defaultOpacity）。
 */
export function defaultSealDefaults(bgMode: 'alpha' | 'paper'): SealDefaults {
  return {
    widthMm: STANDARD_SEAL_MM,
    rotationDeg: DEFAULT_ROTATION_DEG,
    opacity: defaultOpacity(bgMode),
  };
}

/**
 * 把一枚章夹进页面里：允许出血，但至少保留四分之一在页内，
 * 免得章被拖丢/复制到别页后彻底找不回来。
 *
 * 三个调用方共用这一条规则（画布拖拽、跨页复制、批量盖章）——
 * 批量时每份文件的页面尺寸都可能不同，照搬画布上的坐标就会整个掉出页面。
 */
export function clampPlacement(
  s: Pick<Stamp, 'xPt' | 'yPt' | 'widthPt' | 'heightPt'>,
  page: { wPt: number; hPt: number },
): Pick<Stamp, 'xPt' | 'yPt'> {
  return {
    xPt: clamp(s.xPt, -s.widthPt * 0.75, page.wPt - s.widthPt * 0.25),
    yPt: clamp(s.yPt, -s.heightPt * 0.75, page.hPt - s.heightPt * 0.25),
  };
}

/** 新章的默认位置：页面中下方，略带倾斜（实际盖章通常不是正的）。 */
export function defaultPlacement(
  size: { widthPt: number; heightPt: number },
  page: PageInfo,
): Pick<Stamp, 'xPt' | 'yPt'> {
  return {
    xPt: Math.max(0, (page.wPt - size.widthPt) / 2),
    yPt: Math.max(0, page.hPt * 0.72 - size.heightPt / 2),
  };
}
