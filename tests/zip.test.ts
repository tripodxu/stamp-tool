import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { makeZip } from '../src/lib/zip';
import { crc32 } from '../src/lib/png';

/**
 * 不引第三方库解 ZIP：自己按格式读回来。
 * 这样测试同时验证了「写出的头字段正确」——用同一个库读写会一起错。
 * 外部工具能不能打开，交给 scripts/acceptance-batch.py（python zipfile）。
 */

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

/** makeZip 现在返回 Blob（省整包复制）；测试里读回字节来按格式检查。 */
const zipBytes = async (entries: Parameters<typeof makeZip>[0]): Promise<Uint8Array> =>
  new Uint8Array(await (await makeZip(entries)).arrayBuffer());

interface Entry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  usize: number;
  content: Uint8Array;
}

function readZip(zip: Uint8Array): Entry[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  let p = dv.getUint32(eocd + 16, true);
  expect(p + cdSize).toBe(eocd);

  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50);
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));

    expect(dv.getUint32(localOff, true)).toBe(0x04034b50);
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataAt = localOff + 30 + lNameLen + lExtraLen;
    const data = zip.subarray(dataAt, dataAt + csize);
    out.push({
      name,
      flags,
      method,
      crc,
      usize,
      content: method === 8 ? new Uint8Array(inflateRawSync(data)) : data,
    });

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('makeZip', () => {
  it('单个条目能原样读回来（CRC 与长度都对得上）', async () => {
    const content = bytes('hello 印章');
    const entries = readZip(await zipBytes([{ name: 'a.pdf', bytes: content }]));
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('a.pdf');
    expect(entries[0].content).toEqual(content);
    expect(entries[0].usize).toBe(content.length);
    expect(entries[0].crc).toBe(crc32(content));
  });

  it('中文文件名带 UTF-8 标志位（位 11）', async () => {
    const entries = readZip(await zipBytes([{ name: '合同-已盖章.pdf', bytes: bytes('x') }]));
    expect(entries[0].name).toBe('合同-已盖章.pdf');
    expect(entries[0].flags & 0x0800).toBe(0x0800);
  });

  it('多份文件按顺序装进去', async () => {
    const list = ['一.pdf', '二.pdf', '三.pdf'].map((name, i) => ({
      name,
      bytes: bytes(`内容${i}`.repeat(50)),
    }));
    const entries = readZip(await zipBytes(list));
    expect(entries.map((e) => e.name)).toEqual(['一.pdf', '二.pdf', '三.pdf']);
    entries.forEach((e, i) => {
      expect(new TextDecoder().decode(e.content)).toBe(`内容${i}`.repeat(50));
    });
  });

  it('重名自动加序号，不互相覆盖', async () => {
    const entries = readZip(
      await zipBytes([
        { name: 'x.pdf', bytes: bytes('1') },
        { name: 'x.pdf', bytes: bytes('2') },
        { name: 'x.pdf', bytes: bytes('3') },
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual(['x.pdf', 'x (2).pdf', 'x (3).pdf']);
  });

  it('文件名里的路径分隔符被拍平（不许解压到别处）', async () => {
    const entries = readZip(
      await zipBytes([{ name: '../../etc/a\\b.pdf', bytes: bytes('x') }]),
    );
    // 分隔符变下划线，开头那串点也被去掉（'.._.._etc_a_b.pdf' → '_.._etc_a_b.pdf'）
    expect(entries[0].name).toBe('_.._etc_a_b.pdf');
    expect(entries[0].name).not.toContain('/');
    expect(entries[0].name).not.toContain('\\');
  });

  it('压不小的内容退回 store（method 0），内容仍然正确', async () => {
    // 伪随机字节：deflate 之后只会更大（xorshift32，用 Math.imul 避免精度丢失）
    const noise = new Uint8Array(4096);
    let s = 0x9e3779b9;
    for (let i = 0; i < noise.length; i++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      noise[i] = s & 0xff;
    }
    const entries = readZip(await zipBytes([{ name: 'noise.bin', bytes: noise }]));
    expect(entries[0].method).toBe(0);
    expect(entries[0].content).toEqual(noise);
  });

  it('compress: false 直接 store（跳过对 PDF 白做的 deflate），内容原样', async () => {
    // 这段内容本来能压小——用 compress:false 强制跳过尝试，
    // 断言 method 为 0 且字节原样（批量导出走的就是这条路）
    const compressible = bytes('能压小的重复内容'.repeat(100));
    const entries = readZip(await zipBytes([{ name: 'a.pdf', bytes: compressible, compress: false }]));
    expect(entries[0].method).toBe(0);
    expect(entries[0].content).toEqual(compressible);
  });

  it('没有文件时报错', async () => {
    await expect(makeZip([])).rejects.toThrow('没有可打包的文件');
  });
});
