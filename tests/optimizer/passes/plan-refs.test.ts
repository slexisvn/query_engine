import { describe, it, expect } from 'vitest';
import { collectPlanRefs, refBelongsToPlan, outputName } from '../../../src/optimizer/passes/plan-refs.js';
import { JoinType, LogicalFilter, LogicalJoin, LogicalProject, LogicalScan, LogicalSort } from '../../../src/planner/logical-plan.js';
import { colRef, eqJoin } from '../../helpers/plan-fixtures.js';

function scan(name) {
  return LogicalScan(name, [{ name: 'ID' }, { name: 'VAL' }], name);
}

function chainOfJoins(depth) {
  let plan = scan('T0');
  for (let i = 1; i <= depth; i++) {
    plan = LogicalJoin(JoinType.INNER, eqJoin(`T${i - 1}`, 'id', `T${i}`, 'id'), plan, scan(`T${i}`));
  }
  return plan;
}

describe('collectPlanRefs', () => {
  it('collects the alias and columns of a scan', () => {
    const refs = collectPlanRefs(scan('EMP'));
    expect([...refs.aliases]).toEqual(['EMP']);
    expect([...refs.columns].sort()).toEqual(['ID', 'VAL']);
  });

  it('unions both sides of a join', () => {
    const refs = collectPlanRefs(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')));
    expect([...refs.aliases].sort()).toEqual(['A', 'B']);
  });

  it('reaches every relation in a deep join chain', () => {
    const refs = collectPlanRefs(chainOfJoins(20));
    expect(refs.aliases.size).toBe(21);
    expect(refs.aliases.has('T20')).toBe(true);
  });

  it('stops at a projection by default', () => {
    const project = LogicalProject([colRef('A', 'id')], scan('A'));
    expect(collectPlanRefs(project).columns.has('VAL')).toBe(false);
  });

  it('sees through a projection when asked to', () => {
    const project = LogicalProject([colRef('A', 'id')], scan('A'));
    expect(collectPlanRefs(project, { recurseProject: true }).columns.has('VAL')).toBe(true);
  });

  it('drops empty alias and column names', () => {
    const refs = collectPlanRefs(LogicalProject([colRef('', '')], scan('A')));
    expect(refs.aliases.has('')).toBe(false);
    expect(refs.columns.has('')).toBe(false);
  });

  it('returns the same object for repeated calls on one node', () => {
    const node = chainOfJoins(3);
    expect(collectPlanRefs(node)).toBe(collectPlanRefs(node));
  });

  it('shares the child result through an order-preserving node', () => {
    const child = scan('A');
    const filter = LogicalFilter(null, child);
    const sort = LogicalSort([{ expr: colRef('A', 'id'), direction: 'ASC' }], filter);

    expect(collectPlanRefs(filter)).toBe(collectPlanRefs(child));
    expect(collectPlanRefs(sort)).toBe(collectPlanRefs(child));
  });

  it('keeps separate caches for the two projection modes', () => {
    const project = LogicalProject([colRef('A', 'id')], scan('A'));
    expect(collectPlanRefs(project)).not.toBe(collectPlanRefs(project, { recurseProject: true }));
  });
});

describe('refBelongsToPlan', () => {
  const refs = collectPlanRefs(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')));

  it('matches a qualified reference by alias', () => {
    expect(refBelongsToPlan({ tableAlias: 'A', columnName: 'ID' }, refs)).toBe(true);
    expect(refBelongsToPlan({ tableAlias: 'C', columnName: 'ID' }, refs)).toBe(false);
  });

  it('falls back to the column name when unqualified', () => {
    expect(refBelongsToPlan({ tableAlias: '', columnName: 'ID' }, refs)).toBe(true);
    expect(refBelongsToPlan({ tableAlias: '', columnName: 'MISSING' }, refs)).toBe(false);
  });

  it('treats a lone dot as unqualified under dottedAlias', () => {
    expect(refBelongsToPlan({ tableAlias: '.', columnName: 'ID' }, refs, { dottedAlias: true })).toBe(true);
  });
});

describe('outputName', () => {
  it('prefers the output name over the alias and the column name', () => {
    expect(outputName({ outputName: 'a', alias: 'b', name: 'c' })).toBe('A');
    expect(outputName({ alias: 'b', name: 'c' })).toBe('B');
    expect(outputName({ columnName: 'd' })).toBe('D');
    expect(outputName({})).toBe('');
  });
});
