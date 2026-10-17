import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_SEALS,
  clearSeals,
  contentKey,
  deleteSeal,
  findSealByInkKey,
  formatSavedAt,
  listSeals,
  patchSavedSeal,
  pickEvictions,
  putSeal,
  putSeals,
  sealRecordId,
  sortForDisplay,
  sortSeals,
  toSavedSeal,
  toSealImage,
  type SavedSeal,
} from '../src/lib/sealStore';
import type { SealImage } from '../src/lib/types';

const bytes = (...v: number[]) => new Uint8Array(v);

const sealImage = (over: Partial<SealImage> = {}): SealImage => ({
  name: '示例公章.png',
  pngBytes: bytes(1, 2, 3, 4),
  objectUrl: 'blob:fake',
  srcW: 900,
  srcH: 900,
  cropW: 880,
  cropH: 880,
  aspect: 1,
  fringeRatio: 0,
  dpiScale: 1.02,
  hadFringe: false,
  trimmed: true,
  bgMode: 'alpha',
  ...over,
});

const saved = (id: string, lastUsedAt: number): SavedSeal => ({
  ...toSavedSeal(sealImage(), 0),
  id,
  name: `${id}.png`,
  lastUsedAt,
});

beforeEach(async () => {
  await clearSeals();
});

describe('内容指纹', () => {
  it('同样的字节得到同样的 key，不同字节不同 key', () => {
    expect(contentKey(bytes(1, 2, 3))).toBe(contentKey(bytes(1, 2, 3)));
    expect(contentKey(bytes(1, 2, 3))).not.toBe(contentKey(bytes(1, 2, 4)));
    expect(contentKey(bytes(1, 2, 3))).not.toBe(contentKey(bytes(1, 2, 3, 4)));
  });
});

describe('排序与淘汰', () => {
  it('最近用过的排前面（启动自动选中用这个顺序）', () => {
    const out = sortSeals([saved('a', 10), saved('b', 30), saved('c', 20)]);
    expect(out.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('展示顺序按导入时间，点选不会让行跳动', () => {
    const list = [
      { ...saved('old', 999), savedAt: 100 },
      { ...saved('new', 1), savedAt: 300 },
      { ...saved('mid', 5), savedAt: 200 },
    ];
    expect(sortForDisplay(list).map((s) => s.id)).toEqual(['new', 'mid', 'old']);
  });

  it('超出上限时淘汰最久没用过的', () => {
    const list = Array.from({ length: MAX_SEALS + 3 }, (_, i) => saved(`s${i}`, i));
    const doomed = pickEvictions(list, MAX_SEALS);
    expect(doomed).toHaveLength(3);
    // 顺序无关，关键是被淘汰的正是最久没用过的那三枚
    expect([...doomed].sort()).toEqual(['s0', 's1', 's2']);
    expect(pickEvictions(list.slice(0, 5), MAX_SEALS)).toEqual([]);
  });
});

describe('库记录 ↔ 运行时印章', () => {
  it('往返保留全部展示与导出所需字段', () => {
    const seal = sealImage({ bgMode: 'paper' });
    const s = toSavedSeal(seal, 1234);
    expect(s.id).toBe(contentKey(seal.pngBytes));
    expect(s.savedAt).toBe(1234);
    expect(s.lastUsedAt).toBe(1234);
    const back = toSealImage(s, 'blob:new');
    expect(back.cropW).toBe(seal.cropW);
    expect(back.bgMode).toBe('paper');
    expect(back.objectUrl).toBe('blob:new');
    expect(Array.from(back.pngBytes)).toEqual(Array.from(seal.pngBytes));
  });
});

describe('IndexedDB 存取', () => {
  it('存进去能读出来，按最近使用排序', async () => {
    await putSeal(saved('a', 10));
    await putSeal(saved('b', 20));
    const list = await listSeals();
    expect(list.map((s) => s.id)).toEqual(['b', 'a']);
    expect(list[0].pngBytes).toBeInstanceOf(Uint8Array);
  });

  it('同一枚章重复导入只留一条，刷新使用时间', async () => {
    const first = toSavedSeal(sealImage(), 100);
    await putSeal(first);
    const again = { ...first, lastUsedAt: 999 };
    await putSeal(again);
    const list = await listSeals();
    expect(list).toHaveLength(1);
    expect(list[0].lastUsedAt).toBe(999);
  });

  it('批量写入与删除', async () => {
    await putSeals([saved('a', 1), saved('b', 2)]);
    expect(await listSeals()).toHaveLength(2);
    await deleteSeal('a');
    expect((await listSeals()).map((s) => s.id)).toEqual(['b']);
  });

  it('清空后为空', async () => {
    await putSeals([saved('a', 1), saved('b', 2)]);
    await clearSeals();
    expect(await listSeals()).toEqual([]);
  });
});

describe('记录 id 与改名（源文件指纹去重的那一套）', () => {
  it('sealRecordId 优先源文件指纹：同一张原图重新处理过也是同一条记录', () => {
    const a = sealImage({ sourceKey: 'src-1' });
    const b = sealImage({ sourceKey: 'src-1', pngBytes: bytes(9, 9, 9, 9) });
    expect(sealRecordId(a)).toBe('src-1');
    expect(sealRecordId(b)).toBe(sealRecordId(a));
  });

  it('没有源文件指纹时退回处理后字节（老记录也能对上）', () => {
    const s = sealImage();
    expect(sealRecordId(s)).toBe(contentKey(s.pngBytes));
  });

  it('toSavedSeal 把源指纹与默认参数一起存下来', () => {
    const s = toSavedSeal(sealImage({ sourceKey: 'src-1', defaults: { widthMm: 42, rotationDeg: -8, opacity: 1 } }), 5);
    expect(s.id).toBe('src-1');
    expect(s.sourceKey).toBe('src-1');
    expect(s.defaults?.widthMm).toBe(42);
  });

  it('findSealByInkKey 按「正在用的这份图」找回库里的记录', () => {
    const rec = toSavedSeal(sealImage(), 0);
    expect(findSealByInkKey([rec], contentKey(rec.pngBytes))?.id).toBe(rec.id);
    expect(findSealByInkKey([rec], contentKey(bytes(7, 7)))).toBeNull();
  });

  it('patchSavedSeal 只改命中的那条，其余原样返回', () => {
    const list = [saved('a', 1), saved('b', 2)];
    const out = patchSavedSeal(list, 'b', { name: '合同章.png' });
    expect(out.find((s) => s.id === 'b')?.name).toBe('合同章.png');
    expect(out.find((s) => s.id === 'a')?.name).toBe('a.png');
    expect(patchSavedSeal(list, 'zzz', { name: 'x' })).toEqual(list);
  });

  it('改名能落库（重开一次仍在）', async () => {
    const rec = saved('a', 1);
    await putSeal(rec);
    await putSeal({ ...rec, name: '合同专用章.png' });
    const list = await listSeals();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('合同专用章.png');
  });

  it('formatSavedAt 是「MM-DD HH:mm」', () => {
    expect(formatSavedAt(new Date(2026, 9, 17, 9, 5).getTime())).toBe('10-17 09:05');
  });
});

