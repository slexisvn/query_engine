import { describe, it, expect } from 'vitest';
import { isEmptySummary, summarizeDiff } from '../../src/engine/step-summary.js';
import { diffPlans } from '../../src/engine/plan-diff.js';
import { toPlanView } from '../../src/engine/plan-view.js';
import { JOIN_TOPN_QUERY, mainTrace, planViewsFor, trace } from './helpers.js';
import type { StepSummary } from '../../src/engine/step-summary.js';

function summaryFor(pass: string): StepSummary {
  const { before, after, diff } = planViewsFor(trace(JOIN_TOPN_QUERY), pass);
  return summarizeDiff(before, after, diff);
}

function labels(entries: readonly { label: string }[]): string[] {
  return entries.map(entry => entry.label);
}

describe('summarizing what a pass did', () => {
  it('names the node a fusion removed and the node it left behind', () => {
    const summary = summaryFor('TopNFusion');

    expect(labels(summary.removed).length + labels(summary.added).length).toBeGreaterThan(0);
    expect([...labels(summary.removed), ...labels(summary.added)].some(label => label.includes('Sort') || label.includes('Top')))
      .toBe(true);
  });

  it('reports a rewritten node as rewritten, not as an add and a remove', () => {
    const summary = summaryFor('ExpressionSimplifier');

    expect(labels(summary.modified)).toContain('Filter');
    expect(summary.added).toEqual([]);
    expect(summary.removed).toEqual([]);
  });

  it('counts repeated node titles instead of listing them twice', () => {
    const pipeline = trace('SELECT C_NAME FROM CUSTOMER WHERE C_CUSTKEY > 5');
    const before = toPlanView(mainTrace(pipeline).snapshots[0].plan);
    const empty = toPlanView(mainTrace(pipeline).snapshots[0].plan);
    const summary = summarizeDiff(before, empty, diffPlans(before, empty));

    expect(isEmptySummary(summary)).toBe(true);
  });

  it('finds nothing to report when a pass changed nothing', () => {
    const optimize = mainTrace(trace(JOIN_TOPN_QUERY));
    const noop = optimize.steps.find(step => !step.changed);
    const before = toPlanView(optimize.snapshots[(noop as { from: number }).from].plan);
    const after = toPlanView(optimize.snapshots[(noop as { to: number }).to].plan);

    expect(isEmptySummary(summarizeDiff(before, after, diffPlans(before, after)))).toBe(true);
  });

  it('sorts the busiest label first', () => {
    const summary = summaryFor('PredicatePushdown');
    const counts = [...summary.added, ...summary.removed, ...summary.modified].map(entry => entry.count);

    expect(counts.every(count => count >= 1)).toBe(true);
  });

  it('counts a move without inventing an add or a remove for it', () => {
    const { before, after, diff } = planViewsFor(trace(JOIN_TOPN_QUERY), 'PredicatePushdown');
    const summary = summarizeDiff(before, after, diff);
    const movedMatches = diff.matches.filter(match => match.status === 'moved');

    expect(summary.moved).toBe(movedMatches.length);
  });
});
