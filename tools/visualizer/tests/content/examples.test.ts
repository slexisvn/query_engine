import { describe, it, expect } from 'vitest';
import { createDefaultOptimizer } from '@engine/optimizer/optimizer-pipeline.js';
import { formatPlan } from '@engine/planner/plan-formatter.js';
import { EXAMPLES } from '../../src/content/examples.js';
import { PASS_NOTES } from '../../src/content/pass-notes.js';
import { buildStatistics, createDemoCatalog, DEFAULT_ROW_COUNTS } from '../../src/engine/demo-catalog.js';
import { traceQuery } from '../../src/engine/trace.js';

const catalog = createDemoCatalog();
const statistics = buildStatistics(DEFAULT_ROW_COUNTS);

function changedPasses(sql: string): Set<string> {
  const outcome = traceQuery(sql, catalog, statistics);
  if (!outcome.ok) throw new Error(`${outcome.error.phase}: ${outcome.error.message}`);
  return new Set(outcome.trace.subjects.flatMap(subject => subject.optimize.steps).filter(step => step.changed).map(step => step.pass));
}

describe('bundled examples', () => {
  it.each(EXAMPLES.map(example => [example.name, example] as const))('%s compiles into a plan', (_name, example) => {
    const outcome = traceQuery(example.sql, catalog, statistics);
    expect(outcome.ok ? null : outcome.error).toBe(null);
  });

  it.each(EXAMPLES.map(example => [example.name, example] as const))('%s fires the passes it teaches', (_name, example) => {
    const fired = changedPasses(example.sql);
    expect(example.passes.filter(pass => !fired.has(pass))).toEqual([]);
  });

  it.each(EXAMPLES.map(example => [example.name, example] as const))('%s names only real passes', (_name, example) => {
    expect(example.passes.filter(pass => !(pass in PASS_NOTES))).toEqual([]);
  });
});

describe('pass notes', () => {
  it('documents every pass the default pipeline runs', () => {
    const pipeline = createDefaultOptimizer({ catalog, statistics });
    const undocumented = pipeline.listPasses().filter(pass => !(pass in PASS_NOTES));

    expect(undocumented).toEqual([]);
  });

  it('documents no pass the pipeline does not run', () => {
    const pipeline = createDefaultOptimizer({ catalog, statistics });
    const known = new Set(pipeline.listPasses());
    const stale = Object.keys(PASS_NOTES).filter(pass => !known.has(pass));

    expect(stale).toEqual([]);
  });
});

describe('statistics drive the plan', () => {
  function finalPlan(sql: string, rowCounts: Record<string, number>): string {
    const outcome = traceQuery(sql, catalog, buildStatistics(rowCounts));
    if (!outcome.ok) throw new Error(outcome.error.message);
    const optimize = outcome.trace.subjects[0].optimize;
    return formatPlan(optimize.snapshots[optimize.snapshots.length - 1].plan);
  }

  it('picks a different join order when a table grows', () => {
    const example = EXAMPLES.find(candidate => candidate.name === 'Join reorder');
    if (!example) throw new Error('missing the join reorder example');

    const base = finalPlan(example.sql, DEFAULT_ROW_COUNTS);
    const skewed = finalPlan(example.sql, { ...DEFAULT_ROW_COUNTS, NATION: 2_000_000 });

    expect(skewed).not.toBe(base);
  });

  it('costs a plan higher when its inputs grow', () => {
    const example = EXAMPLES[0];
    const cheap = traceQuery(example.sql, catalog, buildStatistics({ ...DEFAULT_ROW_COUNTS, ORDERS: 100 }));
    const dear = traceQuery(example.sql, catalog, buildStatistics({ ...DEFAULT_ROW_COUNTS, ORDERS: 10_000_000 }));
    if (!cheap.ok || !dear.ok) throw new Error('both traces should compile');

    const costOf = (outcome: typeof cheap) => {
      const snapshots = outcome.trace.subjects[0].optimize.snapshots;
      return snapshots[snapshots.length - 1].cost as number;
    };

    expect(costOf(dear)).toBeGreaterThan(costOf(cheap));
  });
});
