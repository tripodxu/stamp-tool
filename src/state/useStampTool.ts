import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { SealDefaults, SealImage, Stamp } from '../lib/types';
import { loadPdf, type PdfHandle } from '../lib/pdfReader';
import {
  downloadBlob,
  hasSignatureField,
  openPdfDoc,
  stampDocument,
} from '../lib/exporter';
import { decodeSealPixels, loadSealFile, reencodeSealPng } from '../lib/seal';
import { saveBytesAs } from '../lib/saveAs';
import { mmToPt, ptToMm } from '../lib/units';
import {
  clamp,
  clampPlacement,
  defaultPlacement,
  defaultSealDefaults,
  presetPatch,
  type StampPreset,
} from '../lib/geometry';
import { pageIndices, parsePageSpec } from '../lib/batch';
import { sameInkPixels } from '../lib/sealPixels';
import { revokeAllPngUrls } from '../lib/pngCache';
import {
  contentKey,
  deleteSeal as deleteSealFromStore,
  findSealByInkKey,
  listSeals,
  pickEvictions,
  putSeal,
  sealRecordId,
  toSavedSeal,
  toSealImage,
  clearSeals,
  type SavedSeal,
} from '../lib/sealStore';
import { initialState, reducer } from './reducer';

export type { AppState } from './reducer';

/** 方向键连续微调多久算同一次编辑（毫秒）。 */
const NUDGE_SESSION_MS = 800;

/** 改完直径/角度/浓度多久后把这枚章的参数写回印章库（毫秒）。 */
const DEFAULTS_SAVE_MS = 600;

/** 侧栏 + 视口内边距的兜底宽度（量不到 DOM 时用）。 */
const FALLBACK_CHROME_PX = 520;
const VIEWPORT_PADDING_PX = 56;

