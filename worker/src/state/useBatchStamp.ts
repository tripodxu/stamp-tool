import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageInfo } from '../lib/types';
import { loadPdf } from '../lib/pdfReader';
import { downloadBytes, hasSignatureField, openPdfDoc, stampDocument } from '../lib/exporter';
import { reencodeSealPng } from '../lib/seal';
import { shareFile } from '../lib/saveAs';
import { isMobileBrowser, isWeChatBrowser } from '../lib/platform';
import {
  batchStamps,
  pageIndices,
  stampedName,
  zipName,
  type BatchPlacement,
  type BatchSeed,
  type PageSpec,
} from '../lib/batch';
import { makeZip, type ZipEntry } from '../lib/zip';

/**
 * 批量盖章的 I/O 编排（规则在 lib/batch.ts，这里只管读文件、盖章、打包、下载）。
 *
 * 三条刻意的行为：
 *  ① 逐个文件独立处理，**一个失败不影响其余的**——结果逐条列给用户看；
 *  ② 含数字签名的文件直接跳过并说明原因（盖章会让签名失效，不能默默改掉）；
 *  ③ 全部产物装进**一个** ZIP 下载。不能逐个下载：Chromium 会把同一会话里
 *     第二次之后的下载当成「自动下载」拦掉，用户只会收到第一个文件。
 */

export interface BatchFile {
  id: string;
  file: File;
}

export interface BatchOutcome {
  fileName: string;
  outName: string;
  /** 实际盖上的页数 */
  stampedPages: number;
  ok: boolean;
  reason?: string;
}

export interface BatchInput {
  files: BatchFile[];
  selector: PageSpec;
  placement: BatchPlacement;
  seed: BatchSeed;
  origin: { xPt: number; yPt: number };
}

