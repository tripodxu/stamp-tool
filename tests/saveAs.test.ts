import { describe, expect, it, vi } from 'vitest';
import { saveAsPicker, saveBytesAs, type SaveAsPicker } from '../src/lib/saveAs';

/** 造一个假的 showSaveFilePicker：记录收到的选项，写入的字节也留下来。 */
function fakePicker(behaviour: { name?: string; fail?: string } = {}) {
  const written: BlobPart[] = [];
  let closed = false;
  const picker = vi.fn(async () => ({
    name: behaviour.name,
    createWritable: async () => ({
      write: async (d: BlobPart) => {
        written.push(d);
      },
      close: async () => {
        closed = true;
      },
    }),
  })) as unknown as SaveAsPicker;

  if (behaviour.fail) {
    const err = new Error(behaviour.fail);
    err.name = behaviour.fail;
    (picker as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
  }
  return { picker, written, isClosed: () => closed };
}

const BYTES = new Uint8Array([1, 2, 3, 4]);
const OPTS = { mime: 'application/pdf', description: 'PDF 文件', ext: '.pdf' };

describe('「另存为」', () => {
  it('环境没有 picker 时返回 unsupported（调用方据此回退下载）', async () => {
    const res = await saveBytesAs(BYTES, 'a.pdf', { ...OPTS, scope: {} });
    expect(res.status).toBe('unsupported');
    expect(saveAsPicker({})).toBeNull();
  });

  it('用户取消：AbortError 归为 cancelled，不当作错误抛出', async () => {
    const { picker } = fakePicker({ fail: 'AbortError' });
    const res = await saveBytesAs(BYTES, 'a.pdf', { ...OPTS, picker });
    expect(res.status).toBe('cancelled');
  });

  it('没有用户手势（SecurityError）归为 unsupported', async () => {
    const { picker } = fakePicker({ fail: 'SecurityError' });
    expect((await saveBytesAs(BYTES, 'a.pdf', { ...OPTS, picker })).status).toBe(
      'unsupported',
    );
    const denied = fakePicker({ fail: 'NotAllowedError' });
    expect((await saveBytesAs(BYTES, 'a.pdf', { ...OPTS, picker: denied.picker })).status).toBe(
      'unsupported',
    );
  });

  it('其它错误照样抛出，不能被当成「不支持」悄悄吞掉', async () => {
    const { picker } = fakePicker({ fail: 'QuotaExceededError' });
    await expect(saveBytesAs(BYTES, 'a.pdf', { ...OPTS, picker })).rejects.toThrow(
      'QuotaExceededError',
    );
  });

  it('写入成功：字节进了文件、close 被调用、返回用户选的名字', async () => {
    const { picker, written, isClosed } = fakePicker({ name: '合同-已盖章.pdf' });
    const res = await saveBytesAs(BYTES, 'a.pdf', { ...OPTS, picker });
    expect(res).toEqual({ status: 'saved', name: '合同-已盖章.pdf' });
    expect(written).toHaveLength(1);
    expect(isClosed()).toBe(true);
  });

  it('建议文件名与类型过滤器要传给对话框（否则弹出的名字是 untitled）', async () => {
    const { picker } = fakePicker({ name: 'x.pdf' });
    await saveBytesAs(BYTES, '合同-已盖章.pdf', { ...OPTS, picker });
    expect(picker).toHaveBeenCalledWith({
      suggestedName: '合同-已盖章.pdf',
      types: [{ description: 'PDF 文件', accept: { 'application/pdf': ['.pdf'] } }],
    });
  });

  it('系统没给文件名时退回建议名', async () => {
    const { picker } = fakePicker();
    const res = await saveBytesAs(BYTES, 'a-已盖章.pdf', { ...OPTS, picker });
    expect(res).toEqual({ status: 'saved', name: 'a-已盖章.pdf' });
  });
});
