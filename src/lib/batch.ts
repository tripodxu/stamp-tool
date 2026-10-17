import type { PageInfo, Stamp } from './types';
import { clampPlacement, presetPatch, type StampPreset } from './geometry';

/**
 * 批量盖章的**规则**（纯函数，无 I/O）。
 *
 * 批量不能沿用画布上的绝对坐标：每份文件的页数、页面尺寸都可能不同。
 * 所以位置只能是「规则」——要么沿用它距页左上角的偏移，要么按预设重算。
 * 页面几何（PageInfo）仍然是唯一的参照系，与单份导出走同一条 stampPlacement。
 */

/**
 * 页码选择。
 *
 *  · pages 空、last 假 → 全部页
 *  · 越界页码**忽略**（批量里各文件页数不同，报错会让整批没法跑）；
 *    「1,5」对一份 3 页的文件就是第 1 页。
 *  · last = 每份文件各自的最后一页（合同盖章最常用的就是这个）
 */
export interface PageSpec {
  pages: number[];
  last: boolean;
}

const LAST_WORDS = ['末页', '最后', '最后页', '最后一页', '尾页', 'last'];
const ALL_WORDS = ['全部', '所有', '每页', 'all'];

/** 解析页码输入。看不懂的写法直接报错，别猜。 */
export function parsePageSpec(spec: string): PageSpec {
  const raw = spec.trim();
  if (!raw) return { pages: [], last: false };
  if (ALL_WORDS.includes(raw.toLowerCase())) return { pages: [], last: false };

  const pages = new Set<number>();
  let last = false;
  for (const token of raw.split(/[,，、;；\s]+/).filter(Boolean)) {
    const t = token.toLowerCase();
    if (LAST_WORDS.includes(t)) {
      last = true;
      continue;
    }
    if (ALL_WORDS.includes(t)) {
      throw new Error('「全部」要单独写，不能和具体页码混在一起（留空就是全部页）');
    }
    const m = /^(\d+)(?:\s*[-–—~～至到]\s*(\d+))?$/.exec(token);
    if (!m) {
      throw new Error(`页码「${token}」看不懂。可以写 1,3,5-8，或者「末页」；留空表示全部页`);
    }
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < 1) throw new Error('页码从 1 开始');
    if (a > 100000 || b > 100000) throw new Error('页码太大了');
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) pages.add(p);
  }
  return { pages: [...pages].sort((x, y) => x - y), last };
}

/** 落到某一份具体文件上：返回 0 基页号（升序）。 */
export function pageIndices(spec: PageSpec, total: number): number[] {
  const out = new Set<number>();
  if (spec.pages.length === 0 && !spec.last) {
    for (let i = 0; i < total; i++) out.add(i);
    return [...out];
  }
  for (const p of spec.pages) {
    if (p >= 1 && p <= total) out.add(p - 1);
  }
  if (spec.last && total > 0) out.add(total - 1);
  return [...out].sort((a, b) => a - b);
}

/** 位置模式：沿用画布上的偏移，或者按预设重算。 */
export type BatchPlacement =
  | { mode: 'offset' }
  | { mode: 'preset'; preset: StampPreset };

/** 一枚章的「规格」：尺寸、角度、浓度、图像。批量时每份文件都用这一份。 */
export interface BatchSeed {
  pngBytes: Uint8Array;
  widthPt: number;
  heightPt: number;
  rotationDeg: number;
  opacity: number;
  aspect: number;
  cropW: number;
}

export interface BatchPlan {
  seed: BatchSeed;
  /** 画布上那枚章的位置（offset 模式的基准；显示空间左上角，pt） */
  origin: { xPt: number; yPt: number };
  placement: BatchPlacement;
  pages: PageInfo[];
  selector: PageSpec;
  /** 印章 id 前缀（每个文件一组，互不冲突） */
  idPrefix: string;
}

/**
 * 给一份文件的选定页生成印章列表。
 *
 * 预设模式连角度一起重算（与画布上点预设的行为一致）；偏移模式保留画布上的角度。
 * 两种模式最后都过 clampPlacement——页面尺寸不同，照搬就可能整个掉出页面。
 */
export function batchStamps(plan: BatchPlan): Stamp[] {
  const out: Stamp[] = [];
  for (const pageIndex of pageIndices(plan.selector, plan.pages.length)) {
    const page = plan.pages[pageIndex];
    const spot =
      plan.placement.mode === 'preset'
        ? presetPatch(plan.seed, page, plan.placement.preset)
        : { xPt: plan.origin.xPt, yPt: plan.origin.yPt, rotationDeg: plan.seed.rotationDeg };
    out.push({
      id: `${plan.idPrefix}-${pageIndex + 1}`,
      pageIndex,
      ...plan.seed,
      rotationDeg: spot.rotationDeg,
      ...clampPlacement(
        { xPt: spot.xPt, yPt: spot.yPt, widthPt: plan.seed.widthPt, heightPt: plan.seed.heightPt },
        page,
      ),
    });
  }
  return out;
}

/** 批量输出的文件名：<原名>-已盖章.pdf（同名去重交给 zip.ts）。 */
export function stampedName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${base}-已盖章.pdf`;
}

/** 同一份文件的判据（拖放与「选择 PDF」去重共用）。 */
export function fileKey(f: { name: string; size: number; lastModified: number }): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

export function isPdfFile(f: File): boolean {
  return f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
}

/**
 * 挑出还没进过列表的 PDF（按 fileKey 去重，保持传入顺序）。
 *
 * 拖进来的东西往往很杂（截图、录音、文件夹里的各种文件），
 * 不合格的静默丢掉，不要为它们弹错误。
 */
export function pickNewPdfs(existing: Iterable<string>, incoming: File[]): File[] {
  const seen = new Set(existing);
  const out: File[] = [];
  for (const f of incoming) {
    if (!isPdfFile(f)) continue;
    const key = fileKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** 批量压缩包的默认名字。 */
export function zipName(count: number, when = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())} ${p(when.getHours())}${p(when.getMinutes())}`;
  return `已盖章 ${count} 份 ${stamp}.zip`;
}
