import type { PageInfo, SealImage, Stamp } from '../lib/types';
import { sortForDisplay, type SavedSeal } from '../lib/sealStore';

export const HISTORY_LIMIT = 50;

export interface AppState {
  /**
   * 原文档只保留 File 句柄，不常驻字节。
   *
   * 因为 pdf.js 打开文档时会把 buffer 转移给 worker，调用方那块内存会被
   * detach，没法留作导出用；而为了导出再留一份副本，大文件内存直接翻倍
   * （早期版本正是这么干的）。改为「导出时重读一次」，编辑期的常驻内存
   * 只剩 pdf.js 自己那一份。
   */
  docFile: File | null;
  docFileName: string;
  pages: PageInfo[];
  stamps: Stamp[];
  /** 撤销快照栈：只存可变的那部分（印章数组） */
  past: Stamp[][];
  future: Stamp[][];
  currentPage: number;
  zoom: number;
  seal: SealImage | null;
  selectedId: string | null;
  busy: string | null;
  /** 导出成功后的提示。桌面版没有「另存为」对话框，
   *  文件静默落进系统下载目录——不给提示用户会以为按钮没反应。 */
  done: string | null;
  error: string | null;
  /** 待确认的合规警告：文档已签名，继续追加会让签名失效。 */
  signWarning: string | null;
  /** 印章库：本机保存过的印章，按最近使用排序 */
  seals: SavedSeal[];
}

export const initialState: AppState = {
  docFile: null,
  docFileName: '',
  pages: [],
  stamps: [],
  past: [],
  future: [],
  currentPage: 0,
  zoom: 1,
  seal: null,
  selectedId: null,
  busy: null,
  done: null,
  error: null,
  signWarning: null,
  seals: [],
};

export type Action =
  | { type: 'LOAD_PDF' }
  | { type: 'PDF_READY'; handle: { pages: PageInfo[]; fileName: string }; zoom: number; file: File }
  | { type: 'SET_SEAL'; seal: SealImage }
  | { type: 'SEALS_LOADED'; seals: SavedSeal[] }
  | { type: 'SEAL_SAVED'; seal: SavedSeal }
  | { type: 'SEALS_DELETED'; ids: string[] }
  | { type: 'ADD_STAMPS'; stamps: Stamp[] }
  | { type: 'UPDATE_STAMP'; id: string; patch: Partial<Stamp>; history?: boolean }
  | { type: 'BEGIN_EDIT' }
  | { type: 'REMOVE_STAMP'; id: string }
  | { type: 'SELECT'; id: string | null }
  | { type: 'SET_PAGE'; page: number }
  | { type: 'SET_ZOOM'; zoom: number }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'BUSY'; label: string | null }
  | { type: 'DONE'; message: string | null }
  | { type: 'ERROR'; message: string | null }
  | { type: 'SIGN_WARNING'; message: string | null };

/**
 * 纯 reducer —— 状态变化的**唯一**入口。
 *
 * 单独成文件（不 import React）是为了能直接单测：撤销语义出过一次
 * 「要按两次才回退」的错，而这类时序问题跑 UI 很难发现，跑 reducer 一眼就能断言。
 */
