import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStampTool } from './state/useStampTool';
import { Toolbar } from './components/Toolbar';
import { PageCanvas } from './components/PageCanvas';
import { Inspector } from './components/Inspector';
import { BatchPanel } from './components/BatchPanel';
import { isPdfFile } from './lib/batch';
import { useMediaQuery } from './lib/useMediaQuery';
import { isMobileBrowser, isWeChatBrowser } from './lib/platform';
import { copyText } from './lib/clipboard';

/** 手机断点：结构分叉（顶栏+底部栏+抽屉），不是纯 CSS 换摆法。 */
const MOBILE_QUERY = '(max-width: 599px)';
/**
 * 触屏 UA 兜底。Android WebView 可能忽略 meta viewport，
 * innerWidth 不是设备逻辑宽度，媒体查询会失真；UA 不受影响。
 */

export default function App() {
  const tool = useStampTool();
  const { state, stats } = tool;
  const pendingExport = tool.pendingExport;
  const { exportPdf, undo, redo, select, setPage, removeStamp, duplicateStamp } = tool;
  const stampCount = state.stamps.length;
  const [dropping, setDropping] = useState(false);
  const [batching, setBatching] = useState(false);
  /** 批量面板正在跑（由面板上报）：Esc 关面板的捷径在 busy 时要让路 */
  const [batchBusy, setBatchBusy] = useState(false);
  /** 一次拖进多份 PDF 时，先把它们交给批量面板 */
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const isNarrow = useMediaQuery(MOBILE_QUERY);
  const isMobile = isNarrow || isMobileBrowser();
  const wechat = isWeChatBrowser();
  /** 微信里「复制网址」按钮的短暂反馈 */
  const [copied, setCopied] = useState(false);
  /** 手机：Inspector 抽屉开合。选中章自动弹起（见下方 effect）。 */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const mPdfRef = useRef<HTMLInputElement>(null);
  const mSealRef = useRef<HTMLInputElement>(null);
  /** 拍照直传：翻拍照片本就是去背算法的主战场（paper 路线） */
  const mCamRef = useRef<HTMLInputElement>(null);

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
        // 批量面板开着时，Esc 先关面板——但批量正在跑时不能关：
        // 面板一卸载进度和结果列表就没了，循环却还在后台继续
        if (batching && !batchBusy) setBatching(false);
        else if (!batching) select(null);
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
    batchBusy,
    stateRefPages,
  ]);

  const currentPage = state.pages[state.currentPage];
  // 拖一张章不该让同页所有章重渲染：数组引用必须稳定，否则 memo 白包
  const pageStamps = useMemo(
    () => state.stamps.filter((s) => s.pageIndex === state.currentPage),
    [state.stamps, state.currentPage],
  );
  const selected = state.stamps.find((s) => s.id === state.selectedId) ?? null;

  // 手机：点选一枚章 → 弹抽屉调参数。两个例外：
  //  · 「放置」新章不弹——用户下一步是看章落在哪、拖到位置，不是调参数；
  //  · 拖动/缩放中必收——抽屉(62vh)盖着画布，不收就看不见章在动。
  const suppressDrawer = useRef(false);
  useEffect(() => {
    if (isMobile && state.selectedId && !suppressDrawer.current) setDrawerOpen(true);
    suppressDrawer.current = false;
  }, [isMobile, state.selectedId]);
  const mobileBeginEdit = useCallback(() => {
    setDrawerOpen(false);
    tool.beginEdit();
  }, [tool.beginEdit]);

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

  const copyPageUrl = useCallback(async () => {
    const ok = await copyText(window.location.href);
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 2000);
  }, []);

  useEffect(() => {
    setCopied(false);
  }, [tool.pendingExport?.fileName]);

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

  /** 横幅们（错误/完成/签名警告/忙碌/换文档确认）：桌面手机共用。 */
  const banners = (
    <>
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
      {pendingExport && (
        <div className={`banner export ${wechat ? 'warn' : 'done'}`}>
          <span className="banner-text">
            {pendingExport.autoDownloaded
              ? `已生成「${pendingExport.fileName}」。若没有自动下载，点「手动保存」。`
              : wechat
                ? pendingExport.attempted
                  ? '已尝试在微信中打开。若没有反应，请点「复制网址」后在系统浏览器打开。'
                  : 'PDF 已生成。微信内不能直接下载，请点右上角 ··· → 在浏览器打开；或点「尝试保存」。'
                : pendingExport.attempted
                  ? '已尝试下载。若没有反应，请换用系统浏览器打开后重试。'
                  : 'PDF 已生成，点「保存 / 分享」选择保存位置或发送。'}
          </span>
          <span className="banner-actions">
            {!pendingExport.autoDownloaded && wechat && (
              <button onClick={() => void copyPageUrl()}>{copied ? '已复制' : '复制网址'}</button>
            )}
            <button className="primary" onClick={() => void tool.deliverExport()}>
              {pendingExport.autoDownloaded
                ? '手动保存'
                : pendingExport.attempted
                  ? '再次尝试'
                  : wechat
                    ? '尝试保存'
                    : '保存 / 分享'}
            </button>
            <button onClick={tool.dismissExport}>关闭</button>
          </span>
        </div>
      )}
      {state.busy && <div className="banner busy">{state.busy}</div>}
    </>
  );

  const inspector = (
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
  );

  const batchPanel = batching && (
    <BatchPanel
      seal={state.seal}
      stamp={selected}
      page={currentPage ?? null}
      initialFiles={batchFiles}
      onBusyChange={setBatchBusy}
      onClose={() => {
        setBatching(false);
        setBatchFiles([]);
      }}
    />
  );

  // ---- 手机布局：顶栏 + 画布 + 浮条 + 底部操作栏 + 抽屉 ----
  if (isMobile) {
    const pickFile = (ref: React.RefObject<HTMLInputElement | null>) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) {
        if (ref === mPdfRef) void tool.openPdf(f);
        else void tool.openSeal(f);
      }
      e.target.value = '';
    };
    return (
      <div className="app mobile">
        <header className="m-top">
          <span className="brand">印章工具</span>
          {stampCount > 0 && <span className="m-count">{stampCount} 枚章</span>}
          <span className="flex-spacer" />
          <button className="m-icon" disabled={!stats.canUndo} onClick={undo} aria-label="撤销">
            ↺
          </button>
          <button className="m-icon" disabled={!stats.canRedo} onClick={redo} aria-label="重做">
            ↻
          </button>
          <button
            className="primary"
            disabled={!state.docFile || stampCount === 0 || !!state.busy}
            onClick={() => void exportPdf()}
          >
            {state.busy ? '处理中…' : '导出'}
          </button>
        </header>

        {banners}

        <main className="m-main">
          <section className={`viewport${dropping ? ' is-dropping' : ''}`}>
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
                onBeginEdit={mobileBeginEdit}
                onRemove={tool.removeStamp}
                onZoom={tool.setZoom}
              />
            ) : (
              <div className="empty">
                <h1>把章盖在文件上</h1>
                <p>点下方「PDF」选文件，「印章」从相册选图或直接拍照。</p>
                <p className="note">全部处理都在本机完成，文件不会上传。</p>
              </div>
            )}
          </section>

          {state.docFile && (
            <div className="m-float">
              {stats.pageCount > 1 && (
                <>
                  <button
                    disabled={state.currentPage === 0}
                    onClick={() => setPage(state.currentPage - 1)}
                    aria-label="上一页"
                  >
                    ‹
                  </button>
                  <span>
                    {state.currentPage + 1}/{stats.pageCount}
                  </span>
                  <button
                    disabled={state.currentPage >= stats.pageCount - 1}
                    onClick={() => setPage(state.currentPage + 1)}
                    aria-label="下一页"
                  >
                    ›
                  </button>
                  <i className="m-sep" />
                </>
              )}
              <button onClick={() => tool.setZoom(state.zoom - 0.15)} aria-label="缩小">
                −
              </button>
              <span>{Math.round(state.zoom * 100)}%</span>
              <button onClick={() => tool.setZoom(state.zoom + 0.15)} aria-label="放大">
                +
              </button>
            </div>
          )}

          <button className="m-drawer-toggle" onClick={() => setDrawerOpen((v) => !v)}>
            {drawerOpen ? '收起 ▾' : '印章库 · 参数 ▴'}
          </button>

          <nav className="m-bottom">
            <button onClick={() => mPdfRef.current?.click()}>PDF</button>
            <button onClick={() => mSealRef.current?.click()}>印章</button>
            <button onClick={() => mCamRef.current?.click()}>拍照</button>
            <button disabled={!state.seal} onClick={() => { suppressDrawer.current = true; tool.addStamp(); }}>
              放置
            </button>
            <button
              disabled={!state.seal || !!state.busy}
              onClick={() => {
                setBatchFiles([]);
                setBatching(true);
              }}
            >
              批量
            </button>
          </nav>

          {drawerOpen && (
            <div className="m-drawer">
              {/* sticky 收起条：抽屉一开就把外侧把手盖住了，必须自带关闭口 */}
              <button className="m-drawer-close" onClick={() => setDrawerOpen(false)}>
                收起 ▾
              </button>
              {inspector}
            </div>
          )}

          <input ref={mPdfRef} type="file" accept="application/pdf,.pdf" hidden onChange={pickFile(mPdfRef)} />
          <input
            ref={mSealRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={pickFile(mSealRef)}
          />
          <input
            ref={mCamRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={pickFile(mCamRef)}
          />
        </main>
        {batchPanel}
      </div>
    );
  }

  // ---- 桌面布局（现状，不动） ----
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

      {batchPanel}

      {banners}

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

        {inspector}
      </main>
    </div>
  );
}
