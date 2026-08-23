import { describe, it, expect } from 'vitest';
import { planViewToText, toPlanView } from '../../src/engine/plan-view.js';
import { countKind, diffLines } from '../../src/engine/text-diff.js';
import { JOIN_TOPN_QUERY, mainTrace, stepFor, trace } from './helpers.js';

function kinds(before: string[], after: string[]): string {
  return diffLines(before, after).map(row => `${row.kind[0]}${row.text}`).join(' ');
}

describe('diffLines', () => {
  it('marks every line of an identical pair as context', () => {
    expect(kinds(['a', 'b'], ['a', 'b'])).toBe('ca cb');
  });

  it('pairs a rewritten line as one removal and one addition', () => {
    expect(kinds(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe('ca rb ax cc');
  });

  it('reports an inserted line without touching its neighbours', () => {
    expect(kinds(['a', 'c'], ['a', 'b', 'c'])).toBe('ca ab cc');
  });

  it('reports a deleted line without touching its neighbours', () => {
    expect(kinds(['a', 'b', 'c'], ['a', 'c'])).toBe('ca rb cc');
  });

  it('keeps a reordered line rather than rewriting the whole block', () => {
    const rows = diffLines(['a', 'b', 'c', 'd'], ['a', 'c', 'b', 'd']);
    expect(countKind(rows, 'context')).toBe(3);
  });

  it('folds a line that only changed indentation into one re-nested row', () => {
    const rows = diffLines(['  x'], ['    x']);
    expect(rows).toEqual([{ kind: 'moved', text: '    x' }]);
  });

  it('shows the new indentation for a re-nested line', () => {
    const rows = diffLines(['a', '  x'], ['a', '      x']);
    expect(rows[1].text).toBe('      x');
  });

  it('still reports a genuine replacement next to a re-nested line', () => {
    const rows = diffLines(['  x', '  y'], ['    x', '  z']);
    expect(countKind(rows, 'moved')).toBe(1);
    expect(countKind(rows, 'removed')).toBe(1);
    expect(countKind(rows, 'added')).toBe(1);
  });

  it('treats an empty original as all additions', () => {
    expect(kinds([], ['a', 'b'])).toBe('aa ab');
  });

  it('treats an empty result as all removals', () => {
    expect(kinds(['a', 'b'], [])).toBe('ra rb');
  });
});

describe('diffLines over a real pass', () => {
  function planLines(plan: Parameters<typeof toPlanView>[0]): string[] {
    return planViewToText(toPlanView(plan));
  }

  it('shows a predicate rewrite as a single replaced line', () => {
    const pipeline = trace(JOIN_TOPN_QUERY);
    const step = stepFor(pipeline, 'ExpressionSimplifier');
    const { snapshots } = mainTrace(pipeline);
    const rows = diffLines(planLines(snapshots[step.from].plan), planLines(snapshots[step.to].plan));

    expect(countKind(rows, 'removed')).toBe(1);
    expect(countKind(rows, 'added')).toBe(1);
  });

  it('reduces a fusion to the two operators it consumed and the one it produced', () => {
    const pipeline = trace(JOIN_TOPN_QUERY);
    const step = stepFor(pipeline, 'TopNFusion');
    const { snapshots } = mainTrace(pipeline);
    const rows = diffLines(planLines(snapshots[step.from].plan), planLines(snapshots[step.to].plan));

    expect(countKind(rows, 'removed')).toBe(2);
    expect(countKind(rows, 'added')).toBe(1);
  });

  it('shows column pruning as a change instead of an identical plan', () => {
    const pipeline = trace('SELECT C_NAME FROM CUSTOMER');
    const step = stepFor(pipeline, 'ProjectionPushdown');
    const { snapshots } = mainTrace(pipeline);
    const rows = diffLines(planLines(snapshots[step.from].plan), planLines(snapshots[step.to].plan));

    expect(countKind(rows, 'context')).toBeLessThan(rows.length);
  });

  it('shows block pruning as a change instead of an identical plan', () => {
    const pipeline = trace("SELECT O_ORDERKEY FROM ORDERS WHERE O_TOTALPRICE > 500");
    const step = stepFor(pipeline, 'ScanPruning');
    const { snapshots } = mainTrace(pipeline);
    const rows = diffLines(planLines(snapshots[step.from].plan), planLines(snapshots[step.to].plan));

    expect(countKind(rows, 'context')).toBeLessThan(rows.length);
  });

  it('calls a pushdown a re-nesting rather than a rewrite', () => {
    const pipeline = trace(JOIN_TOPN_QUERY);
    const step = stepFor(pipeline, 'PredicatePushdown');
    const { snapshots } = mainTrace(pipeline);
    const rows = diffLines(planLines(snapshots[step.from].plan), planLines(snapshots[step.to].plan));

    expect(countKind(rows, 'removed')).toBe(0);
    expect(countKind(rows, 'added')).toBe(0);
    expect(countKind(rows, 'moved')).toBeGreaterThan(0);
  });
});
