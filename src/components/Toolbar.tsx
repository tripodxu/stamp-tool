import { useRef } from 'react';

interface Props {
  hasDoc: boolean;
  hasSeal: boolean;
  stampCount: number;
  pageCount: number;
  page: number;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  /** 有任务在跑（读 PDF / 导出）时锁住导出按钮，避免连点跑两遍 */
  busy: boolean;
  onOpenPdf: (file: File) => void;
  onOpenSeal: (file: File) => void;
  onAddStamp: () => void;
  onPage: (p: number) => void;
  onZoom: (z: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  /** 批量盖章：一次给多份 PDF 盖上同一枚章 */
  onBatch: () => void;
}

export function Toolbar(p: Props) {
  const pdfRef = useRef<HTMLInputElement>(null);
  const sealRef = useRef<HTMLInputElement>(null);

  return (
    <header className="toolbar">
      <div className="brand">印章工具</div>

      <div className="group">
        <button onClick={() => pdfRef.current?.click()} className="primary">
          选择 PDF
        </button>
        {/* 印章不必等文档就位：可以先把章备好，再拖 PDF 进来 */}
        <button onClick={() => sealRef.current?.click()}>上传印章</button>
        <button onClick={p.onAddStamp} disabled={!p.hasSeal}>
          放置印章
        </button>
        <button
          onClick={p.onBatch}
          disabled={!p.hasSeal || p.busy}
          title="一次给多份 PDF 盖上同一枚章，最后打包成一个 ZIP"
        >
          批量盖章
        </button>
      </div>

      <div className="group">
        <button onClick={p.onUndo} disabled={!p.canUndo} title="撤销 (Ctrl+Z)">
          撤销
        </button>
        <button onClick={p.onRedo} disabled={!p.canRedo} title="重做 (Ctrl+Shift+Z)">
          重做
        </button>
      </div>

      {p.hasDoc && p.pageCount > 1 && (
        <div className="group pager">
          <button onClick={() => p.onPage(p.page - 1)} disabled={p.page === 0}>
            ‹
          </button>
          <span>
            {p.page + 1} / {p.pageCount}
          </span>
          <button
            onClick={() => p.onPage(p.page + 1)}
            disabled={p.page >= p.pageCount - 1}
          >
            ›
          </button>
        </div>
      )}

      <div className="group zoom">
        <button onClick={() => p.onZoom(p.zoom - 0.1)} disabled={!p.hasDoc}>
          −
        </button>
        <span>{Math.round(p.zoom * 100)}%</span>
        <button onClick={() => p.onZoom(p.zoom + 0.1)} disabled={!p.hasDoc}>
          +
        </button>
      </div>

      <div className="spacer" />

      <span className="count">
        {p.hasDoc ? `${p.stampCount} 枚印章` : '尚未选择文件'}
      </span>

      {/* 打包版里前端是编进二进制的：显示构建时间，避免拿着旧 exe 以为功能没做 */}
      <span className="build" title="本界面的构建时间；与源码不符说明 exe 该重新打包了">
        构建 {__BUILD_STAMP__}
      </span>

      <button
        onClick={p.onExport}
        disabled={!p.hasDoc || p.stampCount === 0 || p.busy}
        className="primary"
      >
        {p.busy ? '处理中…' : '导出 PDF'}
      </button>

      <input
        ref={pdfRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) p.onOpenPdf(f);
          e.target.value = '';
        }}
      />
      <input
        ref={sealRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) p.onOpenSeal(f);
          e.target.value = '';
        }}
      />
    </header>
  );
}