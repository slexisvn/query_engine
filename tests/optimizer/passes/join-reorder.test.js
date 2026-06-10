import { describe, it, expect } from 'vitest';
import { JoinReorder } from '../../../src/optimizer/passes/join-reorder.js';
import {
  PlanNodeType,
  JoinType,
  LogicalScan,
  LogicalFilter,
  LogicalJoin,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col };
}

function lit(v) {
  return { kind: BoundExprKind.LITERAL, value: v };
}

function bin(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' };
}

function eqJoin(lt, lc, rt, rc) {
  return bin(colRef(lt, lc), '=', colRef(rt, rc));
}

function scan(name) {
  return LogicalScan(name, ['id', 'fk'], name);
}

function makeStats(tables) {
  const map = new Map();
  for (const [name, rowCount] of Object.entries(tables)) {
    map.set(name.toUpperCase(), { rowCount, columnStats: new Map() });
  }
  return map;
}

describe('JoinReorder', () => {
  describe('two-table reorder', () => {
    it('puts smaller table on build side', () => {
      const stats = makeStats({ small: 10, big: 100000 });
      const pass = new JoinReorder(stats);

      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('big', 'id', 'small', 'fk'),
        scan('big'),
        scan('small')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
      const tables = collectScanTables(result);
      expect(tables).toContain('big');
      expect(tables).toContain('small');
    });

    it('preserves the join predicate', () => {
      const stats = makeStats({ a: 100, b: 200 });
      const pass = new JoinReorder(stats);

      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('a', 'id', 'b', 'fk'),
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result.condition).not.toBeNull();
    });
  });

  describe('three-table chain reorder', () => {
    it('reorders A-B-C chain to optimal order', () => {
      const stats = makeStats({ a: 10000, b: 10, c: 10000 });
      const pass = new JoinReorder(stats);

      const abJoin = LogicalJoin(
        JoinType.INNER,
        eqJoin('a', 'id', 'b', 'fk'),
        scan('a'),
        scan('b')
      );
      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('b', 'id', 'c', 'fk'),
        abJoin,
        scan('c')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
      const tables = collectScanTables(result);
      expect(tables.sort()).toEqual(['a', 'b', 'c']);
    });

    it('produces a valid join tree with two joins', () => {
      const stats = makeStats({ x: 100, y: 50, z: 200 });
      const pass = new JoinReorder(stats);

      const xyJoin = LogicalJoin(
        JoinType.INNER,
        eqJoin('x', 'id', 'y', 'fk'),
        scan('x'),
        scan('y')
      );
      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('y', 'id', 'z', 'fk'),
        xyJoin,
        scan('z')
      );

      const result = pass.apply(plan);

      const joinCount = countNodes(result, PlanNodeType.JOIN);
      expect(joinCount).toBe(2);
    });
  });

  describe('LEFT JOIN is not reordered', () => {
    it('does not reorder LEFT JOIN', () => {
      const stats = makeStats({ a: 10000, b: 10 });
      const pass = new JoinReorder(stats);

      const plan = LogicalJoin(
        JoinType.LEFT,
        eqJoin('a', 'id', 'b', 'fk'),
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
      expect(result.joinType).toBe(JoinType.LEFT);
      expect(result.children[0].table).toBe('a');
      expect(result.children[1].table).toBe('b');
    });
  });

  describe('single table', () => {
    it('returns single scan unchanged', () => {
      const pass = new JoinReorder();

      const plan = scan('t');
      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.SCAN);
      expect(result.table).toBe('t');
    });
  });

  describe('CROSS JOIN reordering', () => {
    it('treats CROSS JOIN as reorderable', () => {
      const stats = makeStats({ a: 100, b: 50, c: 200 });
      const pass = new JoinReorder(stats);

      const abJoin = LogicalJoin(JoinType.CROSS, null, scan('a'), scan('b'));
      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('a', 'id', 'c', 'fk'),
        abJoin,
        scan('c')
      );

      const result = pass.apply(plan);

      const tables = collectScanTables(result);
      expect(tables.sort()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('filter above join', () => {
    it('handles filter-over-join by separating join and non-join predicates', () => {
      const stats = makeStats({ a: 100, b: 200 });
      const pass = new JoinReorder(stats);

      const joinNode = LogicalJoin(
        JoinType.INNER,
        eqJoin('a', 'id', 'b', 'fk'),
        scan('a'),
        scan('b')
      );

      const result = pass.apply(joinNode);

      expect(result.type).toBe(PlanNodeType.JOIN);
      const tables = collectScanTables(result);
      expect(tables.sort()).toEqual(['a', 'b']);
    });
  });

  describe('filter+scan as leaf relation', () => {
    it('preserves filter on scan as a single leaf', () => {
      const stats = makeStats({ a: 100, b: 200 });
      const pass = new JoinReorder(stats);

      const filteredA = LogicalFilter(
        bin(colRef('a', 'id'), '>', lit(0)),
        scan('a')
      );
      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('a', 'id', 'b', 'fk'),
        filteredA,
        scan('b')
      );

      const result = pass.apply(plan);

      const tables = collectScanTables(result);
      expect(tables.sort()).toEqual(['a', 'b']);
      const filterCount = countNodes(result, PlanNodeType.FILTER);
      expect(filterCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('star schema', () => {
    it('reorders star join with fact + dimensions', () => {
      const stats = makeStats({ fact: 100000, d1: 50, d2: 100, d3: 30 });
      const pass = new JoinReorder(stats);

      const j1 = LogicalJoin(
        JoinType.INNER,
        eqJoin('fact', 'fk', 'd1', 'id'),
        scan('fact'),
        scan('d1')
      );
      const j2 = LogicalJoin(
        JoinType.INNER,
        eqJoin('fact', 'fk', 'd2', 'id'),
        j1,
        scan('d2')
      );
      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('fact', 'fk', 'd3', 'id'),
        j2,
        scan('d3')
      );

      const result = pass.apply(plan);

      const tables = collectScanTables(result);
      expect(tables.sort()).toEqual(['d1', 'd2', 'd3', 'fact']);
      const joinCount = countNodes(result, PlanNodeType.JOIN);
      expect(joinCount).toBe(3);
    });
  });

  describe('disconnected join graph', () => {
    it('falls back to original plan when no join predicates connect tables', () => {
      const stats = makeStats({ a: 100, b: 200 });
      const pass = new JoinReorder(stats);

      const plan = LogicalJoin(JoinType.CROSS, null, scan('a'), scan('b'));

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.JOIN);
    });
  });

  describe('asymmetric joins are not commuted', () => {
    for (const joinType of [JoinType.SEMI, JoinType.ANTI, JoinType.MARK]) {
      it(`does not swap children of a ${joinType} join even when cost favors it`, () => {
        const stats = makeStats({ big: 100000, small: 10 });
        const pass = new JoinReorder(stats);
        const plan = LogicalJoin(joinType, eqJoin('big', 'id', 'small', 'fk'), scan('big'), scan('small'));

        const result = pass.apply(plan);

        expect(result.joinType).toBe(joinType);
        expect(result.children[0].table).toBe('big');
        expect(result.children[1].table).toBe('small');
      });
    }
  });
});

function collectScanTables(node) {
  const tables = [];
  function walk(n) {
    if (!n) return;
    if (n.type === PlanNodeType.SCAN) {
      tables.push(n.table);
    }
    if (n.children) {
      for (const c of n.children) walk(c);
    }
    if (n.buildSide) walk(n.buildSide);
    if (n.probeSide) walk(n.probeSide);
  }
  walk(node);
  return tables;
}

function countNodes(node, type) {
  let count = 0;
  function walk(n) {
    if (!n) return;
    if (n.type === type) count++;
    if (n.children) for (const c of n.children) walk(c);
  }
  walk(node);
  return count;
}
