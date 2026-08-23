import { describe, it, expect } from 'vitest';
import { buildStatistics, createDemoCatalog, DEFAULT_ROW_COUNTS } from '../../src/engine/demo-catalog.js';
import { traceQuery } from '../../src/engine/trace.js';
import { JOIN_TOPN_QUERY, mainTrace, trace } from './helpers.js';

function traceOf(sql: string) {
  return traceQuery(sql, createDemoCatalog(), buildStatistics(DEFAULT_ROW_COUNTS));
}

describe('traceQuery pipeline', () => {
  it('records one snapshot more than it records steps', () => {
    const pipeline = trace(JOIN_TOPN_QUERY);
    expect(mainTrace(pipeline).snapshots.length).toBe(mainTrace(pipeline).steps.length + 1);
  });

  it('starts from the unoptimized logical plan', () => {
    const pipeline = trace(JOIN_TOPN_QUERY);
    expect(mainTrace(pipeline).snapshots[0].plan).toBe(pipeline.compiled.logicalPlan);
  });

  it('links every step to the snapshot pair it transformed', () => {
    const pipeline = trace(JOIN_TOPN_QUERY);
    const gaps = mainTrace(pipeline).steps.filter(step => step.to !== step.from + 1);
    expect(gaps).toEqual([]);
  });

  it('runs every pass of the default pipeline', () => {
    const pipeline = trace(JOIN_TOPN_QUERY);
    const passes = new Set(mainTrace(pipeline).steps.map(step => step.pass));
    expect(passes.has('ExpressionSimplifier')).toBe(true);
    expect(passes.has('PredicatePushdown')).toBe(true);
    expect(passes.has('TopNFusion')).toBe(true);
  });

  it('marks a pass that rewrote the plan as changed', () => {
    const pipeline = trace(JOIN_TOPN_QUERY);
    const fusion = mainTrace(pipeline).steps.filter(step => step.pass === 'TopNFusion');
    expect(fusion.some(step => step.changed)).toBe(true);
  });

  it('marks a pass that left the plan alone as unchanged', () => {
    const pipeline = trace('SELECT R_NAME FROM REGION');
    const unnesting = mainTrace(pipeline).steps.filter(step => step.pass === 'SubqueryUnnesting');
    expect(unnesting.every(step => !step.changed)).toBe(true);
  });

  it('numbers the iterations of the predicate fixpoint stage', () => {
    const pipeline = trace(JOIN_TOPN_QUERY);
    const iterations = mainTrace(pipeline).steps
      .filter(step => step.stage === 'PredicateOptimization')
      .map(step => step.iteration);
    expect(Math.max(...iterations)).toBeGreaterThan(0);
  });

  it('costs every snapshot', () => {
    const pipeline = trace(JOIN_TOPN_QUERY);
    const uncosted = mainTrace(pipeline).snapshots.filter(snapshot => !Number.isFinite(snapshot.cost));
    expect(uncosted).toEqual([]);
  });

  it('ends cheaper than it started', () => {
    const { snapshots } = mainTrace(trace(JOIN_TOPN_QUERY));
    expect(snapshots[snapshots.length - 1].cost).toBeLessThan(snapshots[0].cost as number);
  });

  it('produces a physical plan for the optimized tree', () => {
    const pipeline = trace(JOIN_TOPN_QUERY);
    expect(pipeline.subjects[0].physical?.type).toBeTruthy();
  });

  it('reports a syntax error against the parse phase', () => {
    const outcome = traceOf('SELECT FROM WHERE');
    expect(outcome.ok ? null : outcome.error.phase).toBe('parse');
  });

  it('reports an unknown table against the bind phase', () => {
    const outcome = traceOf('SELECT * FROM NO_SUCH_TABLE');
    expect(outcome.ok ? null : outcome.error.phase).toBe('bind');
  });

  it('refuses DDL with a readable message', () => {
    const outcome = traceOf('CREATE TABLE T (A INT)');
    expect(outcome.ok ? '' : outcome.error.message).toContain('SELECT');
  });
});
