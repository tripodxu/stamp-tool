import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PageInfo } from './types';

// Vite 下 pdf.js 的头号报错点：worker 必须打包为静态资源并显式指路
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * cMap 与标准字体目录必须一起指路。
 *
 * 少了 cMapUrl，遇到 PDF 内嵌 CJK 子集字体时会报
 * "translateFont failed / Ensure that the cMapUrl API parameter is provided"，
 * 结果是部分汉字渲染成空白——文件能打开，但看起来像缺字。
 *
 * 这两个目录由 vite.config.ts 的 pdfjs-assets 插件复制到 dist 根目录。
 */
const ASSET_BASE = new URL('./', window.location.href).href;
const CMAP_URL = new URL('cmaps/', ASSET_BASE).href;
const FONTS_URL = new URL('standard_fonts/', ASSET_BASE).href;

export type PdfHandle = {
  doc: PDFDocumentProxy;
  pages: PageInfo[];
  fileName: string;
  /**
   * 释放文档。
   *
   * pdf.js v5 起 `destroy()` 从 PDFDocumentProxy 移到了 PDFDocumentLoadingTask，
   * 而 v6 的 proxy 只剩 `cleanup()`——不释放 loadingTask，worker 会一直持有旧文档，
   * 连续换几个 PDF 后内存翻倍。
   */
  destroy: () => void;
};

const isPasswordError = (e: unknown) =>
  e instanceof Error && /password/i.test(e.name + ' ' + e.message);

/**
 * 读取页面几何（pt，scale=1）。
 *
 * 这里同时采集裁切框、/Rotate 与 /UserUnit，因为导出层必须拿到
 * 与预览完全一致的参照系：pdf.js 的 getViewport() 应用了旋转并以裁切框为界，
 * 而 pdf-lib 只认 MediaBox、不认旋转。少采一个，导出就会偏——见 pageSpace.ts。
 */
async function readPages(doc: PDFDocumentProxy): Promise<PageInfo[]> {
  // 并行 getPage：几百页的文档串行等 worker 一次一个来回，肉眼可见地慢；
  // worker 侧本就会排队处理，这里只是让往返重叠起来。
  return Promise.all(
    Array.from({ length: doc.numPages }, async (_, i) => {
      const page = await doc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      const view = page.view;
      const info: PageInfo = {
        // 显示空间尺寸 = 预览里那张纸的宽高
        wPt: vp.width,
        hPt: vp.height,
        // 复制一份：pdf.js 内部可能复用同一个数组
        view: [view[0], view[1], view[2], view[3]],
        rotation: page.rotate,
        userUnit: page.userUnit ?? 1,
      };
      page.cleanup();
      return info;
    }),
  );
}

/**
 * 打开 PDF。
 *
 * 刻意接收**已读好的字节**而不是 File：早期版本内部 `await file.arrayBuffer()`，
 * 而调用方为了导出也得读一遍，于是 100MB 文件会在内存里躺两份 ArrayBuffer，
 * 与「按需渲染防内存溢出」的初衷相悖。
 *
 * ⚠️ pdf.js 会把传入的 buffer 转移（transfer）给 worker，ArrayBuffer 可能被
 * detach。因此调用方**不得**再复用这块内存——需要原始数据请留住 File 句柄，
 * 用时重读。
 */
export async function loadPdf(
  bytes: Uint8Array,
  fileName: string,
): Promise<PdfHandle> {
  let doc: PDFDocumentProxy;
  let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
  try {
    loadingTask = pdfjsLib.getDocument({
      data: bytes,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: FONTS_URL,
    });
    doc = await loadingTask.promise;
  } catch (e) {
    if (isPasswordError(e)) {
      throw new Error('该 PDF 受密码保护，无法盖章。请先移除密码后再试。');
    }
    throw new Error(`无法读取 PDF：${(e as Error).message ?? e}`);
  }
  const pages = await readPages(doc);
  const task = loadingTask;
  return {
    doc,
    pages,
    fileName,
    destroy: () => {
      // destroy 已在进行时再调会抛错，这里静默吞掉
      void task?.destroy().catch(() => undefined);
    },
  };
}

/**
 * 把某页渲染到 canvas。
 * 按需渲染——架构决定编辑期不持有全量位图，避免大文件内存溢出。
 */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  zoom: number,
  signal?: AbortSignal,
): Promise<void> {
  const page: PDFPageProxy = await doc.getPage(pageNumber);
  if (signal?.aborted) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: zoom * dpr });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${page.getViewport({ scale: zoom }).width}px`;
  canvas.style.height = `${page.getViewport({ scale: zoom }).height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const task = page.render({ canvasContext: ctx, viewport, canvas });
  if (signal) {
    const onAbort = () => task.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    await task.promise;
  } catch (e) {
    if (signal?.aborted) return; // 取消导致的异常是预期的
    throw e;
  } finally {
    page.cleanup();
  }
}