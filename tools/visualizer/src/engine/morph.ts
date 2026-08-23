import { hierarchy, tree } from 'd3-hierarchy';
import { flattenPlanView } from './plan-view.js';
import type { PlanViewNode } from './plan-view.js';
import type { NodeStatus, PlanDiff, PlanMatch } from './plan-diff.js';

export const COLUMN_GAP = 36;
export const ROW_GAP = 46;
export const CANVAS_PADDING = 48;

const EXIT_PHASE: Phase = { start: 0, end: 0.25 };
const TRAVEL_PHASE: Phase = { start: 0.2, end: 0.8 };
const ENTER_PHASE: Phase = { start: 0.75, end: 1 };
const GHOST_SCALE = 0.55;
const SIBLING_GAP_FACTOR = 1.5;

interface Phase {
  start: number;
  end: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NodeShape {
  width: number;
  height: number;
  detailLines: readonly string[];
}

export type NodeSizer = (node: PlanViewNode) => NodeShape;

export interface PlanLayout {
  positions: Map<string, Point>;
  shapes: Map<string, NodeShape>;
  bounds: Bounds;
}

export interface MorphNode {
  key: string;
  status: NodeStatus;
  from: Point;
  to: Point;
  fromNode: PlanViewNode | null;
  toNode: PlanViewNode | null;
  fromShape: NodeShape;
  toShape: NodeShape;
}

export interface MorphEdge {
  key: string;
  parentKey: string;
  childKey: string;
  status: 'kept' | 'added' | 'removed';
}

export interface MorphFrame {
  nodes: MorphNode[];
  edges: MorphEdge[];
  viewBox: Bounds;
}

export interface NodeStyle {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  opacity: number;
  content: PlanViewNode | null;
  detailLines: readonly string[];
}

function easeOut(u: number): number {
  const inverse = 1 - u;
  return 1 - inverse * inverse * inverse;
}

function progress(t: number, phase: Phase): number {
  if (t <= phase.start) return 0;
  if (t >= phase.end) return 1;
  return easeOut((t - phase.start) / (phase.end - phase.start));
}

function lerp(from: number, to: number, u: number): number {
  return from + (to - from) * u;
}

export function layoutPlan(root: PlanViewNode, sizer: NodeSizer): PlanLayout {
  const shapes = new Map<string, NodeShape>();
  for (const node of flattenPlanView(root)) shapes.set(node.path, sizer(node));
  const widthOf = (path: string): number => (shapes.get(path) as NodeShape).width;

  const laidOut = tree<PlanViewNode>()
    .nodeSize([1, 1])
    .separation((a, b) => {
      const span = (widthOf(a.data.path) + widthOf(b.data.path)) / 2;
      return span + COLUMN_GAP * (a.parent === b.parent ? 1 : SIBLING_GAP_FACTOR);
    })
    (hierarchy(root, node => node.children));

  const rowHeights: number[] = [];
  laidOut.each(node => {
    const height = (shapes.get(node.data.path) as NodeShape).height;
    rowHeights[node.depth] = Math.max(rowHeights[node.depth] ?? 0, height);
  });

  const rowCentres: number[] = [];
  let cursor = 0;
  for (let depth = 0; depth < rowHeights.length; depth++) {
    rowCentres[depth] = cursor + rowHeights[depth] / 2;
    cursor += rowHeights[depth] + ROW_GAP;
  }

  const positions = new Map<string, Point>();
  let minX = Infinity;
  let maxX = -Infinity;

  laidOut.each(node => {
    const shape = shapes.get(node.data.path) as NodeShape;
    positions.set(node.data.path, { x: node.x, y: rowCentres[node.depth] });
    minX = Math.min(minX, node.x - shape.width / 2);
    maxX = Math.max(maxX, node.x + shape.width / 2);
  });

  return {
    positions,
    shapes,
    bounds: { x: minX, y: 0, width: maxX - minX, height: Math.max(0, cursor - ROW_GAP) },
  };
}

function unionBounds(a: Bounds, b: Bounds): Bounds {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x: x - CANVAS_PADDING,
    y: y - CANVAS_PADDING,
    width: Math.max(a.x + a.width, b.x + b.width) - x + CANVAS_PADDING * 2,
    height: Math.max(a.y + a.height, b.y + b.height) - y + CANVAS_PADDING * 2,
  };
}

function parentsOf(root: PlanViewNode): Map<string, string> {
  const parents = new Map<string, string>();
  for (const node of flattenPlanView(root)) {
    for (const child of node.children) parents.set(child.path, node.path);
  }
  return parents;
}

function anchorPosition(
  path: string,
  parents: Map<string, string>,
  matches: Map<string, PlanMatch>,
  counterpartPath: (match: PlanMatch) => string | null,
  counterpartPositions: Map<string, Point>,
  ownPositions: Map<string, Point>,
): Point {
  let current: string | undefined = path;
  let suffix = '';

  while (current !== undefined) {
    const match = matches.get(current);
    const twin = match ? counterpartPath(match) : null;
    if (twin !== null && twin !== undefined) {
      const sameSlot = counterpartPositions.get(twin + suffix);
      if (sameSlot !== undefined) return sameSlot;
      const ancestor = counterpartPositions.get(twin);
      if (ancestor !== undefined) return ancestor;
    }
    const parent = parents.get(current);
    if (parent === undefined) break;
    suffix = current.slice(parent.length) + suffix;
    current = parent;
  }

  return ownPositions.get(path) as Point;
}

