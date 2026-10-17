import { describe, expect, it } from 'vitest';
import {
  HISTORY_LIMIT,
  initialState,
  reducer,
  sameStamps,
  type Action,
  type AppState,
} from '../src/state/reducer';
import type { Stamp } from '../src/lib/types';
import { toSavedSeal } from '../src/lib/sealStore';

const mkStamp = (over: Partial<Stamp> = {}): Stamp => ({
  id: 's1',
  pageIndex: 0,
  pngBytes: new Uint8Array([1, 2, 3]),
  xPt: 10,
  yPt: 20,
  widthPt: 100,
  heightPt: 100,
  rotationDeg: 0,
  opacity: 1,
  aspect: 1,
  cropW: 900,
  ...over,
});

const run = (actions: Action[], from: AppState = initialState): AppState =>
  actions.reduce(reducer, from);

const added = run([{ type: 'ADD_STAMPS', stamps: [mkStamp()] }]);

describe('撤销栈', () => {
  it('拖一次只需要撤销一次（曾经的「按两下才回退」）', () => {
    const dragged = run(
      [
        { type: 'BEGIN_EDIT' },
        { type: 'UPDATE_STAMP', id: 's1', patch: { xPt: 200 }, history: false },
      ],
      added,
    );
    expect(dragged.stamps[0].xPt).toBe(200);

    const back = reducer(dragged, { type: 'UNDO' });
    expect(back.stamps[0].xPt).toBe(10);
    expect(back.past).toHaveLength(added.past.length);
  });

  it('BEGIN_EDIT 去重：没动过的交互不吃掉一次撤销', () => {
    const once = reducer(added, { type: 'BEGIN_EDIT' });
    const twice = reducer(once, { type: 'BEGIN_EDIT' });
    expect(twice.past).toHaveLength(once.past.length);
  });

  it('连续拖拽过程不入栈，只留起点快照', () => {
    let s = reducer(added, { type: 'BEGIN_EDIT' });
    for (const x of [50, 80, 120, 160]) {
      s = reducer(s, { type: 'UPDATE_STAMP', id: 's1', patch: { xPt: x }, history: false });
    }
    expect(s.past).toHaveLength(added.past.length + 1);
    expect(reducer(s, { type: 'UNDO' }).stamps[0].xPt).toBe(10);
  });

  it('离散操作（预设/滑杆松手）默认入栈', () => {
    const s = reducer(added, { type: 'UPDATE_STAMP', id: 's1', patch: { rotationDeg: -8 } });
    expect(s.past).toHaveLength(added.past.length + 1);
  });

  it('新编辑清空 redo 分支', () => {
    const undone = reducer(added, { type: 'UNDO' });
    expect(undone.future).toHaveLength(1);
    const edited = reducer(undone, { type: 'BEGIN_EDIT' });
    expect(edited.future).toHaveLength(0);
  });

  it('REDO 还原，且栈深不超过上限', () => {
    let s = added;
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      s = reducer(s, { type: 'UPDATE_STAMP', id: 's1', patch: { xPt: i } });
    }
    expect(s.past).toHaveLength(HISTORY_LIMIT);
    const undone = reducer(s, { type: 'UNDO' });
    expect(reducer(undone, { type: 'REDO' }).stamps[0].xPt).toBe(s.stamps[0].xPt);
  });

  it('空栈时撤销/重做是空操作', () => {
    expect(reducer(initialState, { type: 'UNDO' })).toBe(initialState);
    expect(reducer(initialState, { type: 'REDO' })).toBe(initialState);
  });
});

