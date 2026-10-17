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

export interface SaveAsWritable {
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
