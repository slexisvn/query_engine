import { describe, it, expect } from 'vitest';
import { SubqueryUnnesting } from '../../../src/optimizer/passes/subquery-unnesting.js';
import {
  PlanNodeType,
  JoinType,
  LogicalScan,
  LogicalFilter,
  LogicalProject,
  LogicalAggregate,
  LogicalLimit,
  setChildren,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const pass = new SubqueryUnnesting();

function colRef(table, col, opts = {}) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col, depth: 0, isCorrelated: false, ...opts };
}

function corrRef(table, col) {
  return colRef(table, col, { isCorrelated: true, depth: 1 });
}

function lit(v) {
  return { kind: BoundExprKind.LITERAL, value: v };
}

function bin(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' };
}

function scan(name) {
  return LogicalScan(name, ['id', 'val'], name);
}

function depJoin(subqueryType, left, right, correlated, condition, markColumn = null, compareOp = '=') {
  return {
    type: PlanNodeType.DEPENDENT_JOIN,
    subqueryType,
    correlatedColumns: correlated,
    condition: condition || null,
    compareOp,
    markColumn,
    children: [left, right],
  };
}

describe('SubqueryUnnesting', () => {
  describe('EXISTS → SEMI JOIN', () => {
    it('converts EXISTS dependent join to SEMI join', () => {
      const subquery = LogicalFilter(
        bin(corrRef('a', 'id'), '=', colRef('b', 'id')),
        scan('b')
      );
      const plan = depJoin('EXISTS', scan('a'), subquery, [corrRef('a', 'id')]);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
      expect(result.joinType).toBe(JoinType.SEMI);
    });

    it('extracts correlated predicate into join condition', () => {
      const subquery = LogicalFilter(
        bin(corrRef('a', 'id'), '=', colRef('b', 'id')),
        scan('b')
      );
      const plan = depJoin('EXISTS', scan('a'), subquery, [corrRef('a', 'id')]);

      const result = pass.apply(plan);

      expect(result.condition).not.toBeNull();
      expect(result.condition.op).toBe('=');
    });

    it('removes projection wrapper from EXISTS subquery', () => {
      const projected = LogicalProject(
        [colRef('b', 'id')],
        LogicalFilter(
          bin(corrRef('a', 'id'), '=', colRef('b', 'id')),
          scan('b')
        )
      );
      const plan = depJoin('EXISTS', scan('a'), projected, [corrRef('a', 'id')]);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
      expect(result.joinType).toBe(JoinType.SEMI);
      expect(result.children[1].type).not.toBe(PlanNodeType.PROJECT);
    });
  });

  describe('NOT EXISTS → ANTI JOIN', () => {
    it('converts NOT_EXISTS dependent join to ANTI join', () => {
      const subquery = LogicalFilter(
        bin(corrRef('a', 'id'), '=', colRef('b', 'id')),
        scan('b')
      );
      const plan = depJoin('NOT_EXISTS', scan('a'), subquery, [corrRef('a', 'id')]);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
      expect(result.joinType).toBe(JoinType.ANTI);
    });
  });

  describe('IN → SEMI JOIN', () => {
    it('converts IN subquery to SEMI join with equality condition', () => {
      const subquery = LogicalProject(
        [colRef('b', 'val')],
        scan('b')
      );
      const plan = depJoin('IN', scan('a'), subquery, [], colRef('a', 'val'));

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
      expect(result.joinType).toBe(JoinType.SEMI);
      expect(result.condition).not.toBeNull();
    });

    it('combines IN equality with correlated predicates', () => {
      const subquery = LogicalProject(
        [colRef('b', 'val')],
        LogicalFilter(
          bin(corrRef('a', 'id'), '=', colRef('b', 'id')),
          scan('b')
        )
      );
      const plan = depJoin('IN', scan('a'), subquery, [corrRef('a', 'id')], colRef('a', 'val'));

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
      expect(result.joinType).toBe(JoinType.SEMI);
    });

    it('strips the passthrough subquery projection so correlation columns stay available', () => {
      const subquery = LogicalProject(
        [colRef('b', 'val')],
        LogicalFilter(
          bin(corrRef('a', 'id'), '=', colRef('b', 'id')),
          scan('b')
        )
      );
      const plan = depJoin('IN', scan('a'), subquery, [corrRef('a', 'id')], colRef('a', 'val'));

      const result = pass.apply(plan);

      expect(result.children[1].type).not.toBe(PlanNodeType.PROJECT);
    });
  });

  describe('MARK JOIN', () => {
    it('converts a MARK dependent join to a MARK join carrying the requested mark column', () => {
      const subquery = LogicalProject(
        [colRef('b', 'val')],
        scan('b')
      );
      const plan = depJoin('MARK', scan('a'), subquery, [], colRef('a', 'val'), '__mark_0');

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
      expect(result.joinType).toBe(JoinType.MARK);
      expect(result.markColumn).toBe('__mark_0');
    });

    it('builds the membership condition from the outer expression and the subquery output', () => {
      const subquery = LogicalProject(
        [colRef('b', 'val')],
        scan('b')
      );
      const plan = depJoin('MARK', scan('a'), subquery, [], colRef('a', 'val'), '__mark_0');

      const result = pass.apply(plan);

      expect(result.condition.op).toBe('=');
      expect(result.condition.left.columnName).toBe('val');
      expect(result.condition.left.tableAlias).toBe('a');
      expect(result.condition.right.columnName).toBe('val');
      expect(result.condition.right.tableAlias).toBe('b');
    });

    it('uses the dependent join comparison operator in the membership condition', () => {
      const subquery = LogicalProject(
        [colRef('b', 'val')],
        scan('b')
      );
      const plan = depJoin('MARK', scan('a'), subquery, [], colRef('a', 'val'), '__mark_0', '>');

      const result = pass.apply(plan);

      expect(result.condition.op).toBe('>');
    });

    it('leaves an unknown subquery type untouched instead of looping', () => {
      const plan = depJoin('SOMETHING_ELSE', scan('a'), scan('b'), []);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.DEPENDENT_JOIN);
    });
  });

  describe('SCALAR → LEFT/SINGLE JOIN', () => {
    it('converts scalar subquery without aggregate to SINGLE join', () => {
      const subquery = LogicalProject(
        [colRef('b', 'val')],
        LogicalFilter(
          bin(corrRef('a', 'id'), '=', colRef('b', 'id')),
          scan('b')
        )
      );
      const plan = depJoin('SCALAR', scan('a'), subquery, [corrRef('a', 'id')]);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
      expect(result.joinType).toBe(JoinType.SINGLE);
    });

    it('converts scalar subquery with aggregate to LEFT join', () => {
      const agg = LogicalAggregate(
        [],
        [{ fn: 'COUNT', args: [], outputName: 'cnt' }],
        LogicalFilter(
          bin(corrRef('a', 'id'), '=', colRef('b', 'id')),
          scan('b')
        )
      );
      const subquery = LogicalProject([colRef('', 'cnt')], agg);
      const plan = depJoin('SCALAR', scan('a'), subquery, [corrRef('a', 'id')]);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
      expect(result.joinType).toBe(JoinType.LEFT);
    });

    it('adds group-by from correlated predicates when scalar has aggregate', () => {
      const agg = LogicalAggregate(
        [],
        [{ fn: 'SUM', args: [colRef('b', 'val')], outputName: 'total' }],
        LogicalFilter(
          bin(corrRef('a', 'id'), '=', colRef('b', 'id')),
          scan('b')
        )
      );
      const subquery = LogicalProject([colRef('', 'total')], agg);
      const plan = depJoin('SCALAR', scan('a'), subquery, [corrRef('a', 'id')]);

      const result = pass.apply(plan);

      function findAgg(n) {
        if (!n) return null;
        if (n.type === PlanNodeType.AGGREGATE) return n;
        for (const c of n.children || []) {
          const found = findAgg(c);
          if (found) return found;
        }
        return null;
      }
      const aggNode = findAgg(result);
      expect(aggNode).not.toBeNull();
      expect(aggNode.groupBy.length).toBeGreaterThan(0);
    });
  });

  describe('correlation extraction', () => {
    it('keeps non-correlated predicates as local filter', () => {
      const subquery = LogicalFilter(
        bin(
          bin(corrRef('a', 'id'), '=', colRef('b', 'id')),
          'AND',
          bin(colRef('b', 'val'), '>', lit(0))
        ),
        scan('b')
      );
      const plan = depJoin('EXISTS', scan('a'), subquery, [corrRef('a', 'id')]);

      const result = pass.apply(plan);

      function findFilters(n) {
        const filters = [];
        if (!n) return filters;
        if (n.type === PlanNodeType.FILTER) filters.push(n);
        for (const c of n.children || []) filters.push(...findFilters(c));
        return filters;
      }

      const filters = findFilters(result);
      const hasLocalFilter = filters.some(f => {
        const cond = f.condition;
        return cond.op === '>' || (cond.left && cond.left.columnName === 'val');
      });
      expect(hasLocalFilter).toBe(true);
    });
  });

  describe('row-limited correlated subqueries', () => {
    function findNode(node, type) {
      if (!node) return null;
      if (node.type === type) return node;
      for (const child of node.children || []) {
        const found = findNode(child, type);
        if (found) return found;
      }
      return null;
    }

    function correlatedLimitPlan(count, offset = 0) {
      const subquery = LogicalLimit(count, offset, LogicalProject(
        [colRef('b', 'val')],
        LogicalFilter(bin(corrRef('a', 'id'), '=', colRef('b', 'id')), scan('b'))
      ));
      return depJoin('IN', scan('a'), subquery, [corrRef('a', 'id')], colRef('a', 'val'));
    }

    it('replaces the limit with a row number partitioned by the correlation key', () => {
      const result = pass.apply(correlatedLimitPlan(1));

      expect(findNode(result, PlanNodeType.LIMIT)).toBeNull();
      const window = findNode(result, PlanNodeType.WINDOW);
      expect(window).not.toBeNull();
      expect(window.windowExprs).toHaveLength(1);
      expect(window.windowExprs[0].name).toBe('ROW_NUMBER');
      expect(window.windowExprs[0].partitionBy).toEqual([
        expect.objectContaining({ tableAlias: 'b', columnName: 'id' }),
      ]);
    });

    it('gates the row number by the requested count', () => {
      const result = pass.apply(correlatedLimitPlan(3));

      const window = findNode(result, PlanNodeType.WINDOW);
      const gate = findNode(result, PlanNodeType.FILTER);
      expect(gate.children[0]).toBe(window);
      expect(gate.condition.op).toBe('<=');
      expect(gate.condition.left).toBe(window.windowExprs[0]);
      expect(gate.condition.right.value).toBe(3);
    });

    it('gates both ends of the range when an offset is present', () => {
      const result = pass.apply(correlatedLimitPlan(2, 5));

      const gate = findNode(result, PlanNodeType.FILTER);
      expect(gate.condition.op).toBe('AND');
      expect(gate.condition.left.op).toBe('>');
      expect(gate.condition.left.right.value).toBe(5);
      expect(gate.condition.right.op).toBe('<=');
      expect(gate.condition.right.right.value).toBe(7);
    });

    it('ranks below the projection so the correlation column stays in scope', () => {
      const result = pass.apply(correlatedLimitPlan(1));

      const window = findNode(result, PlanNodeType.WINDOW);
      expect(window.windowExprs[0].partitionBy[0].columnName).toBe('id');
      expect(window.children[0].type).toBe(PlanNodeType.SCAN);
    });

    it('leaves an uncorrelated limit applying globally', () => {
      const subquery = LogicalLimit(1, 0, LogicalProject(
        [colRef('b', 'val')],
        LogicalFilter(bin(colRef('b', 'val'), '>', lit(5)), scan('b'))
      ));
      const plan = depJoin('IN', scan('a'), subquery, [], colRef('a', 'val'));

      const result = pass.apply(plan);

      expect(findNode(result, PlanNodeType.LIMIT)).not.toBeNull();
      expect(findNode(result, PlanNodeType.WINDOW)).toBeNull();
    });

    it('rejects a row limit correlated by a non-equality predicate', () => {
      const subquery = LogicalLimit(1, 0, LogicalProject(
        [colRef('b', 'val')],
        LogicalFilter(bin(corrRef('a', 'val'), '>', colRef('b', 'val')), scan('b'))
      ));
      const plan = depJoin('IN', scan('a'), subquery, [corrRef('a', 'val')], colRef('a', 'val'));

      expect(() => pass.apply(plan)).toThrow(/cannot be decorrelated/);
    });
  });

  describe('multiple dependent joins', () => {
    it('unnests all dependent joins in a single apply', () => {
      const sub1 = LogicalFilter(
        bin(corrRef('a', 'id'), '=', colRef('b', 'id')),
        scan('b')
      );
      const firstJoin = depJoin('EXISTS', scan('a'), sub1, [corrRef('a', 'id')]);
      const sub2 = LogicalFilter(
        bin(corrRef('a', 'id'), '=', colRef('c', 'id')),
        scan('c')
      );
      const plan = depJoin('EXISTS', firstJoin, sub2, [corrRef('a', 'id')]);

      const result = pass.apply(plan);

      function findDepJoins(n) {
        if (!n) return 0;
        let count = n.type === PlanNodeType.DEPENDENT_JOIN ? 1 : 0;
        for (const c of n.children || []) count += findDepJoins(c);
        return count;
      }
      expect(findDepJoins(result)).toBe(0);
    });
  });
});
