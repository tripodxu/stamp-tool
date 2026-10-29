/**
 * 极简 PNG 编码器（8 位 RGBA、无隔行、单 IDAT）。
 *
 * 为什么不直接用 canvas.toBlob —— canvas 内部按**预乘 alpha** 存像素，
 * α=0 的颜色一律存成 (0,0,0)。实测：putImageData 写入 (255,255,255,0)，
 * 读回来与编码进 PNG 的都是 (0,0,0,0)。于是导出 PDF 时透明区是纯黑，
 * 规范阅读器按 /SMask 合成看不见它，**忽略 /SMask 的阅读器却把它当实色
 * 画出来**——这就是「预览正常、导出后印章周围一圈黑框」的成因。
 *
 * 想让透明区是白的，只能自己写字节。zlib 交给平台的
 * CompressionStream('deflate')：它的输出正是 PNG 需要的 zlib(RFC1950) 包装。
 *
 * 滤波器用固定的「第一行 None、其余 Up」：照片类内容做行间差分后能压得
 * 小很多，而实现只有一行。
 */

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 一个完整的 PNG 块：长度 + 类型 + 数据 + CRC。 */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * 不压缩的 zlib 流（deflate stored blocks）。
 *
 * 微信旧内核 / 老 iOS WKWebView 没有 CompressionStream。没有这条兜底，
 * 用户能正常预览、一点导出却报「CompressionStream is not defined」——
 * 这是移动端最常见的导出失败原因之一。体积大一点，但文件一定能出来。
 */
function storedZlib(bytes: Uint8Array): Uint8Array {
  const MAX = 0xffff;
  const blocks = Math.max(1, Math.ceil(bytes.length / MAX));
  const out = new Uint8Array(2 + bytes.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < bytes.length; i += MAX) {
    const len = Math.min(MAX, bytes.length - i);
    out[o++] = i + len >= bytes.length ? 1 : 0; // BFINAL
    out[o++] = len & 0xff;
    out[o++] = (len >>> 8) & 0xff;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(bytes.subarray(i, i + len), o);
    o += len;
  }
  const ad = adler32(bytes);
  out[o++] = (ad >>> 24) & 0xff;
  out[o++] = (ad >>> 16) & 0xff;
  out[o++] = (ad >>> 8) & 0xff;
  out[o++] = ad & 0xff;
  return out.subarray(0, o);
}

/** zlib 包装的 deflate（PNG 的 IDAT 要的正是这个格式）。 */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'function') {
    try {
      const stream = new Blob([bytes as BlobPart])
        .stream()
        .pipeThrough(new CompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // 某些 WebView 暴露了 CompressionStream 但实现不可用：退回 stored
    }
  }
  return storedZlib(bytes);
}

/** 把 RGBA 像素编码成 PNG。宽高必须与 data 的长度自洽。 */
export async function encodePngRgba(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  if (width <= 0 || height <= 0) throw new Error('PNG 尺寸无效');
  if (data.length < width * height * 4) throw new Error('PNG 像素数据长度与尺寸不符');

  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    const src = y * stride;
    if (y === 0) {
      raw[dst] = 0; // None
      raw.set(data.subarray(src, src + stride), dst + 1);
    } else {
      raw[dst] = 2; // Up：与上一行逐字节做差
      const prev = src - stride;
      for (let i = 0; i < stride; i++) {
        raw[dst + 1 + i] = (data[src + i] - data[prev + i]) & 0xff;
      }
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 6 = RGBA
  ihdr[10] = 0; // 压缩方式（只有 0）
  ihdr[11] = 0; // 滤波方式（只有 0）
  ihdr[12] = 0; // 非隔行

  const parts = [
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    png.set(p, offset);
    offset += p.length;
  }
  return png;
}
