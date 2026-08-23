import { hashValue } from '@engine/utils/hash.js';
import { flattenPlanView } from './plan-view.js';
import type { LogicalPlanNode } from '@engine/planner/logical-plan.js';
import type { PlanViewNode } from './plan-view.js';

const INTERNAL_FIELD_PREFIX = '_';
const SECOND_HASH_SALT = 'plan-diff/salt|';

export type NodeStatus = 'unchanged' | 'moved' | 'modified' | 'added' | 'removed';

export interface PlanMatch {
  key: string;
  beforePath: string | null;
  afterPath: string | null;
  status: NodeStatus;
}

export interface PlanDiff {
  matches: PlanMatch[];
  byBeforePath: Map<string, PlanMatch>;
  byAfterPath: Map<string, PlanMatch>;
}

function localSignature(node: LogicalPlanNode): string {
  return JSON.stringify(node, (key, value) => {
    if (key === 'children') return undefined;
    if (key.startsWith(INTERNAL_FIELD_PREFIX)) return undefined;
    if (typeof value === 'bigint') return `${value}n`;
    return value;
  });
}

function digest(text: string): string {
  return `${hashValue(text)}:${hashValue(SECOND_HASH_SALT + text)}`;
}

interface IndexedTree {
  nodes: PlanViewNode[];
  localByPath: Map<string, string>;
  subtreeByPath: Map<string, string>;
}

function indexTree(root: PlanViewNode): IndexedTree {
  const nodes = flattenPlanView(root);
  const localByPath = new Map<string, string>();
  const subtreeByPath = new Map<string, string>();

  for (const node of nodes) localByPath.set(node.path, digest(localSignature(node.node)));

  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const parts = [localByPath.get(node.path) as string];
    for (const child of node.children) parts.push(subtreeByPath.get(child.path) as string);
    subtreeByPath.set(node.path, digest(parts.join('|')));
  }

  return { nodes, localByPath, subtreeByPath };
}

function pathAffinity(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  const limit = Math.min(left.length, right.length);
  let shared = 0;
  while (shared < limit && left[shared] === right[shared]) shared++;
  return shared * 1000 - Math.abs(left.length - right.length);
}

class MatchBuilder {
  readonly matches: PlanMatch[] = [];
  private counter = 0;

  pair(beforePath: string | null, afterPath: string | null, status: NodeStatus): void {
    this.matches.push({ key: `k${this.counter++}`, beforePath, afterPath, status });
  }
}

function subtreePaths(node: PlanViewNode, into: string[] = []): string[] {
  into.push(node.path);
  for (const child of node.children) subtreePaths(child, into);
  return into;
}

function claimSubtree(
  afterNode: PlanViewNode,
  beforeNode: PlanViewNode,
  builder: MatchBuilder,
  status: NodeStatus,
  claimedBefore: Set<string>,
  claimedAfter: Set<string>,
): void {
  const afterPaths = subtreePaths(afterNode);
  const beforePaths = subtreePaths(beforeNode);

  for (let i = 0; i < afterPaths.length; i++) {
    builder.pair(beforePaths[i], afterPaths[i], i === 0 ? status : 'unchanged');
    claimedBefore.add(beforePaths[i]);
    claimedAfter.add(afterPaths[i]);
  }
}

function bestCandidate(afterPath: string, candidates: readonly string[], claimed: Set<string>): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    if (claimed.has(candidate)) continue;
    const score = pathAffinity(afterPath, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function groupByDigest(nodes: readonly PlanViewNode[], digests: Map<string, string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const key = digests.get(node.path) as string;
    const bucket = groups.get(key);
    if (bucket) bucket.push(node.path);
    else groups.set(key, [node.path]);
  }
  return groups;
}

export function diffPlans(before: PlanViewNode, after: PlanViewNode): PlanDiff {
  const beforeIndex = indexTree(before);
  const afterIndex = indexTree(after);
  const beforeByPath = new Map(beforeIndex.nodes.map(node => [node.path, node]));

  const claimedBefore = new Set<string>();
  const claimedAfter = new Set<string>();
  const builder = new MatchBuilder();

  const bySubtree = groupByDigest(beforeIndex.nodes, beforeIndex.subtreeByPath);
  const matchWholeSubtrees = (node: PlanViewNode): void => {
    const candidates = bySubtree.get(afterIndex.subtreeByPath.get(node.path) as string) ?? [];
    const matched = bestCandidate(node.path, candidates, claimedBefore);
    if (matched !== null) {
      const status: NodeStatus = matched === node.path ? 'unchanged' : 'moved';
      claimSubtree(node, beforeByPath.get(matched) as PlanViewNode, builder, status, claimedBefore, claimedAfter);
      return;
    }
    for (const child of node.children) matchWholeSubtrees(child);
  };
  matchWholeSubtrees(after);

  const byLocal = groupByDigest(
    beforeIndex.nodes.filter(node => !claimedBefore.has(node.path)),
    beforeIndex.localByPath,
  );

  for (const node of afterIndex.nodes) {
    if (claimedAfter.has(node.path)) continue;
    const candidates = byLocal.get(afterIndex.localByPath.get(node.path) as string) ?? [];
    const matched = bestCandidate(node.path, candidates, claimedBefore);
    if (matched === null) continue;
    builder.pair(matched, node.path, matched === node.path ? 'unchanged' : 'moved');
    claimedBefore.add(matched);
    claimedAfter.add(node.path);
  }

  for (const node of afterIndex.nodes) {
    if (claimedAfter.has(node.path) || claimedBefore.has(node.path)) continue;
    const twin = beforeByPath.get(node.path);
    if (twin === undefined || twin.type !== node.type) continue;
    builder.pair(node.path, node.path, 'modified');
    claimedBefore.add(node.path);
    claimedAfter.add(node.path);
  }

  for (const node of afterIndex.nodes) {
    if (!claimedAfter.has(node.path)) builder.pair(null, node.path, 'added');
  }
  for (const node of beforeIndex.nodes) {
    if (!claimedBefore.has(node.path)) builder.pair(node.path, null, 'removed');
  }

  return {
    matches: builder.matches,
    byBeforePath: new Map(builder.matches.filter(m => m.beforePath !== null).map(m => [m.beforePath as string, m])),
    byAfterPath: new Map(builder.matches.filter(m => m.afterPath !== null).map(m => [m.afterPath as string, m])),
  };
}
