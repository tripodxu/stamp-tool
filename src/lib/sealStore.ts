import type { SealImage } from './types';

/**
 * 印章库：把用户导入过的印章留在本地，下次打开直接点选，不用重新导入。
 *
 * 为什么用 IndexedDB 而不是 localStorage：
 *  · localStorage 只能存字符串（二进制要 base64，体积 +33%），而且总量卡在 5MB 左右，
 *    一枚高分辨率印章转 base64 就可能上百 KB，几枚就爆；
 *  · IndexedDB 直接存 Uint8Array/Blob，配额是几百 MB 量级，
 *    并且桌面版（WebView2）与浏览器版行为一致，不需要引入 Tauri 的文件系统插件。
 *
 * 存的是**处理之后**的 PNG（已去背、已裁到墨迹边界）——这正是导出时要嵌入的字节，
 * 再次选用时可以直接用，不必重新跑一遍像素处理。
 */

const DB_NAME = 'stamp-tool';
const DB_VERSION = 1;
const STORE = 'seals';

/** 库里最多留多少枚，超出按「最久没用过」淘汰。 */
export const MAX_SEALS = 30;

export interface SavedSeal {
  /** 内容指纹：同一张图重复导入不会产生第二条 */
  id: string;
  name: string;
  pngBytes: Uint8Array;
  srcW: number;
  srcH: number;
  cropW: number;
  cropH: number;
  aspect: number;
  fringeRatio: number;
  hadFringe: boolean;
  trimmed: boolean;
  dpiScale: number;
  bgMode: 'alpha' | 'paper';
  savedAt: number;
  lastUsedAt: number;
}

/** 内容指纹（FNV-1a + 长度）。印章库只有几十条，碰撞概率可忽略。 */
export function contentKey(bytes: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return `${bytes.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

/** 最近**用过**的排前面：给「启动时自动选中」和淘汰策略用。 */
export const sortSeals = (list: SavedSeal[]): SavedSeal[] =>
  [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt);

/**
 * 界面里的展示顺序：最近**导入**的排前面。
 *
 * 与 sortSeals 分开是刻意的——如果按「最近使用」排，用户点一下第 3 枚，
 * 它立刻跳到第 1 位，光标底下的行会跑掉。展示顺序要稳。
 */
export const sortForDisplay = (list: SavedSeal[]): SavedSeal[] =>
  [...list].sort((a, b) => b.savedAt - a.savedAt || b.lastUsedAt - a.lastUsedAt);

/** 超出上限时该淘汰哪些（最久没用过的）。 */
export function pickEvictions(list: SavedSeal[], max = MAX_SEALS): string[] {
  const sorted = sortSeals(list);
  return sorted.slice(max).map((s) => s.id);
}

/** 由运行时印章生成库记录。 */
export function toSavedSeal(seal: SealImage, now: number): SavedSeal {
  return {
    id: contentKey(seal.pngBytes),
    name: seal.name,
    pngBytes: seal.pngBytes,
    srcW: seal.srcW,
    srcH: seal.srcH,
    cropW: seal.cropW,
    cropH: seal.cropH,
    aspect: seal.aspect,
    fringeRatio: seal.fringeRatio,
    hadFringe: seal.hadFringe,
    trimmed: seal.trimmed,
    dpiScale: seal.dpiScale,
    bgMode: seal.bgMode,
    savedAt: now,
    lastUsedAt: now,
  };
}

/** 库记录 → 运行时印章（objectUrl 由调用方创建，方便回收）。 */
export function toSealImage(saved: SavedSeal, objectUrl: string): SealImage {
  return {
    name: saved.name,
    pngBytes: saved.pngBytes,
    objectUrl,
    srcW: saved.srcW,
    srcH: saved.srcH,
    cropW: saved.cropW,
    cropH: saved.cropH,
    aspect: saved.aspect,
    fringeRatio: saved.fringeRatio,
    hadFringe: saved.hadFringe,
    trimmed: saved.trimmed,
    dpiScale: saved.dpiScale,
    bgMode: saved.bgMode,
  };
}

// ---------------------------------------------------------------- IndexedDB

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('印章库打开失败'));
  });
  return dbPromise;
}

function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error ?? new Error('印章库读写失败'));
        tx.onabort = () => reject(tx.error ?? new Error('印章库事务被中断'));
      }),
  );
}

export async function listSeals(): Promise<SavedSeal[]> {
  const all = await run<SavedSeal[]>('readonly', (s) => s.getAll());
  return sortSeals(all ?? []);
}

export async function putSeal(seal: SavedSeal): Promise<void> {
  await run('readwrite', (s) => s.put(seal));
}

export async function putSeals(seals: SavedSeal[]): Promise<void> {
  if (seals.length === 0) return;
  await run('readwrite', (s) => {
    for (const seal of seals) s.put(seal);
    return s.put(seals[seals.length - 1]); // 借一次请求当作事务完成的信号
  });
}

export async function deleteSeal(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}

export async function clearSeals(): Promise<void> {
  await run('readwrite', (s) => s.clear());
}