export function useStampTool() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const pdfHandle = useRef<PdfHandle | null>(null);
  /**
   * 稳定读取最新 state 的旁路。
   *
   * 所有 action creator 都保持引用不变（依赖数组为空），否则 App 里的全局
   * 键盘监听会每次渲染都解绑重绑。nudge/addStamp 这类「要读旧 state」
   * 的回调就走这个 ref。
   */
  const stateRef = useRef(state);
  stateRef.current = state;
  const nudgeSession = useRef<{ id: string; t: number }>({ id: '', t: 0 });

  // ---- 文档 ----
  /** 真正的载入过程。调用方负责先确认「盖的章可以丢」。 */
  const loadPdfFile = useCallback(async (file: File) => {
    dispatch({ type: 'LOAD_PDF' });
    try {
      // 只读一次文件。pdf.js 拿走这块 buffer（可能 detach），导出时再从 File 重读。
      const bytes = new Uint8Array(await file.arrayBuffer());
      const handle = await loadPdf(bytes, file.name);
      // 先销毁旧文档再挂新的，否则连续换文件会把 worker 里的旧文档越堆越多
      pdfHandle.current?.destroy();
      pdfHandle.current = handle;

      // 适配窗口宽度
      const first = handle.pages[0];
      const zoom = clampZoom(measureViewportWidth() / first.wPt);

      dispatch({ type: 'PDF_READY', handle, zoom, file });
    } catch (e) {
      pdfHandle.current = null;
      dispatch({ type: 'ERROR', message: (e as Error).message });
    }
  }, []);

  /**
   * 打开 PDF。
   *
   * 已经盖了章就先问一句再动手：LOAD_PDF 会连撤销栈一起清掉，是应用里
   * 唯一退不回来的操作，手滑选错文件就真的白盖了。
   */
  const openPdf = useCallback(
    async (file: File) => {
      if (stateRef.current.stamps.length > 0) {
        dispatch({ type: 'PDF_CONFIRM', file });
        return;
      }
      await loadPdfFile(file);
    },
    [loadPdfFile],
  );

  /** 横幅上的「仍然打开」：丢掉当前这批章，载入新文件。 */
  const confirmOpenPdf = useCallback(async () => {
    const file = stateRef.current.pendingPdf;
    if (!file) return;
    dispatch({ type: 'PDF_CANCEL' }); // 先收横幅，再进 LOAD_PDF 的忙碌态
    await loadPdfFile(file);
  }, [loadPdfFile]);

  const cancelOpenPdf = useCallback(() => dispatch({ type: 'PDF_CANCEL' }), []);

  // ---- 印章库 ----
  /** 把一枚已处理好的印章设为当前印章（本地库与内存共用这条路径）。 */
  const activateSeal = useCallback((seal: SealImage) => {
    // 换章即释放上一枚章的 objectURL，避免 Blob 无限堆积
    const prev = stateRef.current.seal;
    if (prev && prev.objectUrl !== seal.objectUrl) URL.revokeObjectURL(prev.objectUrl);
    revokeAllPngUrls();
    dispatch({ type: 'SET_SEAL', seal });
    // 换一枚章 = 换一整套参数：直径/角度/浓度都回到这枚章自己的值
    dispatch({
      type: 'SEAL_DEFAULTS',
      defaults: seal.defaults ?? defaultSealDefaults(seal.bgMode),
    });
  }, []);

  /** 点选库里的一枚印章：直接用存好的 PNG，不必重跑像素处理。 */
  const useSavedSeal = useCallback(
    (saved: SavedSeal) => {
      const objectUrl = URL.createObjectURL(
        new Blob([saved.pngBytes as BlobPart], { type: 'image/png' }),
      );
      activateSeal(toSealImage(saved, objectUrl));
      // 刷新「最近使用」，下次打开它排在最前
      const bumped = { ...saved, lastUsedAt: Date.now() };
      dispatch({ type: 'SEAL_SAVED', seal: bumped });
      void putSeal(bumped).catch(() => undefined);
    },
    [activateSeal],
  );

  const removeSavedSeal = useCallback((id: string) => {
    dispatch({ type: 'SEALS_DELETED', ids: [id] });
    void deleteSealFromStore(id).catch(() => undefined);
  }, []);

  const clearSavedSeals = useCallback(() => {
    dispatch({ type: 'SEALS_DELETED', ids: stateRef.current.seals.map((s) => s.id) });
    void clearSeals().catch(() => undefined);
  }, []);

  // ---- 印章 ----
  const openSeal = useCallback(
    async (file: File) => {
      dispatch({ type: 'BUSY', label: '正在处理印章图像…' });
      try {
        const seal = await loadSealFile(file);
        // 新导入的章：默认参数按它自己的去背路线定（翻拍件浓度必须是 1）
        const fresh: SealImage = { ...seal, defaults: defaultSealDefaults(seal.bgMode) };
        activateSeal(fresh);
        // 导入即入库：这是「不用重复导入」的关键一步
        const saved = toSavedSeal(fresh, Date.now());
        dispatch({ type: 'SEAL_SAVED', seal: saved });
        void putSeal(saved)
          .then(() => {
            // 超出上限就淘汰最久没用过的，别让库无限长
            const doomed = pickEvictions(stateRef.current.seals);
            if (doomed.length === 0) return;
            dispatch({ type: 'SEALS_DELETED', ids: doomed });
            return Promise.all(doomed.map((id) => deleteSealFromStore(id)));
          })
          .catch(() => undefined);
      } catch (e) {
        dispatch({ type: 'ERROR', message: (e as Error).message });
      }
    },
    [activateSeal],
  );

  // 这枚章在画布上调过的尺寸/角度/浓度，防抖之后写回印章库那条记录
  const defaultsPending = useRef<{ id: string; next: Partial<SealDefaults> } | null>(null);
  const defaultsTimer = useRef<number | null>(null);

  /**
   * 把「这枚章调过的参数」落回印章库。
   *
   * 库里的 id 是记录 id（优先源文件指纹），画布上的章只带 pngBytes，
   * 所以先用墨迹指纹反查是哪一条记录，再改它。找不到（比如这枚章的图
   * 来自一次没有入库的导入）就安静放弃——记不住参数，但绝不报错。
   */
  const flushSealDefaults = useCallback(() => {
    if (defaultsTimer.current !== null) {
      window.clearTimeout(defaultsTimer.current);
      defaultsTimer.current = null;
    }
    const pending = defaultsPending.current;
    defaultsPending.current = null;
    if (!pending) return;
    const cur = stateRef.current;
    const stamp = cur.stamps.find((s) => s.id === pending.id);
    if (!stamp) return;
    const rec = findSealByInkKey(cur.seals, contentKey(stamp.pngBytes));
    if (!rec) return;
    const defaults: SealDefaults = {
      ...(rec.defaults ?? defaultSealDefaults(rec.bgMode)),
      ...pending.next,
    };
    dispatch({ type: 'SEAL_PATCHED', id: rec.id, patch: { defaults } });
    void putSeal({ ...rec, defaults }).catch(() => undefined);
    // 改的就是当前这枚章：下一次「放置印章」直接用新参数
    if (cur.seal && sealRecordId(cur.seal) === rec.id) {
      dispatch({ type: 'SEAL_DEFAULTS', defaults });
    }
  }, []);

  /** 只关心这枚章的参数；位置、页码、选中状态都不进默认值。 */
  const rememberSealDefaults = useCallback(
    (id: string, patch: Partial<Stamp>) => {
      const next: Partial<SealDefaults> = {};
      if (patch.widthPt !== undefined) next.widthMm = ptToMm(patch.widthPt);
      if (patch.rotationDeg !== undefined) next.rotationDeg = patch.rotationDeg;
      if (patch.opacity !== undefined) next.opacity = patch.opacity;
      if (Object.keys(next).length === 0) return;
      const prev = defaultsPending.current;
      defaultsPending.current = {
        id,
        next: prev && prev.id === id ? { ...prev.next, ...next } : next,
      };
      if (defaultsTimer.current !== null) window.clearTimeout(defaultsTimer.current);
      defaultsTimer.current = window.setTimeout(flushSealDefaults, DEFAULTS_SAVE_MS);
    },
    [flushSealDefaults],
  );

  /** 给库里的一枚印章改名。文件名常常是「微信图片_2026…」这种认不出的东西。 */
  const renameSavedSeal = useCallback((id: string, name: string) => {
    const clean = name.trim().slice(0, 40);
    if (!clean) return;
    const rec = stateRef.current.seals.find((s) => s.id === id);
    if (!rec || rec.name === clean) return;
    dispatch({ type: 'SEAL_PATCHED', id, patch: { name: clean } });
    void putSeal({ ...rec, name: clean }).catch(() => undefined);
    // 正在用的就是它 → 面板上的名字跟着变
    const cur = stateRef.current.seal;
    if (cur && sealRecordId(cur) === id) {
      dispatch({ type: 'SET_SEAL', seal: { ...cur, name: clean } });
    }
  }, []);

  /**
   * 清理重复：同一个章可能被导入过两次，肉眼完全一样。
   *
   * 早期库里的 id 是「处理后字节」指纹，同一次导入在黑框修复前后各存过一份，
   * 两份只差透明区的颜色，正是同一枚章。按「墨迹逐像素相同」归组，
   * 每组只留最近用过的那条。
   */
  const dedupeSeals = useCallback(async () => {
    const list = stateRef.current.seals;
    if (list.length < 2) return;
    dispatch({ type: 'BUSY', label: '正在比对印章库…' });
    try {
      const pix = new Map<string, Uint8ClampedArray>();
      for (const s of list) {
        try {
          pix.set(s.id, await decodeSealPixels(s.pngBytes));
        } catch {
          // 解不开的（图坏了）不参与比对，也绝不因此删掉
        }
      }
      const groups: { data: Uint8ClampedArray; members: SavedSeal[] }[] = [];
      for (const s of list) {
        const data = pix.get(s.id);
        if (!data) continue;
        const hit = groups.find((g) => sameInkPixels(g.data, data));
        if (hit) hit.members.push(s);
        else groups.push({ data, members: [s] });
      }
      const doomed: string[] = [];
      for (const g of groups) {
        if (g.members.length < 2) continue;
        const sorted = [...g.members].sort(
          (a, b) => b.lastUsedAt - a.lastUsedAt || b.savedAt - a.savedAt,
        );
        for (const extra of sorted.slice(1)) doomed.push(extra.id);
      }
      if (doomed.length === 0) {
        dispatch({ type: 'DONE', message: '印章库里没有重复的印章。' });
        return;
      }
      dispatch({ type: 'SEALS_DELETED', ids: doomed });
      await Promise.all(doomed.map((id) => deleteSealFromStore(id)));
      dispatch({ type: 'DONE', message: `已清理 ${doomed.length} 枚重复的印章。` });
    } catch (e) {
      dispatch({ type: 'ERROR', message: `清理重复失败：${(e as Error).message}` });
    }
  }, []);

  /** 把这枚章盖到指定页：单份文档也能只盖第 3 页或第 5-8 页。 */
  const stampOnPages = useCallback((id: string, specText: string) => {
    const { stamps, pages } = stateRef.current;
    const src = stamps.find((s) => s.id === id);
    if (!src) return;
    let targets: number[];
    try {
      targets = pageIndices(parsePageSpec(specText), pages.length);
    } catch (e) {
      dispatch({ type: 'ERROR', message: (e as Error).message });
      return;
    }
    const other = targets.filter((i) => i !== src.pageIndex);
    if (other.length === 0) {
      dispatch({
        type: 'ERROR',
        message: `这些页里没有需要新盖的页（这枚章已经在第 ${src.pageIndex + 1} 页）`,
      });
      return;
    }
    dispatch({
      type: 'ADD_STAMPS',
      stamps: other.map((i) => ({
        ...src,
        id: nextId(),
        pageIndex: i,
        ...clampPlacement(src, pages[i]),
      })),
    });
    dispatch({
      type: 'DONE',
      message: `已盖到第 ${other.map((i) => i + 1).join('、')} 页。`,
    });
  }, []);

  /** 复制这枚章（Ctrl+D）：偏移 5mm，免得两枚完全重合看不出变化。 */
  const duplicateStamp = useCallback((id: string) => {
    const { stamps, pages } = stateRef.current;
    const src = stamps.find((s) => s.id === id);
    if (!src) return;
    const page = pages[src.pageIndex];
    const off = mmToPt(5);
    const moved = { ...src, xPt: src.xPt + off, yPt: src.yPt + off };
    dispatch({
      type: 'ADD_STAMPS',
      stamps: [{ ...moved, id: nextId(), ...(page ? clampPlacement(moved, page) : {}) }],
    });
  }, []);

  // 启动时读库；没有当前印章就自动选中最近用过的那枚——打开即可盖章
  useEffect(() => {
    let cancelled = false;
    void listSeals()
      .then((list) => {
        if (cancelled) return;
        dispatch({ type: 'SEALS_LOADED', seals: list });
        const recent = list[0];
        if (recent && !stateRef.current.seal) useSavedSeal(recent);
      })
      .catch(() => undefined); // 无痕模式/存储被禁用：不影响盖章，只是没有库
    return () => {
      cancelled = true;
    };
  }, [useSavedSeal]);

  const addStamp = useCallback((pageIndex?: number) => {
    const { seal, pages, currentPage, sealDefaults } = stateRef.current;
    const index = pageIndex ?? currentPage;
    const page = pages[index];
    if (!seal || !page) return;
    // 用这枚章自己的默认参数：换章之后不该沿用上一枚调过的尺寸与浓度
    const widthPt = mmToPt(sealDefaults.widthMm);
    const heightPt = widthPt / seal.aspect;
    dispatch({
      type: 'ADD_STAMPS',
      stamps: [
        {
          id: nextId(),
          pageIndex: index,
          pngBytes: seal.pngBytes,
          widthPt,
          heightPt,
          ...defaultPlacement({ widthPt, heightPt }, page),
          rotationDeg: sealDefaults.rotationDeg,
          // 翻拍件的默认浓度是 1：照片已带真实浓淡，再压透明度会让底下的字透上来
          opacity: sealDefaults.opacity,
          // 长宽比与像素宽度随章走：换过印章之后，这枚章仍然按自己那张图算
          aspect: seal.aspect,
          cropW: seal.cropW,
        },
      ],
    });
  }, []);

  /** 把当前这枚章原样复制到其余每一页（跨页复用，设计 §7 Step 3）。 */
  const copyStampToAllPages = useCallback((id: string) => {
    const { stamps, pages } = stateRef.current;
    const src = stamps.find((s) => s.id === id);
    if (!src || pages.length < 2) return;
    const clones: Stamp[] = [];
    for (let i = 0; i < pages.length; i++) {
      if (i === src.pageIndex) continue;
      const page = pages[i];
      clones.push({
        ...src,
        id: nextId(),
        pageIndex: i,
        // 页面尺寸可能不同，夹回可视范围
        ...clampPlacement(src, page),
      });
    }
    dispatch({ type: 'ADD_STAMPS', stamps: clones });
  }, []);

  /** 一键摆放：落款处 / 右下角 / 骑缝（左·右）。 */
  const applyPreset = useCallback((id: string, kind: StampPreset) => {
    const { stamps, pages } = stateRef.current;
    const stamp = stamps.find((s) => s.id === id);
    const page = stamp ? pages[stamp.pageIndex] : undefined;
    if (!stamp || !page) return;
    dispatch({ type: 'UPDATE_STAMP', id, patch: presetPatch(stamp, page, kind) });
  }, []);

  const updateStamp = useCallback(
    (id: string, patch: Partial<Stamp>, history = true) => {
      dispatch({ type: 'UPDATE_STAMP', id, patch, history });
      // 直径/角度/浓度是「这枚章自己的参数」，松手后记回库里那条
      if (
        patch.widthPt !== undefined ||
        patch.rotationDeg !== undefined ||
        patch.opacity !== undefined
      ) {
        rememberSealDefaults(id, patch);
      }
    },
    [rememberSealDefaults],
  );

  /** 连续交互的起点快照。拖拽 pointerdown / 滑杆 focus 时调用。 */
  const beginEdit = useCallback(() => dispatch({ type: 'BEGIN_EDIT' }), []);

  const nudge = useCallback((id: string, dxPt: number, dyPt: number) => {
    const state = stateRef.current;
    const stamp = state.stamps.find((s) => s.id === id);
    if (!stamp) return;
    const page = state.pages[stamp.pageIndex];

    // 按住方向键是一串连续微调，节流成一次撤销
    const now = Date.now();
    const session = nudgeSession.current;
    if (session.id !== id || now - session.t > NUDGE_SESSION_MS) {
      dispatch({ type: 'BEGIN_EDIT' });
    }
    nudgeSession.current = { id, t: now };

    // 允许部分出血，但至少保留四分之一在页内，避免"章丢到页面外找不到"
    const margin = stamp.widthPt / 4;
    const next = {
      xPt: clamp(stamp.xPt + dxPt, -stamp.widthPt + margin, page.wPt - margin),
      yPt: clamp(stamp.yPt + dyPt, -stamp.heightPt + margin, page.hPt - margin),
    };
    dispatch({ type: 'UPDATE_STAMP', id, patch: next, history: false });
  }, []);

  const removeStamp = useCallback(
    (id: string) => dispatch({ type: 'REMOVE_STAMP', id }),
    [],
  );

  const select = useCallback((id: string | null) => dispatch({ type: 'SELECT', id }), []);
  const setPage = useCallback(
    (page: number) => dispatch({ type: 'SET_PAGE', page }),
    [],
  );
  const setZoom = useCallback(
    (zoom: number) => dispatch({ type: 'SET_ZOOM', zoom: clampZoom(zoom) }),
    [],
  );
  const undo = useCallback(() => dispatch({ type: 'UNDO' }), []);
  const redo = useCallback(() => dispatch({ type: 'REDO' }), []);
  const clearError = useCallback(() => dispatch({ type: 'ERROR', message: null }), []);
  const clearDone = useCallback(() => dispatch({ type: 'DONE', message: null }), []);
  const clearSignWarning = useCallback(
    () => dispatch({ type: 'SIGN_WARNING', message: null }),
    [],
  );

  // ---- 导出 ----
  /** 用户上一次点的是「导出 PDF」还是「另存为…」，签名警告确认后要接着走同一条路。 */
  const exportAsRef = useRef(false);

  /**
   * 真正干活的那一步：检查签名 → 盖章 → 返回字节与建议文件名。
   * 用户取消（签名警告）时返回 null。
   *
   * force=true 表示用户已在警告条上确认过「明知签名会失效」。
   * 检测与盖章共用同一个已载入的 PDFDocument，不重复解析。
   */
  const buildExport = useCallback(async (force: boolean) => {
    const { docFile, stamps, docFileName, pages, busy } = stateRef.current;
    // busy 期间直接忽略：导出按钮没有「进行中」态，连点会跑两遍
    if (!docFile || busy) return null;
    // 还没落库的参数先写掉：导出的这一刻库里就该是用户看到的样子
    flushSealDefaults();
    dispatch({ type: 'BUSY', label: '正在导出 PDF…' });
    try {
      const bytes = new Uint8Array(await docFile.arrayBuffer());
      const doc = await openPdfDoc(bytes);

      if (!force && hasSignatureField(doc)) {
        dispatch({
          type: 'SIGN_WARNING',
          message:
            '该 PDF 含有数字签名字段。追加印章会使已有签名立即失效，接收方验签将失败。',
        });
        return null;
      }

      // frames 必须是预览用的那一份页面几何（含 /Rotate、裁切框、UserUnit），
      // 用 pdf-lib 自己的 getSize() 会在旋转页上把章盖偏几十毫米。
      // 顺便把老印章库里 canvas 编出来的字节重编一遍：透明区不刷白，
      // 在忽略 /SMask 的阅读器里章外面会有一圈黑框。
      const out = await stampDocument(doc, stamps, {
        frames: pages,
        prepareImage: reencodeSealPng,
      });
      const base = docFileName.replace(/\.pdf$/i, '');
      return { out, fileName: `${base}-已盖章.pdf` };
    } catch (e) {
      const msg = (e as Error)?.name?.includes('Encrypted')
        ? '该 PDF 受保护，无法写入内容。请先移除密码。'
        : `导出失败：${(e as Error).message}`;
      dispatch({ type: 'ERROR', message: msg });
      return null;
    }
  }, [flushSealDefaults]);

  const exportPdf = useCallback(
    async (force = false) => {
      exportAsRef.current = false;
      const r = await buildExport(force);
      if (!r) return;
      downloadBlob(r.out, r.fileName);
      // 桌面版默认把文件直接落进系统下载目录。必须明确告诉用户文件去哪了，
      // 否则「点了没反应」=「以为坏了」。
      dispatch({ type: 'DONE', message: `已导出「${r.fileName}」，保存在「下载」文件夹。` });
    },
    [buildExport],
  );

  /**
   * 「另存为…」：让用户自己挑位置和文件名。
   *
   * 环境不支持（或这是一次没有用户手势的合成点击）就退回普通下载——
   * 宁可文件落在「下载」里，也不能让按钮点了没反应。
   */
  const exportPdfAs = useCallback(
    async (force = false) => {
      exportAsRef.current = true;
      const r = await buildExport(force);
      if (!r) return;
      let res;
      try {
        res = await saveBytesAs(r.out, r.fileName, {
          mime: 'application/pdf',
          description: 'PDF 文件',
          ext: '.pdf',
        });
      } catch (e) {
        dispatch({ type: 'ERROR', message: `另存为失败：${(e as Error).message}` });
        return;
      }
      if (res.status === 'cancelled') return; // 用户自己取消的，不该弹「已保存」
      if (res.status === 'saved') {
        dispatch({ type: 'DONE', message: `已保存「${res.name}」。` });
        return;
      }
      downloadBlob(r.out, r.fileName);
      dispatch({
        type: 'DONE',
        message: `这个环境不支持「另存为」，已导出到「下载」文件夹。`,
      });
    },
    [buildExport],
  );

  /** 签名警告条上的「仍然导出」：接着用户当初点的那条路走。 */
  const confirmExport = useCallback(() => {
    void (exportAsRef.current ? exportPdfAs(true) : exportPdf(true));
  }, [exportPdf, exportPdfAs]);

  // ---- 卸载清理 ----
  useEffect(
    () => () => {
      pdfHandle.current?.destroy();
      pdfHandle.current = null;
      if (stateRef.current.seal) URL.revokeObjectURL(stateRef.current.seal.objectUrl);
      revokeAllPngUrls();
    },
    [],
  );

  const stats = useMemo(
    () => ({
      stampCount: state.stamps.length,
      pageCount: state.pages.length,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
    }),
    [state.stamps.length, state.pages.length, state.past.length, state.future.length],
  );

  return {
    state,
    stats,
    pdfHandle,
    openPdf,
    confirmOpenPdf,
    cancelOpenPdf,
    openSeal,
    useSavedSeal,
    removeSavedSeal,
    renameSavedSeal,
    dedupeSeals,
    clearSavedSeals,
    addStamp,
    updateStamp,
    applyPreset,
    copyStampToAllPages,
    stampOnPages,
    duplicateStamp,
    beginEdit,
    nudge,
    removeStamp,
    select,
    setPage,
    setZoom,
    undo,
    redo,
    exportPdf,
    exportPdfAs,
    confirmExport,
    clearError,
    clearDone,
    clearSignWarning,
  };
}

let idSeq = 0;
const nextId = () => `stamp-${++idSeq}-${Date.now().toString(36)}`;

const clampZoom = (z: number) => Math.min(4, Math.max(0.25, Math.round(z * 20) / 20));

/**
 * 视口可用宽度。量真实 DOM 而不是写死 `innerWidth - 520`：
 * 侧栏宽度、窗口内边距一变，写死的数字就会让「自适应窗口」失准。
 */
function measureViewportWidth(): number {
  const el = document.querySelector('.viewport');
  const measured =
    el instanceof HTMLElement ? el.clientWidth - VIEWPORT_PADDING_PX : 0;
  return Math.max(measured || window.innerWidth - FALLBACK_CHROME_PX, 480);
}
