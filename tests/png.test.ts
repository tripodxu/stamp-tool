import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';
import { encodePngRgba } from '../src/lib/png';
import { bleachTransparent } from '../src/lib/sealPixels';

/**
 * 回归：「预览正常，导出后印章周围一圈黑框」。
 *
 * 成因不在 PDF 结构（/SMask 一切正常），而在**透明区的颜色**：canvas 按预乘
 * alpha 存像素，α=0 的颜色一律是 (0,0,0)，canvas.toBlob 编出来的 PNG 透明区
 * 就是纯黑；导出的 PDF 里那块颜色也是黑的。规范阅读器按 /SMask 合成、看不见，
 * 忽略 /SMask 的阅读器把它当实色画出来 → 黑框。
 *
 * 所以 PNG 改成自己编码（src/lib/png.ts），并在编码前把 α=0 刷白。这个测试
 * 直接把「导出的 PDF 里透明区是什么颜色」断言下来——它是这个 bug 的分水岭。
 */

const W = 12;
const H = 12;

/** 一张 canvas 风格的图：透明区是黑的（就像 canvas 编出来那样），中间一块红墨。 */
function canvasLike(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 4; y < 8; y++) {
    for (let x = 4; x < 8; x++) {
      const i = (y * W + x) * 4;
      d[i] = 230; d[i + 1] = 0; d[i + 2] = 18; d[i + 3] = 255;
    }
  }
  return d;
}

/** 取出嵌入图像的采样：pdf-lib 会把 PNG 拆成「颜色图 + /SMask」。 */
async function embedAndRead(png: Uint8Array) {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  await doc.flush();

  const stream = doc.context.lookup(image.ref) as PDFRawStream;
  const maskRef = stream.dict.get(PDFName.of('SMask')) as PDFRef | undefined;
  const mask = maskRef ? (doc.context.lookup(maskRef) as PDFRawStream) : null;

  const samples = (s: PDFRawStream, bpp: number) => {
    const raw = Buffer.from(s.contents);
    const data = raw[0] === 0x78 ? inflateSync(raw) : raw; // FlateDecode
    return { data, bpp };
  };
  const pixels = W * H;
  const color = samples(stream, stream.contents.length / pixels || 3);
  const alpha = mask ? samples(mask, mask.contents.length / pixels || 1) : null;
  return { color, alpha, width: image.width, height: image.height };
}

describe('encodePngRgba：自己写 PNG（canvas 会把透明区的颜色丢掉）', () => {
  it('编出来的字节是合法 PNG，pdf-lib 能解码，宽高一致', async () => {
    const png = await encodePngRgba(canvasLike(), W, H);
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const { width, height } = await embedAndRead(png);
    expect([width, height]).toEqual([W, H]);
  });

  it('透明区在 PDF 里是白的（忽略 /SMask 的阅读器才不会画出黑框）', async () => {
    const d = canvasLike();
    bleachTransparent(d); // 透明区刷白——这是修复的关键一步
    const png = await encodePngRgba(d, W, H);
    const { color, alpha } = await embedAndRead(png);

    expect(alpha, '确实带软掩膜').not.toBeNull();
    const cpp = color.data.length / (W * H);
    const app = alpha!.data.length / (W * H);
    expect(cpp).toBeGreaterThanOrEqual(3);
    expect(app).toBe(1);

    // 角落（α=0）必须是白的
    const corner = [0, W - 1, (H - 1) * W, W * H - 1];
    for (const i of corner) {
      expect(alpha!.data[i], `像素 ${i} 的 alpha`).toBe(0);
      const rgb = Array.from(color.data.slice(i * cpp, i * cpp + 3));
      expect(rgb, `像素 ${i} 的颜色（应该已漂白）`).toEqual([255, 255, 255]);
    }

    // 中间的红墨必须原样保留
    const ink = 5 * W + 5;
    expect(alpha!.data[ink]).toBe(255);
    expect(Array.from(color.data.slice(ink * cpp, ink * cpp + 3))).toEqual([230, 0, 18]);
  });

  it('不漂白就会是黑的 —— 说明这个 bug 真实存在（对照）', async () => {
    const png = await encodePngRgba(canvasLike(), W, H);
    const { color } = await embedAndRead(png);
    const cpp = color.data.length / (W * H);
    expect(Array.from(color.data.slice(0, 3))).toEqual([0, 0, 0]);
    expect(cpp).toBeGreaterThanOrEqual(3);
  });
});
