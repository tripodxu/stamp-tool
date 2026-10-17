import type { SealDefaults, SealImage } from './types';

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
  /** 记录指纹：优先按**源文件**字节（见 sealRecordId），重复导入会刷新同一条 */
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
  /** 源文件字节的指纹（老记录没有这个字段，id 就是处理后的指纹） */
  sourceKey?: string;
  /** 这枚章的参数默认值：下次选用它时直接恢复上次调好的直径/角度/浓度 */
  defaults?: SealDefaults;
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

/**
 * 一条库记录的 id。
 *
 * 优先用**源文件**的指纹：同一张原图重新导入（哪怕处理算法改过）会命中同一条，
 * 不会在库里堆出两条看起来一样的印章。老记录没有 sourceKey，退回处理后的指纹。
 */
export function sealRecordId(seal: Pick<SealImage, 'pngBytes' | 'sourceKey'>): string {
  return seal.sourceKey ?? contentKey(seal.pngBytes);
}

/** 按 id 局部更新一条记录（改名、记住参数）。找不到就原样返回。 */
export function patchSavedSeal(
  list: SavedSeal[],
  id: string,
  patch: Partial<SavedSeal>,
): SavedSeal[] {
  if (!list.some((s) => s.id === id)) return list;
  return list.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

/**
 * 按「已处理 PNG 的指纹」找回库里的那条记录。
 *
 * 画布上的章只知道自己嵌进去的字节（可能是老记录，id 按处理后指纹算的），
 * 所以要把库里的每一条都算一遍指纹，不能拿 stamp 去和 id 直接比。
 */
export function findSealByInkKey(list: SavedSeal[], inkKey: string): SavedSeal | null {
  return list.find((s) => contentKey(s.pngBytes) === inkKey) ?? null;
}

/** 「10-17 14:51」：同名印章靠导入时间分辨。 */
export function formatSavedAt(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
    id: sealRecordId(seal),
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
    sourceKey: seal.sourceKey,
    defaults: seal.defaults,
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
    sourceKey: saved.sourceKey,
    defaults: saved.defaults,
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
