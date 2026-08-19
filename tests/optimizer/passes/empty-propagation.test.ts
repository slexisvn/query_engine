import { describe, it, expect } from 'vitest';
import { EmptyPropagation } from '../../../src/optimizer/passes/empty-propagation.js';
import {
  PlanNodeType,
  JoinType,
  LogicalScan,
  LogicalFilter,
  LogicalProject,
  LogicalSort,
  LogicalLimit,
  LogicalJoin,
  LogicalAggregate,
  LogicalUnion,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const pass = new EmptyPropagation();
const EMPTY = { type: PlanNodeType.EMPTY, children: [] };

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col };
}

function literal(v) {
  return { kind: BoundExprKind.LITERAL, value: v };
}

function scan(name) {
  return LogicalScan(name, ['id'], name);
}

describe('EmptyPropagation', () => {
  describe('single-child nodes over EMPTY', () => {
    it('propagates EMPTY through PROJECT', () => {
      const plan = LogicalProject([colRef('t', 'id')], EMPTY);
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });

    it('propagates EMPTY through SORT', () => {
      const plan = LogicalSort([{ expr: colRef('t', 'id'), direction: 'ASC' }], EMPTY);
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });

    it('propagates EMPTY through FILTER', () => {
      const plan = LogicalFilter(
        { kind: BoundExprKind.BINARY, op: '>', left: colRef('t', 'id'), right: literal(0) },
        EMPTY
      );
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });

    it('propagates EMPTY through LIMIT', () => {
      const plan = LogicalLimit(10, 0, EMPTY);
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });
  });

  describe('FILTER with false literal', () => {
    it('replaces FILTER(false) with EMPTY', () => {
      const plan = LogicalFilter(literal(false), scan('t'));
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });

    it('does not replace FILTER(true) with EMPTY', () => {
      const plan = LogicalFilter(literal(true), scan('t'));
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.FILTER);
    });
  });

  describe('LIMIT 0', () => {
    it('replaces LIMIT(0) with EMPTY', () => {
      const plan = LogicalLimit(0, 0, scan('t'));
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });

    it('does not replace LIMIT(1) with EMPTY', () => {
      const plan = LogicalLimit(1, 0, scan('t'));
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.LIMIT);
    });
  });

  describe('AGGREGATE over EMPTY', () => {
    it('keeps scalar aggregate (no GROUP BY) over EMPTY', () => {
      const plan = LogicalAggregate([], [{ fn: 'COUNT', args: [] }], EMPTY);
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.AGGREGATE);
    });

    it('propagates EMPTY through grouped aggregate', () => {
      const plan = LogicalAggregate(
        [colRef('t', 'status')],
        [{ fn: 'COUNT', args: [] }],
        EMPTY
      );
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });
  });

  describe('JOIN with EMPTY child', () => {
    it('INNER JOIN with empty left produces EMPTY', () => {
      const plan = LogicalJoin(JoinType.INNER, null, EMPTY, scan('b'));
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });

    it('INNER JOIN with empty right produces EMPTY', () => {
      const plan = LogicalJoin(JoinType.INNER, null, scan('a'), EMPTY);
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });

    it('CROSS JOIN with empty side produces EMPTY', () => {
      const plan = LogicalJoin(JoinType.CROSS, null, EMPTY, scan('b'));
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });

    it('LEFT JOIN with empty left produces EMPTY', () => {
      const plan = LogicalJoin(JoinType.LEFT, null, EMPTY, scan('b'));
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });

    it('LEFT JOIN with empty right preserves the join', () => {
      const plan = LogicalJoin(JoinType.LEFT, null, scan('a'), EMPTY);
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.JOIN);
    });

    it('FULL JOIN with both empty produces EMPTY', () => {
      const plan = LogicalJoin(JoinType.FULL, null, EMPTY, EMPTY);
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });

    it('FULL JOIN with one empty side preserves the join', () => {
      const plan = LogicalJoin(JoinType.FULL, null, scan('a'), EMPTY);
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.JOIN);
    });
  });

  describe('UNION with EMPTY children', () => {
    it('both EMPTY produces EMPTY', () => {
      const plan = LogicalUnion(EMPTY, EMPTY, true);
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });

    it('left EMPTY returns right child', () => {
      const right = scan('b');
      const plan = LogicalUnion(EMPTY, right, true);
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.SCAN);
      expect(result.table).toBe('b');
    });

    it('right EMPTY returns left child', () => {
      const left = scan('a');
      const plan = LogicalUnion(left, EMPTY, true);
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.SCAN);
      expect(result.table).toBe('a');
    });

    it('neither EMPTY preserves the UNION', () => {
      const plan = LogicalUnion(scan('a'), scan('b'), true);
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.SET_OP);
    });
  });

  describe('deep propagation', () => {
    it('propagates EMPTY upward through multiple layers', () => {
      const plan = LogicalProject(
        [colRef('t', 'id')],
        LogicalSort(
          [{ expr: colRef('t', 'id'), direction: 'ASC' }],
          LogicalFilter(
            { kind: BoundExprKind.BINARY, op: '>', left: colRef('t', 'id'), right: literal(0) },
            EMPTY
          )
        )
      );
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });

    it('stops propagation at scalar aggregate', () => {
      const plan = LogicalProject(
        [colRef('t', 'cnt')],
        LogicalAggregate([], [{ fn: 'COUNT', args: [] }], EMPTY)
      );
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.PROJECT);
      expect(result.children[0].type).toBe(PlanNodeType.AGGREGATE);
    });
  });

  describe('non-empty plans pass through', () => {
    it('does not modify a plan with no EMPTY nodes', () => {
      const plan = LogicalFilter(
        { kind: BoundExprKind.BINARY, op: '=', left: colRef('t', 'id'), right: literal(1) },
        scan('t')
      );
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });
  });
});
