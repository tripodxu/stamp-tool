import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFRef, degrees } from 'pdf-lib';
import type { PageFrame, Stamp } from './types';
import { frameFromPage, stampPlacement } from './pageSpace';

/**
 * 导出。
 *
 * 关键点：不重新渲染文档。直接在原 PDF 的页面内容流上追加一次
 * drawImage，文字仍是文字、字体仍是原字体、矢量零损失。
 * 印章嵌入的是原始 PNG 字节（Flate 无损），因此导出质量恒 ≥ 预览质量。
 *
 * 关于混合模式：印油物理上是减色材料，理想模式是 multiply，但 PDF 需要
 * 向内容流注入 /BM /Multiply 的 ExtGState。这里利用一个等价关系绕开：
 *   alpha 合成  C = α·S + (1−α)·B
 *   正片叠底    C = α·S + (1−α)·B·D/255
 * 当底图 D = 白色时两式完全相同，而绝大多数盖章场景底即白纸。
 *
 * 坐标换算全部交给 pageSpace.ts —— 这里是唯一会把「预览坐标」当「用户坐标」
 * 用错的地方，历史上正是这么错的（见该文件顶部注释）。
 */

export interface ExportOptions {
  /** 不透明度阈值：低于此值的印章视为隐藏，不写入 */
  minOpacity?: number;
  /**
   * 每页的几何参照，**必须来自 pdf.js**（与预览同源，见 PdfHandle.pages）。
   *
   * 不传的话会退回 pdf-lib 的 CropBox + /Rotate：那套在「无旋转、无裁切偏移」
   * 的普通页面上结果相同，但拿不到 /UserUnit，也不含页树继承，
   * 只适合脚本/测试单独调用导出层时兜底。
   */
  frames?: PageFrame[];
  /**
   * 嵌入前对 PNG 字节做一次规范化（可选）。导出侧注入 seal.reencodeSealPng：
   * 印章库里可能存着历史版本的字节（canvas 编的，透明区是纯黑），
   * 不重编一遍，老章导出后仍会在忽略 /SMask 的阅读器里显示成黑框。
   * 测试里不传，保持导出层与 DOM 无关。
   */
  prepareImage?: (pngBytes: Uint8Array) => Promise<Uint8Array>;
}

/** 载入待盖章的文档。加密文件在这里抛错，由调用方翻译成中文提示。 */
export async function openPdfDoc(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, {
    // 保留原有结构，失败时给出可读原因（加密 PDF 会在这里抛错）
    ignoreEncryption: false,
    updateMetadata: false,
  });
}

/**
 * 是否已存在数字签名。
 *
 * 追加内容会让已生效的数字签名失效（ByteRange 不再覆盖新内容），
 * 接收方验签会直接报错。所以设计要求导出前必须先问一句。
 *
 * 检测两处：页面的 /Annots（可见的签名控件）与 AcroForm /Fields（字段定义），
 * 任一存在 /Sig 即判定为已签名。
 */
export function hasSignatureField(doc: PDFDocument): boolean {
  const SIG = PDFName.of('Sig');
  const SUBTYPE = PDFName.of('Subtype');
  const FT = PDFName.of('FT');

  /** /Annots 数组里存的可能是间接引用（PDFRef），也可能直接就是字典 */
  const deref = (o: PDFObject): PDFObject | undefined => {
    try {
      return o instanceof PDFRef ? doc.context.lookup(o) : o;
    } catch {
      return undefined; // 悬空引用：当作没有
    }
  };

  // ① 页面 /Annots 里的可见签名控件
  for (const page of doc.getPages()) {
    try {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i++) {
        const obj = deref(annots.get(i));
        if (obj instanceof PDFDict && obj.get(SUBTYPE) === SIG) return true;
      }
    } catch {
      // 少数 PDF 的 Annots 结构异常，忽略即可，不该因此拦下导出
    }
  }

  // ② AcroForm /Fields 里的字段定义
  try {
    const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray);
    for (let i = 0; fields && i < fields.size(); i++) {
      // lookupMaybe 会自动解开 PDFRef
      const field = fields.lookupMaybe(i, PDFDict);
      if (field?.get(FT) === SIG) return true;
    }
  } catch {
    // 同上：结构异常不等于有签名
  }
  return false;
}

/** 把全部印章写入已载入的文档并序列化。 */
export async function stampDocument(
  pdfDoc: PDFDocument,
  stamps: Stamp[],
  opts: ExportOptions = {},
): Promise<Uint8Array> {
  const { minOpacity = 0.01, frames, prepareImage } = opts;

  // 按原始 PNG 字节去重，同一枚印章在多页复用只嵌入一次
  const embedded = new Map<string, Awaited<ReturnType<typeof pdfDoc.embedPng>>>();
  for (const stamp of stamps) {
    if (stamp.opacity < minOpacity) continue;
    const key = keyOf(stamp.pngBytes);
    if (embedded.has(key)) continue;
    const bytes = prepareImage ? await prepareImage(stamp.pngBytes) : stamp.pngBytes;
    embedded.set(key, await pdfDoc.embedPng(bytes));
  }

  for (const stamp of stamps) {
    if (stamp.opacity < minOpacity) continue;
    const page = pdfDoc.getPage(stamp.pageIndex);
    const image = embedded.get(keyOf(stamp.pngBytes))!;

    // 显示空间（预览）→ 用户空间（PDF）。旋转轴、页面 /Rotate、裁切框偏移
    // 全部在 stampPlacement 里处理，这里只负责把结果交给 pdf-lib。
    //
    // 传了 frames 却缺这一页，说明调用方拿错了页面几何——这种情况必须炸，
    // 不能悄悄退回 pdf-lib 的 MediaBox：那正是「章盖偏 43mm」的成因。
    const frame = frames ? frames[stamp.pageIndex] : frameFromPage(page);
    if (!frame) {
      throw new Error(
        `导出缺少第 ${stamp.pageIndex + 1} 页的页面几何（frames），拒绝在参照系不明时写入印章`,
      );
    }
    const { x, y, rotationDeg } = stampPlacement(stamp, frame);

    page.drawImage(image, {
      x,
      y,
      width: stamp.widthPt,
      height: stamp.heightPt,
      rotate: degrees(rotationDeg),
      opacity: stamp.opacity,
    });
  }

  return pdfDoc.save();
}

/** 用字节内容做 key（同一枚章在多页复用同一嵌入对象）。 */
function keyOf(bytes: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return `${bytes.length}:${h >>> 0}`;
}

export function downloadBlob(bytes: Uint8Array, fileName: string) {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
