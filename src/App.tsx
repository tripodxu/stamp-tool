import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStampTool } from './state/useStampTool';
import { Toolbar } from './components/Toolbar';
import { PageCanvas } from './components/PageCanvas';
import { Inspector } from './components/Inspector';
import { BatchPanel } from './components/BatchPanel';
import { isPdfFile } from './lib/batch';

export default function App() {
  const tool = useStampTool();
  const { state, stats } = tool;
  const { exportPdf, undo, redo, select, setPage, removeStamp, duplicateStamp } = tool;
  const stampCount = state.stamps.length;
  const [dropping, setDropping] = useState(false);
  const [batching, setBatching] = useState(false);
  /** 一次拖进多份 PDF 时，先把它们交给批量面板 */
  const [batchFiles, setBatchFiles] = useState<File[]>([]);

  /**
   * 键盘监听要读「当前第几页」，但把 state 放进依赖数组会让监听每次渲染
   * 都解绑重绑（useStampTool 里所有回调都刻意保持引用稳定）。走 ref。
   */
  const stateRefPages = useRef({ page: state.currentPage, length: state.pages.length });
  stateRefPages.current = { page: state.currentPage, length: state.pages.length };

  /** 同上：Delete / Ctrl+D 要知道选中的是哪一枚。 */
  const stateRefSel = useRef<string | null>(state.selectedId);
  stateRefSel.current = state.selectedId;

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+E
  // 依赖全部是稳定引用（useCallback），否则每次渲染都会解绑重绑监听
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if (e.key === 'Escape') {
        // 批量面板开着时，Esc 先关面板
        if (batching) setBatching(false);
        else select(null);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'e' && stampCount) {
        e.preventDefault();
        void exportPdf();
      }
      // 翻页键：批量面板开着时它盖在文档上，这时不抢键
      if (batching) return;
      // 删除 / 复制选中的章。Backspace 在没有选中项时留给浏览器，别劫持成「后退」
      const sel = stateRefSel.current;
      if (sel && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        removeStamp(sel);
        return;
      }
      if (sel && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateStamp(sel);
        return;
      }
      const pageCount = stateRefPages.current.length;
      if (pageCount === 0) return;
      const cur = stateRefPages.current.page;
      if (e.key === 'PageDown') {
        e.preventDefault();
        if (cur < pageCount - 1) setPage(cur + 1);
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        if (cur > 0) setPage(cur - 1);
      } else if (e.key === 'Home' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setPage(0);
      } else if (e.key === 'End' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setPage(pageCount - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    exportPdf,
    redo,
    undo,
    select,
    setPage,
    removeStamp,
    duplicateStamp,
    stampCount,
    batching,
    stateRefPages,
  ]);

  const currentPage = state.pages[state.currentPage];
  // 拖一张章不该让同页所有章重渲染：数组引用必须稳定，否则 memo 白包
  const pageStamps = useMemo(
    () => state.stamps.filter((s) => s.pageIndex === state.currentPage),
    [state.stamps, state.currentPage],
  );
  const selected = state.stamps.find((s) => s.id === state.selectedId) ?? null;

  // 「有章的页」下拉：页码去重升序
  const stampPages = useMemo(
    () => [...new Set(state.stamps.map((s) => s.pageIndex))].sort((a, b) => a - b),
    [state.stamps],
  );

  /** 跳到某页并把该页第一枚章选中——否则跳过去也看不出章在哪。 */
  const jumpToPage = useCallback(
    (page: number) => {
      setPage(page);
      const first = state.stamps.find((s) => s.pageIndex === page);
      select(first ? first.id : null);
    },
    [setPage, select, state.stamps],
  );

  // ---- 拖放上传：PDF 与印章都直接扔进窗口 ----
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDropping(false);
      const files = Array.from(e.dataTransfer.files);
      const pdfs = files.filter(isPdfFile);
      const img = files.find((f) => f.type.startsWith('image/'));
      // 同时扔进文档和图片时先处理文档，用户改主意可以马上再拖一次章
      if (pdfs.length > 1) {
        // 一次拖多份＝「这些全都要盖」：直接开批量面板并预填，
        // 别只打开第一份、把其余几份静默丢掉
        setBatchFiles(pdfs);
        setBatching(true);
      } else if (pdfs.length === 1) {
        void tool.openPdf(pdfs[0]);
      } else if (img) {
        void tool.openSeal(img);
      }
    },
    [tool.openPdf, tool.openSeal],
  );

  return (
    <div className="app">
      <Toolbar
        hasDoc={!!state.docFile}
        hasSeal={!!state.seal}
        stampCount={stats.stampCount}
        pageCount={stats.pageCount}
        page={state.currentPage}
        stampPages={stampPages}
        zoom={state.zoom}
        canUndo={stats.canUndo}
        canRedo={stats.canRedo}
        busy={!!state.busy}
        onOpenPdf={tool.openPdf}
        onOpenSeal={tool.openSeal}
        onAddStamp={() => tool.addStamp()}
        onPage={tool.setPage}
        onJumpToPage={jumpToPage}
        onZoom={tool.setZoom}
        onUndo={undo}
        onRedo={redo}
        onExport={() => void exportPdf()}
        onExportAs={() => void tool.exportPdfAs()}
        onBatch={() => {
          setBatchFiles([]);
          setBatching(true);
        }}
      />

      {batching && (
        <BatchPanel
          seal={state.seal}
          stamp={selected}
          page={currentPage ?? null}
          initialFiles={batchFiles}
          onClose={() => {
            setBatching(false);
            setBatchFiles([]);
          }}
        />
      )}

      {/* 换文档＝连撤销栈一起清，唯一退不回来的操作，先问一句 */}
      {state.pendingPdf && (
        <div className="banner warn">
          <span>
            打开「{state.pendingPdf.name}」会清空当前已盖的 {stampCount} 枚印章，且无法撤销。
          </span>
          <span className="banner-actions">
            <button onClick={tool.cancelOpenPdf}>取消</button>
            <button className="primary" onClick={() => void tool.confirmOpenPdf()}>
              仍然打开
            </button>
          </span>
        </div>
      )}
      {state.error && (
        <div className="banner error">
          <span>{state.error}</span>
          <button onClick={tool.clearError}>关闭</button>
        </div>
      )}
      {state.done && (
        <div className="banner done">
          <span>{state.done}</span>
          <button onClick={tool.clearDone}>知道了</button>
        </div>
      )}
      {state.signWarning && (
        <div className="banner warn">
          <span>{state.signWarning}</span>
          <span className="banner-actions">
            <button onClick={tool.clearSignWarning}>取消</button>
            <button className="primary" onClick={tool.confirmExport}>
              仍然导出
            </button>
          </span>
        </div>
      )}
      {state.busy && <div className="banner busy">{state.busy}</div>}

      <main className="main">
        <section
          className={`viewport${dropping ? ' is-dropping' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(e) => {
            // 只有真正离开 viewport 才取消高亮，否则经过子元素会闪
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
          }}
          onDrop={onDrop}
        >
          {state.docFile && tool.pdfHandle.current && currentPage ? (
            <PageCanvas
              handle={tool.pdfHandle.current}
              pageIndex={state.currentPage}
              page={currentPage}
              zoom={state.zoom}
              stamps={pageStamps}
              selectedId={state.selectedId}
              onSelect={tool.select}
              onUpdate={tool.updateStamp}
              onNudge={tool.nudge}
              onBeginEdit={tool.beginEdit}
              onRemove={tool.removeStamp}
            />
          ) : (
            <div className="empty">
              <h1>把章盖在文件上</h1>
              <p>把 PDF 或印章图片拖进这个窗口，或用上方按钮选择。</p>
              <p className="note">全部处理都在你的浏览器里完成，文件不会上传到任何服务器。</p>
            </div>
          )}
        </section>

        <Inspector
          seal={state.seal}
          stamp={selected}
          page={currentPage ?? null}
          pageCount={stats.pageCount}
          seals={state.seals}
          onUpdate={tool.updateStamp}
          onBeginEdit={tool.beginEdit}
          onApplyPreset={tool.applyPreset}
          onCopyAllPages={tool.copyStampToAllPages}
          onStampOnPages={tool.stampOnPages}
          onRemove={tool.removeStamp}
          onUseSeal={tool.useSavedSeal}
          onDeleteSeal={tool.removeSavedSeal}
          onRenameSeal={tool.renameSavedSeal}
          onDedupeSeals={tool.dedupeSeals}
          onClearSeals={tool.clearSavedSeals}
        />
      </main>
    </div>
  );
}