export function useBatchStamp() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [label, setLabel] = useState('');
  const [outcomes, setOutcomes] = useState<BatchOutcome[]>([]);
  const [zipSaved, setZipSaved] = useState<string | null>(null);
  /** 交付 ZIP 的补充说明：微信 / 分享不可用时不能谎报「已保存到下载」 */
  const [zipNote, setZipNote] = useState<string | null>(null);
  /**
   * 手机：跑完先存住 ZIP，等用户点「保存 / 分享」再交付。
   *
   * 为什么不跑完自动分享：navigator.share 要求 transient user activation
   * （约 5 秒窗口）。批量一跑几十秒，「开始」那次点击早就过期，share 会被
   * 拒绝并落入 downloadBlob 回退——而 Android WebView 没有下载器，
   * 结果就是 UI 说「已保存」文件却哪儿都没有。改成按钮触发 = 全新手势。
   */
  const [zipPending, setZipPending] = useState<{ name: string; blob: Blob } | null>(null);
  /** 组件还在不在。卸载后置 false：循环继续跑完（下载仍会触发），但不再碰 state。 */
  const alive = useRef(true);
  /** 用户点过「取消」。循环在每个文件边界检查；已完成的仍会打包交付。 */
  const cancelRequested = useRef(false);

  // alive 曾经是死守卫（从不置 false）。现在接上卸载清理：
  // Esc/路由切换把面板卸掉后，循环不该再对已卸载组件刷状态。
  useEffect(() => () => { alive.current = false; }, []);

  const reset = useCallback(() => {
    cancelRequested.current = false;
    setBusy(false);
    setDone(0);
    setTotal(0);
    setLabel('');
    setOutcomes([]);
    setZipSaved(null);
    setZipNote(null);
    setZipPending(null);
  }, []);

  /** 请求取消：当前这份文件处理完就停，已完成的部分照常打包交付。 */
  const cancel = useCallback(() => {
    cancelRequested.current = true;
    setLabel('正在取消（当前这份处理完就停）…');
  }, []);

  /** 手机：把跑好的 ZIP 交给用户（按钮触发，手势新鲜）。 */
  const deliverZip = useCallback(async () => {
    const z = zipPending;
    if (!z) return;

    // 微信内置浏览器不支持文件分享，而且经常拦下载：用新标签打开，
    // 并明确告诉用户「没反应就去系统浏览器」。不能谎报已保存。
    if (isWeChatBrowser()) {
      downloadBytes(z.blob, z.name, 'application/zip', { newTab: true });
      setZipPending(null);
      setZipSaved(z.name);
      setZipNote('微信内可能无法直接保存压缩包。若没有反应，请点右上角 ··· → 在浏览器打开后重试。');
      return;
    }

    const res = await shareFile(z.blob, z.name, 'application/zip');
    if (res.status === 'shared') {
      setZipPending(null);
      setZipSaved(z.name);
      setZipNote(null);
      return;
    }
    if (res.status === 'cancelled') return; // 用户在分享面板上取消，静默
    // 环境不支持分享：退回下载并透出原因（Android WebView 上下载仍会静默，
    // 但至少提示里写明发生了什么，不谎报成功）
    downloadBytes(z.blob, z.name, 'application/zip', { newTab: isMobileBrowser() });
    setZipPending(null);
    setZipSaved(z.name);
    setZipNote(`分享不可用（${res.reason ?? '原因未知'}），已尝试下载。若没有反应，请换用系统浏览器。`);
  }, [zipPending]);

  const run = useCallback(async (input: BatchInput) => {
    const { files, selector, placement, seed, origin } = input;
    if (files.length === 0) return;

    alive.current = true;
    cancelRequested.current = false;
    setBusy(true);
    setDone(0);
    setTotal(files.length);
    setOutcomes([]);
    setZipSaved(null);
    setZipNote(null);

    const entries: ZipEntry[] = [];
    const results: BatchOutcome[] = [];

    for (let i = 0; i < files.length; i++) {
      if (cancelRequested.current) break;
      const { file } = files[i];
      if (alive.current) {
        setLabel(`正在处理 ${i + 1}/${files.length}：${file.name}`);
        // 交还一次事件循环：否则这一整轮同步 I/O 会让上面的进度永远画不出来
        await new Promise((r) => setTimeout(r, 0));
      }

      const outName = stampedName(file.name);
      try {
        // 页面几何要走 pdf.js（它才是预览的参照系），盖章要走 pdf-lib。
        // 文件只读一次盘：pdf.js 会把传入的 buffer 转移走，所以给它一份
        // slice 拷贝，原件留给 pdf-lib——比读两次盘省一半 I/O。
        const bytes = new Uint8Array(await file.arrayBuffer());
        const probe = await loadPdf(bytes.slice(), file.name);
        let pages: PageInfo[];
        try {
          pages = probe.pages;
        } finally {
          probe.destroy();
        }

        const indices = pageIndices(selector, pages.length);
        if (indices.length === 0) {
          results.push({
            fileName: file.name,
            outName,
            stampedPages: 0,
            ok: false,
            reason: `指定的页码超出这份文件的页数（共 ${pages.length} 页）`,
          });
          continue;
        }

        const doc = await openPdfDoc(bytes);
        if (hasSignatureField(doc)) {
          results.push({
            fileName: file.name,
            outName,
            stampedPages: 0,
            ok: false,
            reason: '这份文件带数字签名，盖章会让签名失效，已跳过',
          });
          continue;
        }

        const stamps = batchStamps({
          seed,
          origin,
          placement,
          pages,
          selector,
          idPrefix: `batch${i}`,
        });
        const out = await stampDocument(doc, stamps, {
          frames: pages,
          prepareImage: reencodeSealPng,
        });
        entries.push({ name: outName, bytes: out, compress: false });
        results.push({ fileName: file.name, outName, stampedPages: stamps.length, ok: true });
      } catch (err) {
        results.push({
          fileName: file.name,
          outName,
          stampedPages: 0,
          ok: false,
          reason: describeError(err),
        });
      }

      if (alive.current) {
        setDone(i + 1);
        setOutcomes([...results]);
      }
    }

    const cancelled = cancelRequested.current;
    if (entries.length > 0) {
      try {
        const name = zipName(entries.length);
        const zip = await makeZip(entries);
        if (isMobileBrowser() || isWeChatBrowser()) {
          // 手势早已过期，share 必被拒：存住，等结果区的「保存 / 分享」按钮
          if (alive.current) setZipPending({ name, blob: zip });
        } else {
          downloadBytes(zip, name, 'application/zip');
          if (alive.current) {
            setZipSaved(name);
            setZipNote(null);
          }
        }
      } catch (err) {
        results.push({
          fileName: '（打包）',
          outName: '',
          stampedPages: 0,
          ok: false,
          reason: describeError(err),
        });
      }
    }

    if (alive.current) {
      setOutcomes([...results]);
      setLabel(cancelled ? `已取消：完成 ${entries.length}/${files.length} 份` : '');
      setBusy(false);
    }
  }, []);

  return { busy, done, total, label, outcomes, zipSaved, zipNote, zipPending, run, reset, cancel, deliverZip };
}

/** 把内部错误翻译成用户能懂的一句话。 */
function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/password/i.test(msg)) return '该 PDF 受密码保护，请先移除密码';
  if (/InvalidPDF|Invalid PDF|structure/i.test(msg)) return '这个文件不是有效的 PDF，或者已经损坏';
  return msg || '处理失败';
}
