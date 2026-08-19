import { describe, it, expect } from 'vitest';
import { JoinReorder } from '../../../src/optimizer/passes/join-reorder.js';
import {
  PlanNodeType,
  JoinType,
  LogicalScan,
  LogicalFilter,
  LogicalJoin,
  LogicalProject,
  LogicalDistinct,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { planSignature } from '../../../src/optimizer/plan-signature.js';

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

  describe('derived table alongside the table it reads', () => {
    function planWithDerivedCopyOfA() {
      const derived = LogicalProject([colRef('a', 'id')], scan('a'), 'S');
      const abJoin = LogicalJoin(JoinType.INNER, eqJoin('a', 'id', 'b', 'fk'), scan('a'), scan('b'));
      return LogicalJoin(JoinType.INNER, eqJoin('b', 'id', 's', 'id'), abJoin, derived);
    }

    it('folds the derived relation into the reordered tree instead of leaving it pinned on top', () => {
      const stats = makeStats({ a: 100000, b: 10 });

      const result = new JoinReorder(stats).apply(planWithDerivedCopyOfA());

      expect(result.children.map(child => child.type)).not.toContain(PlanNodeType.PROJECT);
      expect(collectScanTables(result).sort()).toEqual(['a', 'a', 'b']);
      expect(countNodes(result, PlanNodeType.JOIN)).toBe(2);
    });

    it('turns the predicate naming the derived alias into a join condition, not a leftover filter', () => {
      const stats = makeStats({ a: 100000, b: 10 });

      const result = new JoinReorder(stats).apply(planWithDerivedCopyOfA());

      expect(countNodes(result, PlanNodeType.FILTER)).toBe(0);
      expect([...condRefs(result.condition)].sort()).toEqual(['A', 'B']);
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

  describe('multi-table bridge predicate does not create cross products', () => {
    it('keeps every join condition within its own subtree (no fabricated leaf joins)', () => {
      const stats = makeStats({ a: 100, b: 100, c: 100, d: 100 });
      const pass = new JoinReorder(stats);

      // Two local equi-joins (A-B, C-D) plus one bridge spanning all four:
      // (A.fk + B.fk) = (C.fk + D.fk). The bridge must NOT be decomposed into an
      // all-pairs clique (which would let the planner pick e.g. A⋈C at a leaf and
      // attach the bridge there, referencing absent tables B,D).
      const bridge = bin(
        bin(colRef('a', 'fk'), '+', colRef('b', 'fk')),
        '=',
        bin(colRef('c', 'fk'), '+', colRef('d', 'fk')),
      );
      const cond = bin(bin(eqJoin('a', 'id', 'b', 'id'), 'AND', eqJoin('c', 'id', 'd', 'id')), 'AND', bridge);
      const crossABC = LogicalJoin(
        JoinType.CROSS, null,
        LogicalJoin(JoinType.CROSS, null, scan('a'), scan('b')),
        scan('c'),
      );
      const plan = LogicalJoin(JoinType.INNER, cond, crossABC, scan('d'));

      const result = pass.apply(plan);

      // Invariant the clique bug violated: a join's condition may only reference
      // tables that exist beneath that join.
      const violations = [];
      walkJoins(result, (join) => {
        const available = new Set(collectScanTables(join).map((t) => t.toUpperCase()));
        for (const ref of condRefs(join.condition)) {
          if (!available.has(ref)) violations.push(`${ref} not in [${[...available].sort()}]`);
        }
      });
      expect(violations).toEqual([]);
      expect(collectScanTables(result).sort()).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  describe('predicate preservation', () => {
    it('keeps a predicate whose two sides share a table', () => {
      const pass = new JoinReorder(makeStats({ a: 100, b: 200 }));
      // (A.fk + B.fk) = B.id — the two operand sides overlap on B, so it is not a
      // clean two-sided edge, but it still constrains the result.
      const overlapping = bin(bin(colRef('a', 'fk'), '+', colRef('b', 'fk')), '=', colRef('b', 'id'));
      const plan = LogicalJoin(
        JoinType.INNER,
        bin(eqJoin('a', 'id', 'b', 'id'), 'AND', overlapping),
        scan('a'),
        scan('b'),
      );

      const result = pass.apply(plan);

      expect(collectConditionLeaves(result).has(overlapping)).toBe(true);
    });

    it('keeps a predicate referencing an alias that is not a join input', () => {
      const pass = new JoinReorder(makeStats({ a: 100, b: 200 }));
      const dangling = bin(colRef('a', 'fk'), '=', colRef('zz', 'id'));
      const plan = LogicalJoin(
        JoinType.INNER,
        bin(eqJoin('a', 'id', 'b', 'id'), 'AND', dangling),
        scan('a'),
        scan('b'),
      );

      const result = pass.apply(plan);

      expect(collectConditionLeaves(result).has(dangling)).toBe(true);
    });
  });
});

function collectConditionLeaves(node) {
  const leaves = new Set();
  const addConjuncts = (expr) => {
    if (!expr) return;
    if (expr.kind === BoundExprKind.BINARY && expr.op === 'AND') {
      addConjuncts(expr.left);
      addConjuncts(expr.right);
      return;
    }
    leaves.add(expr);
  };
  const walk = (n) => {
    if (!n) return;
    if (n.type === PlanNodeType.JOIN || n.type === PlanNodeType.FILTER) addConjuncts(n.condition);
    for (const child of n.children || []) walk(child);
  };
  walk(node);
  return leaves;
}

function walkJoins(node, fn) {
  if (!node) return;
  if (node.type === PlanNodeType.JOIN) fn(node);
  for (const c of node.children || []) walkJoins(c, fn);
  if (node.buildSide) walkJoins(node.buildSide, fn);
  if (node.probeSide) walkJoins(node.probeSide, fn);
}

function condRefs(expr) {
  const refs = new Set();
  function walk(e) {
    if (!e) return;
    if (e.kind === BoundExprKind.COLUMN_REF && e.tableAlias) refs.add(e.tableAlias.toUpperCase());
    if (e.left) walk(e.left);
    if (e.right) walk(e.right);
    if (e.operand) walk(e.operand);
    if (e.args) for (const a of e.args) walk(a);
  }
  walk(expr);
  return refs;
}

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

describe('JoinReorder determinism', () => {
  function subqueryJoinPlan() {
    const leftScan = LogicalScan('ORDERS', [{ name: 'O_CUSTKEY', dataType: 'INT32' }], 'ORDERS');
    const rightScan = LogicalScan('CUSTOMER', [{ name: 'C_CUSTKEY', dataType: 'INT32' }], 'CUSTOMER');
    const thirdScan = LogicalScan('NATION', [{ name: 'N_NATIONKEY', dataType: 'INT32' }], 'NATION');

    const condition = {
      kind: BoundExprKind.BINARY,
      op: '=',
      left: { kind: BoundExprKind.COLUMN_REF, tableAlias: 'ORDERS', columnName: 'O_CUSTKEY' },
      right: { kind: BoundExprKind.COLUMN_REF, tableAlias: 'CUSTOMER', columnName: 'C_CUSTKEY' },
    };

    const inner = LogicalJoin(JoinType.INNER, condition, LogicalDistinct(leftScan), rightScan);
    return LogicalJoin(JoinType.CROSS, null, inner, LogicalDistinct(thirdScan));
  }

  it('produces the same plan on repeated runs of one pass instance', () => {
    const pass = new JoinReorder(new Map());
    const first = planSignature(pass.apply(subqueryJoinPlan()));
    const second = planSignature(pass.apply(subqueryJoinPlan()));

    expect(second).toBe(first);
  });

  it('produces the same plan across separate pass instances', () => {
    const first = planSignature(new JoinReorder(new Map()).apply(subqueryJoinPlan()));
    const second = planSignature(new JoinReorder(new Map()).apply(subqueryJoinPlan()));

    expect(second).toBe(first);
  });

  it('never leaves a random synthetic alias in the emitted plan', () => {
    const signature = planSignature(new JoinReorder(new Map()).apply(subqueryJoinPlan()));
    expect(signature).not.toMatch(/_rel_[a-z0-9]{4}[^0-9]/);
  });
});
