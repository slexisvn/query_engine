import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { edgeOpacityAt, edgePath, nodeStyleAt } from '../engine/morph.js';
import {
  DETAIL_LINE_HEIGHT,
  DETAIL_TOP_GAP,
  NODE_PADDING_X,
  NODE_PADDING_Y,
  TITLE_HEIGHT,
  rowsLabel,
} from './node-sizer.js';
import { DETAIL_FONT, ROWS_FONT, TITLE_FONT } from './text-metrics.js';
import { applyGesture, gestureOf, homeViewport, zoomAbout } from './gesture.js';
import type { Gesture, Point, Size, Viewport } from './gesture.js';
import type { MorphFrame, NodeStyle } from '../engine/morph.js';
import type { PlanViewNode } from '../engine/plan-view.js';

const TITLE_BASELINE = 13;
const DETAIL_BASELINE = 11;
const ZOOM_WHEEL_STEP = 0.0015;
const ZOOM_BUTTON_STEP = 1.25;
const QUIET_OPACITY = 0.28;

const LEGEND: readonly { status: string; label: string }[] = [
  { status: 'moved', label: 'moved' },
  { status: 'modified', label: 'rewritten' },
  { status: 'added', label: 'added' },
  { status: 'removed', label: 'removed' },
];

export interface PlanGraphProps {
  frame: MorphFrame;
  t: number;
  spotlight: boolean;
  legend: boolean;
  caption: string | null;
  onSelect: (node: PlanViewNode | null) => void;
}

function PlanNode({ style, status, onSelect }: { style: NodeStyle; status: string; onSelect: () => void }) {
  const content = style.content;
  if (!content) return null;

  const contentTop = -style.height / 2 + NODE_PADDING_Y;
  const left = -style.width / 2 + NODE_PADDING_X;
  const rows = rowsLabel(content);

  return (
    <g
      className={`plan-node status-${status}`}
      role="button"
      tabIndex={0}
      aria-label={`${content.title}${content.fullDetail ? `, ${content.fullDetail}` : ''}`}
      onClick={onSelect}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect();
      }}
    >
      <rect
        x={-style.width / 2}
        y={-style.height / 2}
        width={style.width}
        height={style.height}
        rx={9}
      />
      <text style={{ font: TITLE_FONT }} className="plan-node-title" x={left} y={contentTop + TITLE_BASELINE}>
        {content.title}
      </text>
      {rows === '' ? null : (
        <text
          style={{ font: ROWS_FONT }}
          className="plan-node-rows"
          x={style.width / 2 - NODE_PADDING_X}
          y={contentTop + TITLE_BASELINE}
          textAnchor="end"
        >
          {rows}
        </text>
      )}
      {style.detailLines.map((line, index) => (
        <text
          key={index}
          style={{ font: DETAIL_FONT }}
          className="plan-node-detail"
          x={left}
          y={contentTop + TITLE_HEIGHT + DETAIL_TOP_GAP + DETAIL_BASELINE + index * DETAIL_LINE_HEIGHT}
        >
          {line}
        </text>
      ))}
    </g>
  );
}

function toCanvasSpace(svg: SVGSVGElement, event: { clientX: number; clientY: number }): Point {
  const screen = svg.getScreenCTM();
  if (!screen) return { x: event.clientX, y: event.clientY };
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(screen.inverse());
  return { x: point.x, y: point.y };
}

export function PlanGraph({ frame, t, spotlight, legend, caption, onSelect }: PlanGraphProps) {
  const [moved, setMoved] = useState<Viewport | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const shell = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const anchor = useRef<{ gesture: Gesture; view: Viewport } | null>(null);

  useLayoutEffect(() => {
    const element = shell.current;
    if (!element) return;

    const measure = () => {
      const box = element.getBoundingClientRect();
      setSize(current => (current.width === box.width && current.height === box.height
        ? current
        : { width: box.width, height: box.height }));
    };

    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);

    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);

  const home = useMemo(() => homeViewport(frame.viewBox, size), [frame.viewBox, size]);
  const viewport = moved ?? home;
  const setViewport = setMoved;
  const live = useRef(viewport);
  live.current = viewport;

  const styles = useMemo(() => {
    const computed = new Map<string, NodeStyle>();
    for (const node of frame.nodes) computed.set(node.key, nodeStyleAt(node, t));
    return computed;
  }, [frame, t]);

  const reanchor = useCallback(() => {
    anchor.current = pointers.current.size === 0
      ? null
      : { gesture: gestureOf([...pointers.current.values()]), view: live.current };
  }, []);

  const { viewBox } = frame;

  const zoomBy = useCallback((factor: number) => {
    const centre = { x: viewBox.x + viewBox.width / 2, y: viewBox.y + viewBox.height / 2 };
    setViewport(zoomAbout(live.current, factor, centre));
  }, [viewBox]);

  const onWheel = useCallback((event: React.WheelEvent<SVGSVGElement>) => {
    const at = toCanvasSpace(event.currentTarget, event);
    setViewport(zoomAbout(live.current, Math.exp(-event.deltaY * ZOOM_WHEEL_STEP), at));
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, toCanvasSpace(event.currentTarget, event));
    reanchor();
  }, [reanchor]);

  const onPointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, toCanvasSpace(event.currentTarget, event));
    const origin = anchor.current;
    if (!origin) return;
    setViewport(applyGesture(origin.view, origin.gesture, gestureOf([...pointers.current.values()])));
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
    reanchor();
  }, [reanchor]);

  return (
    <div className="plan-graph" ref={shell}>
      <svg
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        preserveAspectRatio="xMidYMid meet"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setViewport(null)}
      >
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
          {frame.edges.map(edge => {
            const parent = styles.get(edge.parentKey);
            const child = styles.get(edge.childKey);
            if (!parent || !child) return null;
            return (
              <path
                key={edge.key}
                className="plan-edge"
                d={edgePath(parent, child)}
                opacity={edgeOpacityAt(edge, t) * Math.min(parent.opacity, child.opacity)}
              />
            );
          })}
          {frame.nodes.map(node => {
            const style = styles.get(node.key) as NodeStyle;
            if (!style.content) return null;
            const dimmed = spotlight && node.status === 'unchanged' ? QUIET_OPACITY : 1;
            return (
              <g
                key={node.key}
                transform={`translate(${style.x} ${style.y}) scale(${style.scale})`}
                opacity={style.opacity * dimmed}
              >
                <PlanNode style={style} status={node.status} onSelect={() => onSelect(style.content)} />
              </g>
            );
          })}
        </g>
      </svg>

      {caption === null ? null : <div className="graph-caption">{caption}</div>}

      <div className="graph-controls">
        <button type="button" onClick={() => zoomBy(ZOOM_BUTTON_STEP)} title="Zoom in">+</button>
        <button type="button" onClick={() => zoomBy(1 / ZOOM_BUTTON_STEP)} title="Zoom out">−</button>
        <button type="button" onClick={() => setViewport(null)} title="Fit the plan (double-click the canvas)">fit</button>
      </div>

      {legend ? (
        <ul className="graph-legend">
          {LEGEND.map(entry => (
            <li key={entry.status} className={`legend-${entry.status}`}>{entry.label}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
