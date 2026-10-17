/**
 * 印章 PNG 的 objectURL 缓存。
 *
 * 早期实现是 WeakMap：只创建从不释放，反复换印章 / 多枚同图章时 Blob 会持续
 * 堆积，而且 WeakMap 没法遍历、无法回收。改成普通 Map（键是字节数组的引用，
 * 一枚章一条），换来一个能统一 revokeAll 的能力——
 * 换印章、重置文档、组件卸载时都调一次。
 */
const cache = new Map<Uint8Array, string>();

export function pngObjectUrl(bytes: Uint8Array): string {
  let url = cache.get(bytes);
  if (!url) {
    url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
    cache.set(bytes, url);
  }
  return url;
}

export function revokePngUrl(bytes: Uint8Array): void {
  const url = cache.get(bytes);
  if (!url) return;
  URL.revokeObjectURL(url);
  cache.delete(bytes);
}

export function revokeAllPngUrls(): void {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
}
