export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 16;

export const MIN_READABLE_SCALE = 0.9;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  zoom: number;
  x: number;
  y: number;
}

export interface Gesture {
  x: number;
  y: number;
  spread: number;
}

export const IDENTITY: Viewport = { zoom: 1, x: 0, y: 0 };

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function gestureOf(points: readonly Point[]): Gesture {
  if (points.length === 0) return { x: 0, y: 0, spread: 0 };

  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }
  const x = sumX / points.length;
  const y = sumY / points.length;

  let spread = 0;
  for (const point of points) spread += Math.hypot(point.x - x, point.y - y);
  return { x, y, spread: spread / points.length };
}

export function zoomAbout(view: Viewport, factor: number, anchor: Point): Viewport {
  const zoom = clampZoom(view.zoom * factor);
  const applied = zoom / view.zoom;
  return {
    zoom,
    x: anchor.x - (anchor.x - view.x) * applied,
    y: anchor.y - (anchor.y - view.y) * applied,
  };
}

export function applyGesture(view: Viewport, from: Gesture, to: Gesture): Viewport {
  const factor = from.spread > 0 && to.spread > 0 ? to.spread / from.spread : 1;
  const zoomed = zoomAbout(view, factor, from);
  return { zoom: zoomed.zoom, x: zoomed.x + (to.x - from.x), y: zoomed.y + (to.y - from.y) };
}

export function homeViewport(viewBox: Rect, size: Size): Viewport {
  if (size.width <= 0 || size.height <= 0 || viewBox.width <= 0 || viewBox.height <= 0) return IDENTITY;

  const fit = Math.min(size.width / viewBox.width, size.height / viewBox.height);
  if (fit >= MIN_READABLE_SCALE) return IDENTITY;

  return zoomAbout(IDENTITY, MIN_READABLE_SCALE / fit, { x: viewBox.x + viewBox.width / 2, y: viewBox.y });
}