export function buildMorph(before: PlanViewNode, after: PlanViewNode, diff: PlanDiff, sizer: NodeSizer): MorphFrame {
  const beforeLayout = layoutPlan(before, sizer);
  const afterLayout = layoutPlan(after, sizer);
  const beforeParents = parentsOf(before);
  const afterParents = parentsOf(after);
  const beforeByPath = new Map(flattenPlanView(before).map(node => [node.path, node]));
  const afterByPath = new Map(flattenPlanView(after).map(node => [node.path, node]));

  const nodes: MorphNode[] = diff.matches.map(match => {
    const fromNode = match.beforePath === null ? null : beforeByPath.get(match.beforePath) ?? null;
    const toNode = match.afterPath === null ? null : afterByPath.get(match.afterPath) ?? null;

    const from = match.beforePath !== null
      ? beforeLayout.positions.get(match.beforePath) as Point
      : anchorPosition(
        match.afterPath as string,
        afterParents,
        diff.byAfterPath,
        candidate => candidate.beforePath,
        beforeLayout.positions,
        afterLayout.positions,
      );

    const to = match.afterPath !== null
      ? afterLayout.positions.get(match.afterPath) as Point
      : anchorPosition(
        match.beforePath as string,
        beforeParents,
        diff.byBeforePath,
        candidate => candidate.afterPath,
        afterLayout.positions,
        beforeLayout.positions,
      );

    const beforeShape = match.beforePath === null ? null : beforeLayout.shapes.get(match.beforePath) ?? null;
    const afterShape = match.afterPath === null ? null : afterLayout.shapes.get(match.afterPath) ?? null;

    return {
      key: match.key,
      status: match.status,
      from,
      to,
      fromNode,
      toNode,
      fromShape: (beforeShape ?? afterShape) as NodeShape,
      toShape: (afterShape ?? beforeShape) as NodeShape,
    };
  });

  const edges = new Map<string, MorphEdge>();
  const addEdges = (root: PlanViewNode, lookup: Map<string, PlanMatch>, side: 'before' | 'after'): void => {
    for (const parent of flattenPlanView(root)) {
      const parentKey = lookup.get(parent.path)?.key;
      if (parentKey === undefined) continue;
      for (const child of parent.children) {
        const childKey = lookup.get(child.path)?.key;
        if (childKey === undefined) continue;
        const key = `${parentKey}->${childKey}`;
        const existing = edges.get(key);
        if (existing) existing.status = 'kept';
        else edges.set(key, { key, parentKey, childKey, status: side === 'before' ? 'removed' : 'added' });
      }
    }
  };

  addEdges(before, diff.byBeforePath, 'before');
  addEdges(after, diff.byAfterPath, 'after');

  return {
    nodes,
    edges: [...edges.values()],
    viewBox: unionBounds(beforeLayout.bounds, afterLayout.bounds),
  };
}

export function nodeStyleAt(node: MorphNode, t: number): NodeStyle {
  const travel = progress(t, TRAVEL_PHASE);
  const showAfter = t >= 0.5;
  const base = {
    x: lerp(node.from.x, node.to.x, travel),
    y: lerp(node.from.y, node.to.y, travel),
    width: lerp(node.fromShape.width, node.toShape.width, travel),
    height: lerp(node.fromShape.height, node.toShape.height, travel),
  };

  if (node.status === 'removed') {
    const gone = progress(t, EXIT_PHASE);
    return {
      ...base,
      scale: lerp(1, GHOST_SCALE, gone),
      opacity: 1 - gone,
      content: node.fromNode,
      detailLines: node.fromShape.detailLines,
    };
  }

  if (node.status === 'added') {
    const arrived = progress(t, ENTER_PHASE);
    return {
      ...base,
      scale: lerp(GHOST_SCALE, 1, arrived),
      opacity: arrived,
      content: node.toNode,
      detailLines: node.toShape.detailLines,
    };
  }

  return {
    ...base,
    scale: 1,
    opacity: 1,
    content: showAfter ? node.toNode ?? node.fromNode : node.fromNode ?? node.toNode,
    detailLines: showAfter ? node.toShape.detailLines : node.fromShape.detailLines,
  };
}

export function edgeOpacityAt(edge: MorphEdge, t: number): number {
  if (edge.status === 'removed') return 1 - progress(t, EXIT_PHASE);
  if (edge.status === 'added') return progress(t, ENTER_PHASE);
  return 1;
}

export function edgePath(parent: NodeStyle, child: NodeStyle): string {
  const startY = parent.y + (parent.height * parent.scale) / 2;
  const endY = child.y - (child.height * child.scale) / 2;
  const midY = (startY + endY) / 2;
  return `M ${parent.x} ${startY} C ${parent.x} ${midY}, ${child.x} ${midY}, ${child.x} ${endY}`;
}
