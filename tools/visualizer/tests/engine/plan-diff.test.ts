import { describe, it, expect } from 'vitest';
import { diffPlans } from '../../src/engine/plan-diff.js';
import { flattenPlanView, toPlanView } from '../../src/engine/plan-view.js';
import { JOIN_TOPN_QUERY, planViewsFor, statusesByType, trace } from './helpers.js';

function statusOf(pass: string, type: string, side: 'before' | 'after'): string[] {
  const pipeline = trace(JOIN_TOPN_QUERY);
  const views = planViewsFor(pipeline, pass);
  const lookup = side === 'before' ? views.diff.byBeforePath : views.diff.byAfterPath;
  return statusesByType(side === 'before' ? views.before : views.after, lookup).get(type) ?? [];
}

describe('diffPlans on an unchanged plan', () => {
  it('matches every node of a plan against itself', () => {
    const view = toPlanView(trace(JOIN_TOPN_QUERY).compiled.logicalPlan);
    const diff = diffPlans(view, view);
    const statuses = new Set(diff.matches.map(match => match.status));

    expect([...statuses]).toEqual(['unchanged']);
  });

  it('pairs each node exactly once', () => {
    const view = toPlanView(trace(JOIN_TOPN_QUERY).compiled.logicalPlan);
    const diff = diffPlans(view, view);

    expect(diff.matches.length).toBe(flattenPlanView(view).length);
  });
});

describe('diffPlans identity across a rewrite', () => {
  it('gives a matched pair one shared key', () => {
    const { diff } = planViewsFor(trace(JOIN_TOPN_QUERY), 'PredicatePushdown');
    const paired = diff.matches.filter(match => match.beforePath !== null && match.afterPath !== null);

    for (const match of paired) {
      expect(diff.byBeforePath.get(match.beforePath as string)).toBe(diff.byAfterPath.get(match.afterPath as string));
    }
  });

  it('never reuses a key', () => {
    const { diff } = planViewsFor(trace(JOIN_TOPN_QUERY), 'TopNFusion');
    const keys = diff.matches.map(match => match.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('claims every node of both plans', () => {
    const { before, after, diff } = planViewsFor(trace(JOIN_TOPN_QUERY), 'TopNFusion');

    expect(diff.byBeforePath.size).toBe(flattenPlanView(before).length);
    expect(diff.byAfterPath.size).toBe(flattenPlanView(after).length);
  });
});

describe('diffPlans reads a pushdown as movement', () => {
  it('keeps the pushed filter as one moved node instead of a delete and an insert', () => {
    expect(statusOf('PredicatePushdown', 'Filter', 'after')).toEqual(['moved']);
  });

  it('reports the join it moved under as moved too', () => {
    expect(statusOf('PredicatePushdown', 'Join', 'after')).toEqual(['moved']);
  });

  it('adds and removes nothing when a predicate only changes depth', () => {
    const { diff } = planViewsFor(trace(JOIN_TOPN_QUERY), 'PredicatePushdown');
    const churn = diff.matches.filter(match => match.status === 'added' || match.status === 'removed');

    expect(churn).toEqual([]);
  });
});

describe('diffPlans reads a fusion as collapse and growth', () => {
  it('removes the sort and the limit it replaced', () => {
    expect(statusOf('TopNFusion', 'Sort', 'before')).toEqual(['removed']);
    expect(statusOf('TopNFusion', 'Limit', 'before')).toEqual(['removed']);
  });

  it('introduces the fused operator as an addition', () => {
    expect(statusOf('TopNFusion', 'TopN', 'after')).toEqual(['added']);
  });

  it('leaves the untouched subtree below it alone', () => {
    expect(statusOf('TopNFusion', 'Scan', 'after')).toEqual(['unchanged', 'unchanged']);
  });
});

describe('diffPlans reads an in-place rewrite as modification', () => {
  it('keeps a filter whose predicate was simplified in place', () => {
    expect(statusOf('ExpressionSimplifier', 'Filter', 'after')).toEqual(['modified']);
  });

  it('leaves every other node unchanged', () => {
    const { after, diff } = planViewsFor(trace(JOIN_TOPN_QUERY), 'ExpressionSimplifier');
    const others = flattenPlanView(after)
      .filter(node => node.type !== 'Filter')
      .map(node => diff.byAfterPath.get(node.path)?.status);

    expect(new Set(others)).toEqual(new Set(['unchanged']));
  });
});
