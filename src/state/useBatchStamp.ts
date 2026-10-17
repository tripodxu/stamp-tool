import { useCallback, useRef, useState } from 'react';
import type { PageInfo } from '../lib/types';
import { loadPdf } from '../lib/pdfReader';
import { downloadBytes, hasSignatureField, openPdfDoc, stampDocument } from '../lib/exporter';
import { reencodeSealPng } from '../lib/seal';
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
  const alive = useRef(true);

  const reset = useCallback(() => {
    setBusy(false);
    setDone(0);
    setTotal(0);
    setLabel('');
    setOutcomes([]);
    setZipSaved(null);
  }, []);

  const run = useCallback(async (input: BatchInput) => {
    const { files, selector, placement, seed, origin } = input;
    if (files.length === 0) return;

    alive.current = true;
    setBusy(true);
    setDone(0);
    setTotal(files.length);
    setOutcomes([]);
    setZipSaved(null);

    const entries: ZipEntry[] = [];
    const results: BatchOutcome[] = [];

    for (let i = 0; i < files.length; i++) {
      const { file } = files[i];
      if (alive.current) {
        setLabel(`正在处理 ${i + 1}/${files.length}：${file.name}`);
        // 交还一次事件循环：否则这一整轮同步 I/O 会让上面的进度永远画不出来
        await new Promise((r) => setTimeout(r, 0));
      }

      const outName = stampedName(file.name);
      try {
        // 页面几何要走 pdf.js（它才是预览的参照系），盖章要走 pdf-lib。
        // 两边都会把 ArrayBuffer 读走，所以文件读两次——这是设计代价，不是疏漏。
        const probe = await loadPdf(new Uint8Array(await file.arrayBuffer()), file.name);
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

        const doc = await openPdfDoc(new Uint8Array(await file.arrayBuffer()));
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
        entries.push({ name: outName, bytes: out });
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

    if (entries.length > 0) {
      try {
        const name = zipName(entries.length);
        const zip = await makeZip(entries);
        downloadBytes(zip, name, 'application/zip');
        if (alive.current) setZipSaved(name);
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
      setLabel('');
      setBusy(false);
    }
  }, []);

  return { busy, done, total, label, outcomes, zipSaved, run, reset };
}

/** 把内部错误翻译成用户能懂的一句话。 */
function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/password/i.test(msg)) return '该 PDF 受密码保护，请先移除密码';
  if (/InvalidPDF|Invalid PDF|structure/i.test(msg)) return '这个文件不是有效的 PDF，或者已经损坏';
  return msg || '处理失败';
}
