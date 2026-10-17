import { useEffect, useRef, useState } from 'react';

interface Props {
  hasDoc: boolean;
  hasSeal: boolean;
  stampCount: number;
  pageCount: number;
  page: number;
  /** 有印章的页码（0 起），用于「有章的页」快速跳转 */
  stampPages: number[];
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  /** 有任务在跑（读 PDF / 导出）时锁住导出按钮，避免连点跑两遍 */
  busy: boolean;
  onOpenPdf: (file: File) => void;
  onOpenSeal: (file: File) => void;
  onAddStamp: () => void;
  onPage: (p: number) => void;
  onJumpToPage: (p: number) => void;
  onZoom: (z: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  /** 导出到用户自己挑的位置（环境不支持时自动退回下载） */
  onExportAs: () => void;
  /** 批量盖章：一次给多份 PDF 盖上同一枚章 */
  onBatch: () => void;
}

export function Toolbar(p: Props) {
  const pdfRef = useRef<HTMLInputElement>(null);
  const sealRef = useRef<HTMLInputElement>(null);
  /** 页码输入框里正在敲的内容；null 表示跟随当前页 */
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 「导出」旁边的下拉：主按钮还是导出到「下载」，另存为是备选 */
  const [exportMenu, setExportMenu] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  // 点别处 / 按 Esc 关掉下拉菜单
  useEffect(() => {
    if (!menuOpen && !exportMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t)) setMenuOpen(false);
      if (!exportRef.current?.contains(t)) setExportMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setExportMenu(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, exportMenu]);

  // 换页（或页数变了）就丢掉草稿，别让输入框停在旧值上
  useEffect(() => setPageDraft(null), [p.page, p.pageCount]);

  /** 提交手敲的页码：越界就夹回范围，非数字就当没敲 */
  const commitPage = () => {
    const n = Number.parseInt(pageDraft ?? '', 10);
    setPageDraft(null);
    if (!Number.isFinite(n)) return;
    const target = Math.min(p.pageCount, Math.max(1, n)) - 1;
    if (target !== p.page) p.onPage(target);
  };

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
          <button
            onClick={() => p.onPage(p.page - 1)}
            disabled={p.page === 0}
            title="上一页 (PageUp)"
          >
            ‹
          </button>
          {/* 页码可以直接敲：几十页的合同翻起来比连点快得多 */}
          <input
            className="page-input"
            value={pageDraft ?? String(p.page + 1)}
            inputMode="numeric"
            aria-label="页码"
            title="输入页码后回车跳转"
            onChange={(e) => setPageDraft(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitPage();
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                setPageDraft(null);
                (e.target as HTMLInputElement).blur();
              }
            }}
            onBlur={commitPage}
          />
          <span className="page-total">/ {p.pageCount}</span>
          <button
            onClick={() => p.onPage(p.page + 1)}
            disabled={p.page >= p.pageCount - 1}
            title="下一页 (PageDown)"
          >
            ›
          </button>

          {p.stampPages.length > 0 && (
            <div className="pager-menu" ref={menuRef}>
              <button
                className="pager-menu-btn"
                aria-haspopup="listbox"
                aria-expanded={menuOpen}
                title="跳到盖了章的页"
                onClick={() => setMenuOpen((v) => !v)}
              >
                有章 ({p.stampPages.length})
              </button>
              {menuOpen && (
                <ul className="pager-menu-list" role="listbox">
                  {p.stampPages.map((idx) => (
                    <li key={idx}>
                      <button
                        role="option"
                        aria-selected={idx === p.page}
                        className={idx === p.page ? 'is-current' : undefined}
                        onClick={() => {
                          setMenuOpen(false);
                          p.onJumpToPage(idx);
                        }}
                      >
                        第 {idx + 1} 页
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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

      <span className="count">
        {p.hasDoc ? `${p.stampCount} 枚印章` : '尚未选择文件'}
      </span>

      {/* 打包版里前端是编进二进制的：显示构建时间，避免拿着旧 exe 以为功能没做 */}
      <span className="build" title="本界面的构建时间；与源码不符说明 exe 该重新打包了">
        构建 {__BUILD_STAMP__}
      </span>

      {/* 导出拆成主按钮 + 下拉：多一个「另存为」按钮会把工具栏挤到换行 */}
      <div className="group export-group" ref={exportRef}>
        <button
          onClick={p.onExport}
          disabled={!p.hasDoc || p.stampCount === 0 || p.busy}
          className="primary export-go"
        >
          {p.busy ? '处理中…' : '导出 PDF'}
        </button>
        <button
          className="export-caret"
          onClick={() => setExportMenu((v) => !v)}
          disabled={!p.hasDoc || p.stampCount === 0 || p.busy}
          title="更多导出方式"
          aria-haspopup="menu"
          aria-expanded={exportMenu}
        >
          ▾
        </button>
        {exportMenu && (
          <ul className="pager-menu-list export-menu" role="menu">
            <li>
              <button
                role="menuitem"
                onClick={() => {
                  setExportMenu(false);
                  p.onExportAs();
                }}
              >
                另存为…（自己选位置）
              </button>
            </li>
          </ul>
        )}
      </div>

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
