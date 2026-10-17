import { crc32 } from './png';

/**
 * 极简 ZIP 写出（批量导出用）。
 *
 * 为什么不用现成的库：整条流水线只为了「把 N 个 PDF 装进一个文件」，
 * 引入 jszip（约 100KB）不值当；而 ZIP 的 **store/deflate + 中央目录** 部分
 * 非常简单，PNG 编码器那份 crc32 正好可以复用（两种格式用的是同一个 CRC-32）。
 *
 * 只实现「一次性写出」（无数据描述符、无 ZIP64）：大小在写头之前就已知，
 * 不需要流式。因此单文件/总量超过 4GB、或超过 65535 个条目会直接报错。
 */

export interface ZipEntry {
  /** 归档内的文件名（可含中文；路径分隔符会被替换成下划线） */
  name: string;
  bytes: Uint8Array;
}

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** 通用位 11：文件名是 UTF-8（不加这个，中文名在解压时会变乱码） */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export async function makeZip(entries: ZipEntry[]): Promise<Uint8Array> {
  if (entries.length === 0) throw new Error('没有可打包的文件');
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`文件太多（${entries.length} 个），一个 ZIP 最多装 ${MAX_ENTRIES} 个`);
  }

  const { time, date } = dosStamp(new Date());
  const used = new Set<string>();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = uniqueName(cleanName(entry.name), used);
    const nameBytes = new TextEncoder().encode(name);
    const raw = entry.bytes;
    const deflated = await deflateRaw(raw);
    // 压不小就存原文：PDF 本身已是压缩流，再套一层常常反而更大
    const useDeflate = deflated !== null && deflated.length < raw.length;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const body = useDeflate ? deflated! : raw;
    const crc = crc32(raw);

    if (offset + body.length > MAX_BYTES) {
      throw new Error('打包结果超过 4GB，ZIP 装不下：请分批盖章');
    }

    const header = concat([
      u32(LOCAL_SIG), u16(20), u16(FLAG_UTF8), u16(method), u16(time), u16(date),
      u32(crc), u32(body.length), u32(raw.length), u16(nameBytes.length), u16(0),
      nameBytes,
    ]);
    parts.push(header, body);
    central.push(concat([
      u32(CENTRAL_SIG), u16(20), u16(20), u16(FLAG_UTF8), u16(method), u16(time), u16(date),
      u32(crc), u32(body.length), u32(raw.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nameBytes,
    ]));
    offset += header.length + body.length;
  }

  const centralBytes = concat(central);
  const eocd = concat([
    u32(EOCD_SIG), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBytes.length), u32(offset), u16(0),
  ]);
  return concat([...parts, centralBytes, eocd]);
}

/** deflate-raw（ZIP 用的就是裸 deflate）；环境不支持时返回 null，退回 store。 */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** DOS 时间戳：ZIP 的时间字段是 1980 纪元的 16 位「日期 + 时间」。 */
function dosStamp(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** 归档内不允许出现路径（否则解压时可能写到别处） */
function cleanName(name: string): string {
  const flat = name.replace(/[\\/]+/g, '_').replace(/^[.]+/, '').trim();
  return flat || 'unnamed';
}

/** 同名文件加 (2)、(3)…… 否则解压时互相覆盖。 */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

const u16 = (v: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
};

const u32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
};

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