export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'LOAD_PDF':
      // 换文档不清印章：用户完全可以先把章准备好。
      return {
        ...state,
        docFile: null,
        docFileName: '',
        pages: [],
        stamps: [],
        past: [],
        future: [],
        currentPage: 0,
        selectedId: null,
        busy: '正在读取 PDF…',
        done: null,
        error: null,
        signWarning: null,
      };

    case 'PDF_READY':
      return {
        ...state,
        busy: null,
        error: null,
        docFile: action.file,
        docFileName: action.handle.fileName,
        pages: action.handle.pages,
        currentPage: 0,
        zoom: action.zoom,
      };

    case 'SET_SEAL':
      return { ...state, seal: action.seal, busy: null, error: null };

    case 'SEALS_LOADED':
      return { ...state, seals: sortForDisplay(action.seals) };

    /** 导入或再次选用时入库；同一枚章（内容指纹相同）只留一条，只刷新时间。 */
    case 'SEAL_SAVED': {
      const rest = state.seals.filter((s) => s.id !== action.seal.id);
      return { ...state, seals: sortForDisplay([...rest, action.seal]) };
    }

    case 'SEALS_DELETED': {
      const gone = new Set(action.ids);
      return { ...state, seals: state.seals.filter((s) => !gone.has(s.id)) };
    }

    case 'ADD_STAMPS':
      if (action.stamps.length === 0) return state;
      return {
        ...state,
        past: pushHistory(state.past, state.stamps),
        future: [],
        stamps: [...state.stamps, ...action.stamps],
        selectedId: action.stamps[action.stamps.length - 1].id,
      };

    case 'UPDATE_STAMP': {
      const stamps = state.stamps.map((s) =>
        s.id === action.id ? { ...s, ...action.patch } : s,
      );
      return {
        ...state,
        stamps,
        past: action.history === false ? state.past : pushHistory(state.past, state.stamps),
        future: action.history === false ? state.future : [],
      };
    }

    /**
     * 连续交互（拖拽、滑杆、方向键）的**起点**快照。
     *
     * 撤销栈存的必须是「动手之前」的状态。早期版本在松手时才记快照，
     * 记下来的却是拖完之后的状态——第一次撤销等于原地踏步，
     * 用户必须按第二次才真的回退。改成「交互开始时入栈、过程中静默更新」
     * 就彻底没有这个时间差问题了。
     */
    case 'BEGIN_EDIT': {
      const top = state.past[state.past.length - 1];
      // 点了一下滑杆没动、或焦点反复进出时会产生重复快照，去重避免白吃一次撤销
      if (top && sameStamps(top, state.stamps)) return state;
      return { ...state, past: pushHistory(state.past, state.stamps), future: [] };
    }

    case 'REMOVE_STAMP': {
      const stamps = state.stamps.filter((s) => s.id !== action.id);
      return {
        ...state,
        past: pushHistory(state.past, state.stamps),
        future: [],
        stamps,
        selectedId: state.selectedId === action.id ? null : state.selectedId,
      };
    }

    case 'SELECT':
      return { ...state, selectedId: action.id };

    case 'SET_PAGE':
      return { ...state, currentPage: action.page, selectedId: null };

    case 'SET_ZOOM':
      return { ...state, zoom: action.zoom };

    case 'UNDO': {
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      return {
        ...state,
        past: state.past.slice(0, -1),
        future: [state.stamps, ...state.future].slice(0, HISTORY_LIMIT),
        stamps: prev,
        selectedId: prev.some((s) => s.id === state.selectedId)
          ? state.selectedId
          : null,
      };
    }

    case 'REDO': {
      if (state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      return {
        ...state,
        past: pushHistory(state.past, state.stamps),
        future: rest,
        stamps: next,
        selectedId: next.some((s) => s.id === state.selectedId)
          ? state.selectedId
          : null,
      };
    }

    case 'BUSY':
      return { ...state, busy: action.label, done: null, signWarning: null };

    case 'DONE':
      return { ...state, done: action.message, busy: null, signWarning: null };

    case 'ERROR':
      return { ...state, error: action.message, busy: null, done: null };

    case 'SIGN_WARNING':
      return { ...state, signWarning: action.message, busy: null };
  }
}

export const pushHistory = (past: Stamp[][], snapshot: Stamp[]): Stamp[][] =>
  [...past, snapshot].slice(-HISTORY_LIMIT);

/** 逐字段比较两份快照（印章对象本身是 new 过的，不能比引用）。 */
export function sameStamps(a: Stamp[], b: Stamp[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const t = b[i];
    return (
      s.id === t.id &&
      s.xPt === t.xPt &&
      s.yPt === t.yPt &&
      s.widthPt === t.widthPt &&
      s.heightPt === t.heightPt &&
      s.rotationDeg === t.rotationDeg &&
      s.opacity === t.opacity
    );
  });
}
