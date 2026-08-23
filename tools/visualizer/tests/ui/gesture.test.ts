import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  applyGesture,
  clampZoom,
  gestureOf,
  zoomAbout,
} from '../../src/ui/gesture.js';
import type { Point, Viewport } from '../../src/ui/gesture.js';

function contentUnder(view: Viewport, anchor: Point): Point {
  return { x: (anchor.x - view.x) / view.zoom, y: (anchor.y - view.y) / view.zoom };
}

describe('gestureOf', () => {
  it('reports a single pointer as its own position with no spread', () => {
    expect(gestureOf([{ x: 40, y: -12 }])).toEqual({ x: 40, y: -12, spread: 0 });
  });

  it('reports the centroid and mean radius of two pointers', () => {
    expect(gestureOf([{ x: 0, y: 0 }, { x: 60, y: 80 }])).toEqual({ x: 30, y: 40, spread: 50 });
  });

  it('survives an empty pointer set', () => {
    expect(gestureOf([])).toEqual({ x: 0, y: 0, spread: 0 });
  });
});

describe('clampZoom', () => {
  it('holds the zoom inside the usable range', () => {
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(1.4)).toBe(1.4);
  });
});

describe('zoomAbout', () => {
  it('keeps the content under the anchor pinned while the zoom changes', () => {
    const view = { zoom: 1.3, x: -40, y: 25 };
    const anchor = { x: 210, y: 90 };
    const zoomed = zoomAbout(view, 1.6, anchor);

    expect(zoomed.zoom).toBeCloseTo(1.3 * 1.6, 10);
    expect(contentUnder(zoomed, anchor).x).toBeCloseTo(contentUnder(view, anchor).x, 10);
    expect(contentUnder(zoomed, anchor).y).toBeCloseTo(contentUnder(view, anchor).y, 10);
  });

  it('still pins the anchor when the requested zoom is clamped away', () => {
    const view = { zoom: 2.5, x: 12, y: -8 };
    const anchor = { x: -60, y: 140 };
    const zoomed = zoomAbout(view, 10, anchor);

    expect(zoomed.zoom).toBe(MAX_ZOOM);
    expect(contentUnder(zoomed, anchor).x).toBeCloseTo(contentUnder(view, anchor).x, 10);
    expect(contentUnder(zoomed, anchor).y).toBeCloseTo(contentUnder(view, anchor).y, 10);
  });
});

describe('applyGesture', () => {
  it('translates by the pointer delta and leaves the zoom alone for one pointer', () => {
    const view = { zoom: 1.75, x: 10, y: 10 };
    const moved = applyGesture(view, gestureOf([{ x: 0, y: 0 }]), gestureOf([{ x: 35, y: -20 }]));

    expect(moved).toEqual({ zoom: 1.75, x: 45, y: -10 });
  });

  it('zooms by the ratio of the pinch spread', () => {
    const view = { zoom: 1, x: 0, y: 0 };
    const from = gestureOf([{ x: 90, y: 100 }, { x: 110, y: 100 }]);
    const to = gestureOf([{ x: 80, y: 100 }, { x: 120, y: 100 }]);

    expect(applyGesture(view, from, to).zoom).toBeCloseTo(2, 10);
  });

  it('pins the content the fingers started on while they spread and drift', () => {
    const view = { zoom: 0.8, x: 30, y: -15 };
    const from = gestureOf([{ x: 180, y: 60 }, { x: 220, y: 60 }]);
    const to = gestureOf([{ x: 150, y: 130 }, { x: 270, y: 130 }]);
    const after = applyGesture(view, from, to);

    expect(after.zoom).toBeCloseTo(0.8 * 3, 10);
    expect(contentUnder(after, to).x).toBeCloseTo(contentUnder(view, from).x, 10);
    expect(contentUnder(after, to).y).toBeCloseTo(contentUnder(view, from).y, 10);
  });

  it('ignores a spread ratio when a pointer set collapses to one point', () => {
    const view = { zoom: 1.2, x: 4, y: 4 };
    const from = gestureOf([{ x: 0, y: 0 }, { x: 20, y: 0 }]);
    const to = gestureOf([{ x: 50, y: 0 }]);

    expect(applyGesture(view, from, to).zoom).toBe(1.2);
  });
});
