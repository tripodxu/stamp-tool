import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { SealImage, Stamp } from '../lib/types';
import { loadPdf, type PdfHandle } from '../lib/pdfReader';
import {
  downloadBlob,
  hasSignatureField,
  openPdfDoc,
  stampDocument,
} from '../lib/exporter';
import { loadSealFile, reencodeSealPng } from '../lib/seal';
import { mmToPt, STANDARD_SEAL_MM } from '../lib/units';
import {
  clamp,
  clampPlacement,
  defaultOpacity,
  defaultPlacement,
  presetPatch,
  type StampPreset,
} from '../lib/geometry';
import { revokeAllPngUrls } from '../lib/pngCache';
import {
  deleteSeal as deleteSealFromStore,
  listSeals,
  pickEvictions,
  putSeal,
  toSavedSeal,
  toSealImage,
  clearSeals,
  type SavedSeal,
} from '../lib/sealStore';
import { initialState, reducer } from './reducer';

export type { AppState } from './reducer';

/** 方向键连续微调多久算同一次编辑（毫秒）。 */
const NUDGE_SESSION_MS = 800;

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
  const openPdf = useCallback(async (file: File) => {
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

  // ---- 印章库 ----
  /** 把一枚已处理好的印章设为当前印章（本地库与内存共用这条路径）。 */
  const activateSeal = useCallback((seal: SealImage) => {
    // 换章即释放上一枚章的 objectURL，避免 Blob 无限堆积
    const prev = stateRef.current.seal;
    if (prev && prev.objectUrl !== seal.objectUrl) URL.revokeObjectURL(prev.objectUrl);
    revokeAllPngUrls();
    dispatch({ type: 'SET_SEAL', seal });
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
        activateSeal(seal);
        // 导入即入库：这是「不用重复导入」的关键一步
        const saved = toSavedSeal(seal, Date.now());
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
    const { seal, pages, currentPage } = stateRef.current;
    const index = pageIndex ?? currentPage;
    const page = pages[index];
    if (!seal || !page) return;
    const widthPt = mmToPt(STANDARD_SEAL_MM);
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
          rotationDeg: -8, // 实际盖章通常略有倾斜
          // 翻拍件不给 0.85：照片已经带真实浓淡，再压透明度会让底下的字透上来
          opacity: defaultOpacity(seal.bgMode),
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

  /** 一键摆放：落款处 / 右下角 / 骑缝。 */
  const applyPreset = useCallback((id: string, kind: StampPreset) => {
    const { stamps, pages } = stateRef.current;
    const stamp = stamps.find((s) => s.id === id);
    const page = stamp ? pages[stamp.pageIndex] : undefined;
    if (!stamp || !page) return;
    dispatch({ type: 'UPDATE_STAMP', id, patch: presetPatch(stamp, page, kind) });
  }, []);

  const updateStamp = useCallback(
    (id: string, patch: Partial<Stamp>, history = true) =>
      dispatch({ type: 'UPDATE_STAMP', id, patch, history }),
    [],
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
  /**
   * force=true 表示用户已在警告条上确认过「明知签名会失效」。
   * 检测与盖章共用同一个已载入的 PDFDocument，不重复解析。
   */
  const exportPdf = useCallback(async (force = false) => {
    const { docFile, stamps, docFileName, pages, busy } = stateRef.current;
    // busy 期间直接忽略：导出按钮没有「进行中」态，连点会跑两遍
    if (!docFile || busy) return;
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
        return;
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
      const fileName = `${base}-已盖章.pdf`;
      downloadBlob(out, fileName);
      // 桌面版没有「另存为」对话框，文件直接落进系统下载目录。
      // 必须明确告诉用户文件去哪了，否则「点了没反应」=「以为坏了」。
      dispatch({ type: 'DONE', message: `已导出「${fileName}」，保存在「下载」文件夹。` });
    } catch (e) {
      const msg = (e as Error)?.name?.includes('Encrypted')
        ? '该 PDF 受保护，无法写入内容。请先移除密码。'
        : `导出失败：${(e as Error).message}`;
      dispatch({ type: 'ERROR', message: msg });
    }
  }, []);

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
    openSeal,
    useSavedSeal,
    removeSavedSeal,
    clearSavedSeals,
    addStamp,
    updateStamp,
    applyPreset,
    copyStampToAllPages,
    beginEdit,
    nudge,
    removeStamp,
    select,
    setPage,
    setZoom,
    undo,
    redo,
    exportPdf,
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
