import { describe, it, expect } from 'vitest';
import { inlineCTEScans } from '../../../src/distributed/planner/cte-inline.js';
import { PlanNodeType, LogicalScan, LogicalProject, LogicalCTEScan, LogicalJoin, JoinType } from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { DataType } from '../../../src/storage/data-type.js';

function projection(name, index) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: 'T', columnName: name, columnIndex: index, dataType: DataType.INT32, outputName: name };
}

function body(table = 'T', names = ['A']) {
  return LogicalProject(names.map(projection), LogicalScan(table, names.map(name => ({ name }))));
}

describe('inlineCTEScans', () => {
  it('returns the plan untouched when there are no definitions', () => {
    const plan = LogicalCTEScan('D', 1, 'D');

    expect(inlineCTEScans(plan, null)).toBe(plan);
    expect(inlineCTEScans(plan, new Map())).toBe(plan);
  });

  it('replaces a CTE scan with its definition', () => {
    const plan = LogicalCTEScan('D', 1, 'D');

    const result = inlineCTEScans(plan, new Map([['D', body()]]));
    expect(result.type).toBe(PlanNodeType.PROJECT);
    expect(result.children[0].type).toBe(PlanNodeType.SCAN);
  });

  it('matches the definition case-insensitively', () => {
    const result = inlineCTEScans(LogicalCTEScan('d', 1, 'd'), new Map([['D', body()]]));

    expect(result.type).toBe(PlanNodeType.PROJECT);
  });

  it('re-aliases the inlined output to the reference alias', () => {
    const result = inlineCTEScans(LogicalCTEScan('D', 1, 'X'), new Map([['D', body()]]));

    expect(result.outputAlias).toBe('X');
  });

  it('expands every reference of a CTE used more than once', () => {
    const plan = LogicalJoin(JoinType.INNER, null, LogicalCTEScan('D', 1, 'a'), LogicalCTEScan('D', 1, 'b'));

    const result = inlineCTEScans(plan, new Map([['D', body()]]));
    expect(result.children.map(c => c.type)).toEqual([PlanNodeType.PROJECT, PlanNodeType.PROJECT]);
    expect(result.children.map(c => c.outputAlias)).toEqual(['a', 'b']);
  });

  it('expands a CTE that references another CTE', () => {
    const definitions = new Map([
      ['INNER', body()],
      ['OUTER', LogicalProject([projection('A', 0)], LogicalCTEScan('INNER', 1, 'INNER'))],
    ]);

    const result = inlineCTEScans(LogicalCTEScan('OUTER', 2, 'OUTER'), definitions);
    expect(result.children[0].type).toBe(PlanNodeType.PROJECT);
    expect(result.children[0].children[0].type).toBe(PlanNodeType.SCAN);
  });

  it('leaves a self-referencing CTE scan in place rather than expanding forever', () => {
    const definitions = new Map([['D', LogicalProject([projection('A', 0)], LogicalCTEScan('D', 1, 'D'))]]);

    const result = inlineCTEScans(LogicalCTEScan('D', 1, 'D'), definitions);
    expect(result.children[0].type).toBe(PlanNodeType.CTE_SCAN);
  });

  it('leaves an unknown CTE scan in place', () => {
    const scan = LogicalCTEScan('MISSING', 1, 'MISSING');

    expect(inlineCTEScans(scan, new Map([['D', body()]]))).toBe(scan);
  });
});
