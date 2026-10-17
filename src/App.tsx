import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStampTool } from './state/useStampTool';
import { Toolbar } from './components/Toolbar';
import { PageCanvas } from './components/PageCanvas';
import { Inspector } from './components/Inspector';

export default function App() {
  const tool = useStampTool();
  const { state, stats } = tool;
  const { exportPdf, undo, redo, select } = tool;
  const stampCount = state.stamps.length;
  const [dropping, setDropping] = useState(false);

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
      if (e.key === 'Escape') select(null);
      if ((e.ctrlKey || e.metaKey) && e.key === 'e' && stampCount) {
        e.preventDefault();
        void exportPdf();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exportPdf, redo, undo, select, stampCount]);

  const currentPage = state.pages[state.currentPage];
  // 拖一张章不该让同页所有章重渲染：数组引用必须稳定，否则 memo 白包
  const pageStamps = useMemo(
    () => state.stamps.filter((s) => s.pageIndex === state.currentPage),
    [state.stamps, state.currentPage],
  );
  const selected = state.stamps.find((s) => s.id === state.selectedId) ?? null;

  // ---- 拖放上传：PDF 与印章都直接扔进窗口 ----
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDropping(false);
      const files = Array.from(e.dataTransfer.files);
      const pdf = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
      const img = files.find((f) => f.type.startsWith('image/'));
      // 同时拖进来两份时先处理文档，用户改主意可以马上再拖一次章
      if (pdf) void tool.openPdf(pdf);
      else if (img) void tool.openSeal(img);
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
        zoom={state.zoom}
        canUndo={stats.canUndo}
        canRedo={stats.canRedo}
        busy={!!state.busy}
        onOpenPdf={tool.openPdf}
        onOpenSeal={tool.openSeal}
        onAddStamp={() => tool.addStamp()}
        onPage={tool.setPage}
        onZoom={tool.setZoom}
        onUndo={undo}
        onRedo={redo}
        onExport={() => void exportPdf()}
      />

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
            <button className="primary" onClick={() => void exportPdf(true)}>
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
          onRemove={tool.removeStamp}
          onUseSeal={tool.useSavedSeal}
          onDeleteSeal={tool.removeSavedSeal}
          onClearSeals={tool.clearSavedSeals}
        />
      </main>
    </div>
  );
}
