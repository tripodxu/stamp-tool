import { useEffect, useRef, useState } from 'react';
import type { PdfHandle } from '../lib/pdfReader';
import { renderPage } from '../lib/pdfReader';
import type { Stamp } from '../lib/types';
import { StampBox } from './StampBox';

interface Props {
  handle: PdfHandle;
  pageIndex: number;
  page: { wPt: number; hPt: number };
  zoom: number;
  stamps: Stamp[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<Stamp>, history?: boolean) => void;
  onNudge: (id: string, dxPt: number, dyPt: number) => void;
  onBeginEdit: () => void;
  onRemove: (id: string) => void;
  /** 双指捏合改缩放（手机）。不传则不启用。 */
  onZoom?: (z: number) => void;
}

export function PageCanvas({
  handle,
  pageIndex,
  page,
  zoom,
  stamps,
  selectedId,
  onSelect,
  onUpdate,
  onNudge,
  onBeginEdit,
  onRemove,
  onZoom,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  /**
   * 换页回到页首。
   *
   * 视口是整块滚动的，翻到下一页时如果保留滚动位置，用户会看到页面的
   * 中段甚至页脚，像是「这一页怎么长得不一样」。全项目只此一处需要动
   * 滚动位置，直接找视口元素，不必为此把 ref 一路传下来。
   */
  useEffect(() => {
    const viewport = document.querySelector('.viewport');
    if (viewport instanceof HTMLElement) viewport.scrollTo({ top: 0 });
  }, [pageIndex]);

  // 按需渲染：只画当前页，架构上决定了不持有全量位图
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !page) return;
    const ctrl = new AbortController();
    setRenderError(null);
    renderPage(handle.doc, pageIndex + 1, canvas, zoom, ctrl.signal).catch((e) => {
      if (!ctrl.signal.aborted) setRenderError((e as Error).message);
    });
    return () => ctrl.abort();
  }, [handle, pageIndex, zoom, page]);

  // 方向键微调：1mm，Shift 为 10mm
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const map: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const dir = map[e.key];
      if (!dir) return;
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) * (72 / 25.4);
      onNudge(selectedId, dir[0] * step, dir[1] * step);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, onNudge]);

  // 双指捏合 = 缩放画布（手机）。桌面无 touch 事件，天然不触发。
  // 章上的单指拖拽先被 .stamp-box 的 pointer 事件消费，两指必有至少一指
  // 落在空白处；监听放捕获阶段，preventDefault 压掉浏览器默认手势
  // （viewport 已在 meta 里禁了整页缩放，这里防的是滚动抢事件）。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !onZoom) return;
    let pinch: { dist: number; zoom: number } | null = null;
    const span = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinch = { dist: span(e.touches) || 1, zoom };
        e.preventDefault();
      }
    };
    const onMove = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        onZoom(pinch.zoom * (span(e.touches) / pinch.dist));
        e.preventDefault();
      }
    };
    const onEnd = () => {
      pinch = null;
    };
    stage.addEventListener('touchstart', onStart, { passive: false, capture: true });
    stage.addEventListener('touchmove', onMove, { passive: false, capture: true });
    stage.addEventListener('touchend', onEnd, { capture: true });
    stage.addEventListener('touchcancel', onEnd, { capture: true });
    return () => {
      stage.removeEventListener('touchstart', onStart, { capture: true } as AddEventListenerOptions);
      stage.removeEventListener('touchmove', onMove, { capture: true } as AddEventListenerOptions);
      stage.removeEventListener('touchend', onEnd, { capture: true } as AddEventListenerOptions);
      stage.removeEventListener('touchcancel', onEnd, { capture: true } as AddEventListenerOptions);
    };
  }, [zoom, onZoom]);

  // 拖拽空白处取消选中
  const onBackgroundPointerDown = () => onSelect(null);

  return (
    <div className="page-wrap">
      <div
        ref={stageRef}
        className="page-stage"
        style={{ width: page.wPt * zoom, height: page.hPt * zoom }}
        onPointerDown={onBackgroundPointerDown}
      >
        <canvas ref={canvasRef} className="page-canvas" />

        {/* 印章层：内部坐标 = PDF point，由 CSS scale(zoom) 映射到屏幕。
            这样印章的位置/尺寸数值始终是物理坐标，与缩放无关。 */}
        <div
          className="stamp-layer"
          style={{
            width: page.wPt,
            height: page.hPt,
            transform: `scale(${zoom})`,
          }}
        >
          {stamps.map((s) => (
            <StampBox
              key={s.id}
              stamp={s}
              zoom={zoom}
              selected={s.id === selectedId}
              page={page}
              onSelect={onSelect}
              onUpdate={onUpdate}
              onBeginEdit={onBeginEdit}
              onRemove={onRemove}
            />
          ))}
        </div>

        {renderError && <div className="page-error">渲染失败：{renderError}</div>}
      </div>
    </div>
  );
}