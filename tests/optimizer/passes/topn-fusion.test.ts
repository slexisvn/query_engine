import { describe, it, expect } from 'vitest';
import { TopNFusion } from '../../../src/optimizer/passes/topn-fusion.js';
import {
  PlanNodeType,
  LogicalScan,
  LogicalSort,
  LogicalLimit,
  LogicalProject,
  LogicalFilter,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const pass = new TopNFusion();

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col };
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

describe('TopNFusion', () => {
  describe('LIMIT + SORT → TOP_N', () => {
    it('fuses LIMIT over SORT into TOP_N', () => {
      const sort = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        scan('t')
      );
      const plan = LogicalLimit(10, 0, sort);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.TOP_N);
      expect(result.count).toBe(10);
      expect(result.orderKeys).toEqual(sort.orderKeys);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });

    it('preserves offset in TOP_N', () => {
      const sort = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        scan('t')
      );
      const plan = LogicalLimit(5, 20, sort);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.TOP_N);
      expect(result.count).toBe(5);
      expect(result.offset).toBe(20);
    });

    it('caps _cardinality at count', () => {
      const sort = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        scan('t')
      );
      sort._cardinality = 1000;
      const plan = LogicalLimit(10, 0, sort);

      const result = pass.apply(plan);

      expect(result._cardinality).toBe(10);
    });

    it('uses sort _cardinality when smaller than count', () => {
      const sort = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        scan('t')
      );
      sort._cardinality = 3;
      const plan = LogicalLimit(10, 0, sort);

      const result = pass.apply(plan);

      expect(result._cardinality).toBe(3);
    });
  });

  describe('LIMIT + PROJECT + SORT → PROJECT + TOP_N', () => {
    it('pushes TOP_N through PROJECT', () => {
      const sort = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        scan('t')
      );
      const project = LogicalProject(
        [colRef('t', 'id'), colRef('t', 'val')],
        sort
      );
      const plan = LogicalLimit(5, 0, project);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.PROJECT);
      expect(result.children[0].type).toBe(PlanNodeType.TOP_N);
      expect(result.children[0].count).toBe(5);
    });

    it('preserves sort keys in TOP_N through PROJECT', () => {
      const orderKeys = [
        { expr: colRef('t', 'id'), direction: 'DESC' },
        { expr: colRef('t', 'val'), direction: 'ASC' },
      ];
      const sort = LogicalSort(orderKeys, scan('t'));
      const project = LogicalProject([colRef('t', 'id')], sort);
      const plan = LogicalLimit(3, 0, project);

      const result = pass.apply(plan);

      expect(result.children[0].type).toBe(PlanNodeType.TOP_N);
      expect(result.children[0].orderKeys).toEqual(orderKeys);
    });
  });

  describe('no fusion', () => {
    it('keeps LIMIT when child is not SORT', () => {
      const plan = LogicalLimit(10, 0, scan('t'));

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.LIMIT);
    });

    it('keeps LIMIT when child is FILTER (not SORT)', () => {
      const filter = LogicalFilter(
        bin(colRef('t', 'val'), '>', lit(0)),
        scan('t')
      );
      const plan = LogicalLimit(10, 0, filter);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.LIMIT);
    });

    it('keeps LIMIT+PROJECT when PROJECT child is not SORT', () => {
      const project = LogicalProject(
        [colRef('t', 'id')],
        scan('t')
      );
      const plan = LogicalLimit(10, 0, project);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.LIMIT);
    });
  });

  describe('preserves _sortedBy from fused sort', () => {
    it('copies _sortedBy to TOP_N node', () => {
      const sort = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        scan('t')
      );
      sort._sortedBy = ['T.ID'];
      const plan = LogicalLimit(10, 0, sort);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.TOP_N);
      expect(result._sortedBy).toEqual(['T.ID']);
    });
  });

  describe('recursive fusion', () => {
    it('fuses LIMIT+SORT at deeper level too', () => {
      const innerSort = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        scan('t')
      );
      const innerLimit = LogicalLimit(50, 0, innerSort);
      const project = LogicalProject([colRef('t', 'id')], innerLimit);
      const outerSort = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'DESC' }],
        project
      );
      const plan = LogicalLimit(10, 0, outerSort);

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.TOP_N);

      function findTopN(n) {
        const nodes = [];
        if (!n) return nodes;
        if (n.type === PlanNodeType.TOP_N) nodes.push(n);
        for (const c of n.children || []) nodes.push(...findTopN(c));
        return nodes;
      }
      const topNs = findTopN(result);
      expect(topNs.length).toBe(2);
    });
  });
});
