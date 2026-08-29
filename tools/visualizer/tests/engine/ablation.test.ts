import { describe, it, expect } from 'vitest';
import { buildStatistics, createDemoCatalog, DEFAULT_ROW_COUNTS } from '../../src/engine/demo-catalog.js';
import { repeatsOf, traceQuery } from '../../src/engine/trace.js';
import { JOIN_TOPN_QUERY, mainTrace, trace } from './helpers.js';
import type { PipelineTrace } from '../../src/engine/trace.js';

const PUSHDOWN = 'PredicatePushdown';

function traceWithout(sql: string, ...passes: string[]): PipelineTrace {
  const outcome = traceQuery(sql, createDemoCatalog(), buildStatistics(DEFAULT_ROW_COUNTS), new Set(passes));
  if (!outcome.ok) throw new Error(`${outcome.error.phase}: ${outcome.error.message}`);
  return outcome.trace;
}

function finalCost(pipeline: PipelineTrace): number | null {
  const snapshots = mainTrace(pipeline).snapshots;
  return snapshots[snapshots.length - 1].cost;
}

describe('dropping a pass from the pipeline', () => {
  it('stops running the pass it was told to drop', () => {
    const ablated = traceWithout(JOIN_TOPN_QUERY, PUSHDOWN);

    expect(mainTrace(trace(JOIN_TOPN_QUERY)).steps.some(step => step.pass === PUSHDOWN)).toBe(true);
    expect(mainTrace(ablated).steps.some(step => step.pass === PUSHDOWN)).toBe(false);
  });

  it('leaves every other pass in place', () => {
    const full = new Set(mainTrace(trace(JOIN_TOPN_QUERY)).steps.map(step => step.pass));
    const ablated = new Set(mainTrace(traceWithout(JOIN_TOPN_QUERY, PUSHDOWN)).steps.map(step => step.pass));

    full.delete(PUSHDOWN);
    expect([...ablated].sort()).toEqual([...full].sort());
  });

  it('costs the plan more once the pushdown is gone', () => {
    const baseline = finalCost(trace(JOIN_TOPN_QUERY));
    const ablated = finalCost(traceWithout(JOIN_TOPN_QUERY, PUSHDOWN));

    expect(ablated as number).toBeGreaterThan(baseline as number);
  });

  it('records which passes were dropped on the trace', () => {
    expect([...traceWithout(JOIN_TOPN_QUERY, PUSHDOWN).disabled]).toEqual([PUSHDOWN]);
    expect([...trace(JOIN_TOPN_QUERY).disabled]).toEqual([]);
  });

  it('changes nothing when the named pass is not in the pipeline', () => {
    const baseline = trace(JOIN_TOPN_QUERY);
    const ablated = traceWithout(JOIN_TOPN_QUERY, 'NoSuchPass');

    expect(mainTrace(ablated).steps).toHaveLength(mainTrace(baseline).steps.length);
    expect(finalCost(ablated)).toBe(finalCost(baseline));
  });

  it('drops several passes at once', () => {
    const ablated = traceWithout(JOIN_TOPN_QUERY, PUSHDOWN, 'TopNFusion');
    const passes = new Set(mainTrace(ablated).steps.map(step => step.pass));

    expect(passes.has(PUSHDOWN)).toBe(false);
    expect(passes.has('TopNFusion')).toBe(false);
  });
});

describe('timing the passes', () => {
  it('gives every step a finite non-negative duration', () => {
    const steps = mainTrace(trace(JOIN_TOPN_QUERY)).steps;

    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every(step => Number.isFinite(step.ms) && step.ms >= 0)).toBe(true);
  });

  it('totals the pipeline to the sum of its steps', () => {
    const optimize = mainTrace(trace(JOIN_TOPN_QUERY));
    const summed = optimize.steps.reduce((total, step) => total + step.ms, 0);

    expect(optimize.totalMs).toBeCloseTo(summed);
  });

  it('shrinks the total when passes are removed', () => {
    const full = mainTrace(trace(JOIN_TOPN_QUERY)).steps.length;
    const ablated = mainTrace(traceWithout(JOIN_TOPN_QUERY, PUSHDOWN)).steps.length;

    expect(ablated).toBeLessThan(full);
  });
});

describe('spotting a fixpoint that cycles', () => {
  const event = (stage: string, signature: string, changed: boolean) => ({ stage, signature, changed });

  it('flags a changed step that lands on a plan the stage already had', () => {
    expect(repeatsOf([
      event('Predicates', 'a', true),
      event('Predicates', 'b', true),
      event('Predicates', 'a', true),
    ])).toEqual([null, null, 0]);
  });

  it('leaves a pipeline that only moves forward unflagged', () => {
    expect(repeatsOf([
      event('Predicates', 'a', true),
      event('Predicates', 'b', true),
      event('Predicates', 'c', true),
    ])).toEqual([null, null, null]);
  });

  it('does not call a no-op a cycle', () => {
    expect(repeatsOf([
      event('Predicates', 'a', true),
      event('Predicates', 'a', false),
    ])).toEqual([null, null]);
  });

  it('keeps each stage to its own history', () => {
    expect(repeatsOf([
      event('Predicates', 'a', true),
      event('Joins', 'a', true),
    ])).toEqual([null, null]);
  });

  it('reports nothing for the real pipeline, which settles', () => {
    const steps = mainTrace(trace(JOIN_TOPN_QUERY)).steps;

    expect(steps.filter(step => step.repeats !== null)).toEqual([]);
  });
});
