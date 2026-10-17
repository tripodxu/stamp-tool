import { memo, useEffect, useRef, type CSSProperties } from 'react';
import type { Stamp } from '../lib/types';
import { clamp } from '../lib/geometry';
import { pngObjectUrl } from '../lib/pngCache';

interface Props {
  stamp: Stamp;
  zoom: number;
  selected: boolean;
  page: { wPt: number; hPt: number };
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Stamp>, history?: boolean) => void;
  /** 连续交互（拖拽/缩放）的**起点**入栈，由父级统一管理撤销栈 */
  onBeginEdit: () => void;
  onRemove: (id: string) => void;
}

type DragMode =
  | { kind: 'move'; startX: number; startY: number; originX: number; originY: number }
  | {
      kind: 'resize';
      startDist: number;
      originW: number;
      originH: number;
      /**
       * 缩放手柄的旋转中心（屏幕坐标），在 pointerdown 时锁一次。
       *
       * 早期版本每次 pointermove 都重新 getBoundingClientRect() 算中心，
       * 而带旋转的矩形包围盒会随角度变化，中心跟着漂——拖越大抖得越厉害。
       */
      cx: number;
      cy: number;
    }
  | {
      kind: 'rotate';
      /** 旋转中心（屏幕坐标），pointerdown 时锁一次 */
      cx: number;
      cy: number;
      /** 按下瞬间指针相对中心的方位角（度，屏幕坐标 y 向下） */
      startAngle: number;
      originRot: number;
    };

function StampBoxImpl({
  stamp,
  zoom,
  selected,
  page,
  onSelect,
  onUpdate,
  onBeginEdit,
  onRemove,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<DragMode | null>(null);

  // 拖拽期间用 ref 直写 style，避免每帧 re-render（决策 1：拖拽只是改两个 CSS 值）
  useEffect(() => {
    const el = ref.current;
    if (!el || drag.current) return;
    el.style.left = `${stamp.xPt}px`;
    el.style.top = `${stamp.yPt}px`;
    el.style.width = `${stamp.widthPt}px`;
    el.style.height = `${stamp.heightPt}px`;
    el.style.transform = `rotate(${stamp.rotationDeg}deg)`;
  }, [stamp.xPt, stamp.yPt, stamp.widthPt, stamp.heightPt, stamp.rotationDeg]);

  const startMove = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect(stamp.id);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    // 动手之前先把当前状态记进撤销栈，过程中只更新不入栈
    onBeginEdit();
    drag.current = {
      kind: 'move',
      startX: e.clientX,
      startY: e.clientY,
      originX: stamp.xPt,
      originY: stamp.yPt,
    };
  };

  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const rect = ref.current!.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    onBeginEdit();
    drag.current = {
      kind: 'resize',
      startDist: Math.hypot(e.clientX - cx, e.clientY - cy) || 1,
      originW: stamp.widthPt,
      originH: stamp.heightPt,
      cx,
      cy,
    };
  };

  /**
   * 直接在印章上旋转。
   *
   * 为什么用「起始方位角差」而不是「当前指针方位角」：
   * 直接取当前角会在手柄不与指针重合时产生固定偏移，用户得先转半圈对齐；
   * 取差值则是增量式旋转——手柄相对下方的直线怎么走，章就跟着转多少。
   */
  const startRotate = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const rect = ref.current!.getBoundingClientRect();
    // 旋转是绕自身中心做的，所以包围盒中心恒等于旋转中心
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    onBeginEdit();
    drag.current = {
      kind: 'rotate',
      cx,
      cy,
      startAngle: angleTo(e.clientX, e.clientY, cx, cy),
      originRot: stamp.rotationDeg,
    };
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      const el = ref.current;
      if (!d || !el) return;

      if (d.kind === 'move') {
        const dx = (e.clientX - d.startX) / zoom;
        const dy = (e.clientY - d.startY) / zoom;
        // 允许部分出血，但保留四分之一在页内，避免章被拖丢后找不到
        const x = clamp(d.originX + dx, -stamp.widthPt * 0.75, page.wPt - stamp.widthPt * 0.25);
        const y = clamp(d.originY + dy, -stamp.heightPt * 0.75, page.hPt - stamp.heightPt * 0.25);
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        onUpdate(stamp.id, { xPt: x, yPt: y }, false);
      } else if (d.kind === 'resize') {
        // 中心用开始时锁定的那份，不随当前尺寸/旋转漂移
        const dist = Math.hypot(e.clientX - d.cx, e.clientY - d.cy);
        const scale = clamp(dist / d.startDist, 0.1, 6);
        // 宽高比锁定——非等比缩放会把印章拉变形
        const w = d.originW * scale;
        const h = d.originH * scale;
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        onUpdate(stamp.id, { widthPt: w, heightPt: h }, false);
      } else {
        const delta = angleTo(e.clientX, e.clientY, d.cx, d.cy) - d.startAngle;
        let rot = normalizeDeg(d.originRot + delta);
        // Shift 吸附到 15°；靠近 0° 时直接归零，省掉再点「一键摆正」
        if (e.shiftKey) rot = Math.round(rot / 15) * 15;
        else if (Math.abs(rot) < 2.5) rot = 0;
        rot = Math.round(rot * 10) / 10;
        el.style.transform = `rotate(${rot}deg)`;
        onUpdate(stamp.id, { rotationDeg: rot }, false);
      }
    };

    const onUp = () => {
      // 历史已在 pointerdown 入栈，这里只解除拖拽态，不重复提交
      drag.current = null;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [zoom, stamp.id, stamp.widthPt, stamp.heightPt, page, onUpdate]);

  return (
    <div
      ref={ref}
      className={`stamp-box${selected ? ' is-selected' : ''}`}
      style={
        {
          // 首帧由 useEffect 同步写入；这里给出初值避免闪烁
          left: stamp.xPt,
          top: stamp.yPt,
          width: stamp.widthPt,
          height: stamp.heightPt,
          transform: `rotate(${stamp.rotationDeg}deg)`,
          opacity: stamp.opacity,
          // 手柄/删除按钮按 1/zoom 反缩放用（见 index.css）：
          // 它们长在 .stamp-layer 的 scale(zoom) 里，不抵消的话
          // 25% 缩放时 18px 的手柄只有 4.5px，点都点不中。
          '--zoom': zoom,
        } as CSSProperties
      }
      onPointerDown={startMove}
      role="button"
      tabIndex={-1}
      aria-label="印章"
    >
      <img src={pngObjectUrl(stamp.pngBytes)} alt="" draggable={false} />
      {selected && (
        <>
          <div className="stamp-handle stamp-handle-se" onPointerDown={startResize} />
          <div
            className="stamp-rot"
            title="拖动旋转，按住 Shift 吸附 15°"
            onPointerDown={startRotate}
          />
          <button
            className="stamp-delete"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(stamp.id);
            }}
            aria-label="删除该印章"
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}

/** 指针相对旋转中心的方位角（度）。屏幕 y 向下，故直接用 atan2 即可。 */
function angleTo(x: number, y: number, cx: number, cy: number): number {
  return (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
}

/** 归一化到 (-180, 180]，避免连续旋转时角度无限累加导致浮点毛刺。 */
function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * memo：拖一张章时，同页其他章的 props 不变就不该跟着重渲染。
 * 前提是回调引用稳定——它们都来自 useCallback 或 reducer dispatch。
 */
export const StampBox = memo(StampBoxImpl);