describe('印章数组', () => {
  it('ADD_STAMPS 选中最后一枚', () => {
    const s = run([{ type: 'ADD_STAMPS', stamps: [mkStamp(), mkStamp({ id: 's2' })] }]);
    expect(s.selectedId).toBe('s2');
  });

  it('ADD_STAMPS 空数组是空操作', () => {
    expect(reducer(initialState, { type: 'ADD_STAMPS', stamps: [] })).toBe(initialState);
  });

  it('REMOVE_STAMP 可撤销，并清掉选中', () => {
    const s = reducer({ ...added, selectedId: 's1' }, { type: 'REMOVE_STAMP', id: 's1' });
    expect(s.stamps).toHaveLength(0);
    expect(s.selectedId).toBeNull();
    expect(reducer(s, { type: 'UNDO' }).stamps).toHaveLength(1);
  });

  it('撤销后如果选中的章已不存在就取消选中', () => {
    const two = run([{ type: 'ADD_STAMPS', stamps: [mkStamp(), mkStamp({ id: 's2' })] }]);
    const undone = reducer(two, { type: 'UNDO' });
    expect(undone.stamps).toHaveLength(0);
    expect(undone.selectedId).toBeNull();
  });
});

describe('sameStamps', () => {
  it('逐字段比较，包含位置/尺寸/角度/浓度', () => {
    expect(sameStamps([mkStamp()], [mkStamp()])).toBe(true);
    expect(sameStamps([mkStamp()], [mkStamp({ xPt: 11 })])).toBe(false);
    expect(sameStamps([mkStamp()], [mkStamp({ opacity: 0.5 })])).toBe(false);
    expect(sameStamps([mkStamp()], [])).toBe(false);
  });
});

describe('印章库', () => {
  const mk = (id: string, lastUsedAt: number, savedAt = 0) => ({
    ...toSavedSeal(
      {
        name: id,
        pngBytes: new Uint8Array([1]),
        objectUrl: '',
        srcW: 10,
        srcH: 10,
        cropW: 10,
        cropH: 10,
        aspect: 1,
        fringeRatio: 0,
        dpiScale: 1,
        hadFringe: false,
        trimmed: true,
        bgMode: 'alpha' as const,
      },
      0,
    ),
    id,
    name: id,
    lastUsedAt,
    savedAt,
  });

  it('载入后按导入时间排序（最近导入的在前）', () => {
    const s = run([
      { type: 'SEALS_LOADED', seals: [mk('a', 1, 100), mk('b', 5, 300), mk('c', 3, 200)] },
    ]);
    expect(s.seals.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('再次选用只刷新使用时间，展示顺序不变（列表不能跳行）', () => {
    let s = run([
      { type: 'SEAL_SAVED', seal: mk('a', 1, 100) },
      { type: 'SEAL_SAVED', seal: mk('b', 2, 200) },
      { type: 'SEAL_SAVED', seal: mk('c', 3, 300) },
    ]);
    expect(s.seals.map((x) => x.id)).toEqual(['c', 'b', 'a']);
    s = reducer(s, { type: 'SEAL_SAVED', seal: mk('a', 999, 100) });
    expect(s.seals.map((x) => x.id)).toEqual(['c', 'b', 'a']);
    expect(s.seals.find((x) => x.id === 'a')?.lastUsedAt).toBe(999);
  });

  it('保存同一枚章不产生重复条目', () => {
    let s = run([{ type: 'SEAL_SAVED', seal: mk('a', 1) }]);
    s = reducer(s, { type: 'SEAL_SAVED', seal: mk('a', 9) });
    expect(s.seals).toHaveLength(1);
    expect(s.seals[0].lastUsedAt).toBe(9);
  });

  it('删除单条与批量删除', () => {
    let s = run([
      { type: 'SEAL_SAVED', seal: mk('a', 1) },
      { type: 'SEAL_SAVED', seal: mk('b', 2) },
      { type: 'SEAL_SAVED', seal: mk('c', 3) },
    ]);
    s = reducer(s, { type: 'SEALS_DELETED', ids: ['a', 'c'] });
    expect(s.seals.map((x) => x.id)).toEqual(['b']);
  });

  it('换文档不会清掉印章库', () => {
    const s = run([{ type: 'SEAL_SAVED', seal: mk('a', 1) }, { type: 'LOAD_PDF' }]);
    expect(s.seals).toHaveLength(1);
    expect(s.stamps).toEqual([]);
  });
});

