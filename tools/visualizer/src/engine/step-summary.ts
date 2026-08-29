import { flattenPlanView } from './plan-view.js';
import type { NodeStatus, PlanDiff } from './plan-diff.js';
import type { PlanViewNode } from './plan-view.js';

export interface LabelCount {
  label: string;
  count: number;
}

export interface StepSummary {
  added: LabelCount[];
  removed: LabelCount[];
  modified: LabelCount[];
  moved: number;
}

function titlesByPath(root: PlanViewNode): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const node of flattenPlanView(root)) byPath.set(node.path, node.title);
  return byPath;
}

function tally(titles: readonly string[]): LabelCount[] {
  const counts = new Map<string, number>();
  for (const title of titles) counts.set(title, (counts.get(title) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

export function summarizeDiff(before: PlanViewNode, after: PlanViewNode, diff: PlanDiff): StepSummary {
  const beforeTitles = titlesByPath(before);
  const afterTitles = titlesByPath(after);
  const collected: Record<Exclude<NodeStatus, 'unchanged' | 'moved'>, string[]> = {
    added: [],
    removed: [],
    modified: [],
  };
  let moved = 0;

  for (const match of diff.matches) {
    if (match.status === 'moved') {
      moved++;
      continue;
    }
    if (match.status === 'unchanged') continue;

    const title = match.status === 'removed'
      ? match.beforePath !== null ? beforeTitles.get(match.beforePath) : undefined
      : match.afterPath !== null ? afterTitles.get(match.afterPath) : undefined;
    if (title !== undefined) collected[match.status].push(title);
  }

  return {
    added: tally(collected.added),
    removed: tally(collected.removed),
    modified: tally(collected.modified),
    moved,
  };
}

export function isEmptySummary(summary: StepSummary): boolean {
  return summary.added.length === 0
    && summary.removed.length === 0
    && summary.modified.length === 0
    && summary.moved === 0;
}
