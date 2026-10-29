/**
 * 「另存为」——用环境自带的文件选择器把字节写到用户挑的位置。
 *
 * 为什么不用 Tauri 的对话框插件：`src-tauri/Cargo.toml` 刻意不引入任何 Tauri 插件
 * （二进制体积），而 WebView2 本身就实现了 File System Access API——真机实测
 * `typeof window.showSaveFilePicker === 'function'`（`isSecureContext` 为 true）。
 *
 * 三种结果必须区分清楚，调用方才知道该回退还是该沉默：
 *   saved       用户选好位置并写入成功
 *   cancelled   用户在对话框里点了取消——不是错误，不该弹提示
 *   unsupported 环境不支持，或这次调用没拿到用户手势（自动化脚本的合成点击）
 *               ——调用方应回退到普通下载
 */

export type SaveAsResult =
  | { status: 'saved'; name: string }
  | { status: 'cancelled' }
  | { status: 'unsupported' };

/**
 * 手机导出的主路径：系统分享面板（存到「文件」/发微信/存网盘）。
 *
 * 为什么手机不能走浏览器下载：Android WebView 没有 DownloadListener，
 * `<a download>` 点了静默无反应——「导出没反应」比任何 bug 都伤信任。
 * Web Share API（带文件）在 Chromium WebView 可用性因版本而异，
 * 所以运行时探测：能 share 就 share，不能则交回调用方走下载/报错。
 *
 * @returns 'shared' 分享面板已弹出且用户完成分享；
 *           'cancelled' 用户在面板上取消（非错误，别提示）；
 *           'unsupported' 环境不支持（调用方自行回退）
 */
export type ShareResult =
  | { status: 'shared' }
  | { status: 'cancelled' }
  | { status: 'unsupported'; reason?: string };

export function canShareFiles(): boolean {
  return shareProbe().ok;
}

/** 诊断用：拆开三个条件，失败时能看出是哪一环。 */
export function shareProbe(): { ok: boolean; why: string } {
  try {
    const n = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (typeof n.share !== 'function') return { ok: false, why: 'no share fn' };
    if (typeof n.canShare !== 'function') return { ok: false, why: 'no canShare fn' };
    const probe = new File([new Uint8Array([0])], 'x.pdf', { type: 'application/pdf' });
    if (!n.canShare({ files: [probe] })) return { ok: false, why: 'canShare(files)=false' };
    return { ok: true, why: '' };
  } catch (e) {
    return { ok: false, why: `probe threw ${(e as Error)?.name}` };
  }
}

/**
 * 原生分享桥（MainActivity 注入的 window.AndroidShare）。
 *
 * 本机 System WebView 没有 navigator.share（厂商裁剪），导出只能靠它：
 * 字节 base64 过桥 → Kotlin 写 cacheDir → FileProvider → 系统分享面板。
 * 桥不依赖用户手势（原生侧自己 startActivity），异步读取 Blob 也没问题。
 */
interface AndroidShareBridge {
  shareFile(base64: String, fileName: string, mime: string): void;
}

async function androidShare(
  data: Blob | Uint8Array,
  fileName: string,
  mime: string,
): Promise<ShareResult> {
  const bridge = (window as { AndroidShare?: AndroidShareBridge }).AndroidShare;
  if (!bridge) return { status: 'unsupported', reason: 'no web share & no native bridge' };
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
  let binary = '';
  const CHUNK = 0x8000; // btoa 对超长字符串会栈溢出，分块拼
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  try {
    bridge.shareFile(btoa(binary), fileName, mime);
    return { status: 'shared' };
  } catch (e) {
    return { status: 'unsupported', reason: `bridge threw ${(e as Error)?.name}` };
  }
}

/**
 * 直接收 Blob/Uint8Array，**不在 share 前做任何 await**：
 * transient activation 有时间窗，先读字节再 share 会在个别实现里把手势耗掉。
 */
export async function shareFile(
  data: Blob | Uint8Array,
  fileName: string,
  mime: string,
): Promise<ShareResult> {
  const probe = shareProbe();
  if (!probe.ok) return androidShare(data, fileName, mime); // WebView 无 Web Share → 原生桥
  try {
    await navigator.share({ files: [new File([data as BlobPart], fileName, { type: mime })] });
    return { status: 'shared' };
  } catch (e) {
    const err = e as Error;
    return err?.name === 'AbortError'
      ? { status: 'cancelled' }
      : androidShare(data, fileName, mime); // Web Share 现场失败也交给原生桥兜底
  }
}export interface SaveAsWritable {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
}

export interface SaveAsTarget {
  name?: string;
  createWritable(): Promise<SaveAsWritable>;
}

export interface SaveAsType {
  description: string;
  accept: Record<string, string[]>;
}

export type SaveAsPicker = (options: {
  suggestedName: string;
  types: SaveAsType[];
}) => Promise<SaveAsTarget>;

/** 取当前环境的 picker；没有就返回 null（单测里直接注入假的）。 */
export function saveAsPicker(scope: unknown = globalThis): SaveAsPicker | null {
  const fn = (scope as { showSaveFilePicker?: unknown } | null)?.showSaveFilePicker;
  return typeof fn === 'function' ? (fn.bind(scope) as SaveAsPicker) : null;
}

export async function saveBytesAs(
  bytes: Uint8Array,
  suggestedName: string,
  opts: {
    mime: string;
    description: string;
    ext: string;
    /** 显式注入（单测）；不给就用当前环境的 */
    picker?: SaveAsPicker | null;
    scope?: unknown;
  },
): Promise<SaveAsResult> {
  const picker = opts.picker ?? saveAsPicker(opts.scope);
  if (!picker) return { status: 'unsupported' };

  let target: SaveAsTarget;
  try {
    target = await picker({
      suggestedName,
      types: [{ description: opts.description, accept: { [opts.mime]: [opts.ext] } }],
    });
  } catch (e) {
    const name = (e as Error)?.name ?? '';
    if (name === 'AbortError') return { status: 'cancelled' };
    // SecurityError/NotAllowedError：没有用户手势或权限被拒。退回下载，别把错误甩给用户。
    if (name === 'SecurityError' || name === 'NotAllowedError') return { status: 'unsupported' };
    throw e;
  }

  const writable = await target.createWritable();
  await writable.write(new Blob([bytes as BlobPart], { type: opts.mime }));
  await writable.close();
  return { status: 'saved', name: target.name || suggestedName };
}
