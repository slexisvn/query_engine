import { describe, it, expect } from 'vitest';
import { PhysicalDesign } from '../../../src/optimizer/passes/physical-design.js';
import {
  PlanNodeType,
  JoinType,
  PhysicalStrategy,
  LogicalScan,
  LogicalFilter,
  LogicalJoin,
  LogicalSort,
  LogicalAggregate,
  LogicalLimit,
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
  return LogicalScan(name, ['id', 'val'], name);
}

function makeStats(tables) {
  const map = new Map();
  for (const [name, info] of Object.entries(tables)) {
    const colStats = new Map();
    if (info.columns) {
      for (const [col, s] of Object.entries(info.columns)) {
        colStats.set(col.toUpperCase(), s);
      }
    }
    map.set(name.toUpperCase(), { rowCount: info.rowCount, columnStats: colStats });
  }
  return map;
}

describe('PhysicalDesign', () => {
  describe('join strategy selection', () => {
    it('defaults to HASH join for inner join', () => {
      const pass = new PhysicalDesign();
      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('a', 'id', 'b', 'id'),
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result.physicalStrategy).toBe(PhysicalStrategy.HASH);
    });

    it('chooses MERGE join when both sides are sorted on join keys', () => {
      const pass = new PhysicalDesign();
      const sortedA = LogicalSort([{ expr: colRef('a', 'id'), direction: 'ASC' }], scan('a'));
      const sortedB = LogicalSort([{ expr: colRef('b', 'id'), direction: 'ASC' }], scan('b'));

      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('a', 'id', 'b', 'id'),
        sortedA,
        sortedB
      );

      const result = pass.apply(plan);

      expect(result.physicalStrategy).toBe(PhysicalStrategy.MERGE);
    });

    it('uses HASH when only one side is sorted and tables are small', () => {
      const pass = new PhysicalDesign();
      const sortedA = LogicalSort([{ expr: colRef('a', 'id'), direction: 'ASC' }], scan('a'));

      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('a', 'id', 'b', 'id'),
        sortedA,
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result.physicalStrategy).toBe(PhysicalStrategy.HASH);
    });

    it('chooses MERGE when one side is sorted via IndexScan and build would spill', () => {
      const stats = makeStats({
        big_a: { rowCount: 500000, columns: { id: { ndv: 500000, min: 1, max: 500000 } } },
        big_b: { rowCount: 500000, columns: { id: { ndv: 500000, min: 1, max: 500000 } } },
      });
      const pass = new PhysicalDesign(stats);

      const indexScan = {
        type: PlanNodeType.INDEX_SCAN,
        table: 'big_a',
        alias: 'big_a',
        columnName: 'id',
        children: [],
      };

      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('big_a', 'id', 'big_b', 'id'),
        indexScan,
        scan('big_b')
      );

      const result = pass.apply(plan);

      expect(result.physicalStrategy).toBe(PhysicalStrategy.MERGE);
      expect(result._requiresSort.left).toBe(false);
      expect(result._requiresSort.right).toBe(true);
    });

    it('annotates _requiresSort correctly for partial sort merge', () => {
      const stats = makeStats({
        t1: { rowCount: 300000, columns: { id: { ndv: 300000, min: 1, max: 300000 } } },
        t2: { rowCount: 300000, columns: { id: { ndv: 300000, min: 1, max: 300000 } } },
      });
      const pass = new PhysicalDesign(stats);

      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('t1', 'id', 't2', 'id'),
        { type: PlanNodeType.INDEX_SCAN, table: 't1', alias: 't1', columnName: 'id', children: [] },
        { type: PlanNodeType.INDEX_SCAN, table: 't2', alias: 't2', columnName: 'id', children: [] },
      );

      const result = pass.apply(plan);

      expect(result.physicalStrategy).toBe(PhysicalStrategy.MERGE);
      expect(result._requiresSort.left).toBe(false);
      expect(result._requiresSort.right).toBe(false);
    });

    it('MERGE join preserves sorted output on join keys', () => {
      const stats = makeStats({
        t1: { rowCount: 300000, columns: { id: { ndv: 300000, min: 1, max: 300000 } } },
        t2: { rowCount: 300000, columns: { id: { ndv: 300000, min: 1, max: 300000 } } },
      });
      const pass = new PhysicalDesign(stats);

      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('t1', 'id', 't2', 'id'),
        { type: PlanNodeType.INDEX_SCAN, table: 't1', alias: 't1', columnName: 'id', children: [] },
        { type: PlanNodeType.INDEX_SCAN, table: 't2', alias: 't2', columnName: 'id', children: [] },
      );

      const result = pass.apply(plan);

      expect(result.physicalStrategy).toBe(PhysicalStrategy.MERGE);
      expect(result._sortedBy).toContain('T1.ID');
      expect(result._sortedBy).toContain('T2.ID');
    });
  });

  describe('build side selection', () => {
    it('picks smaller table as build side for INNER join', () => {
      const stats = makeStats({ small: { rowCount: 10 }, big: { rowCount: 100000 } });
      const pass = new PhysicalDesign(stats);

      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('big', 'id', 'small', 'id'),
        scan('big'),
        scan('small')
      );

      const result = pass.apply(plan);

      expect(result._buildSide).toBe('right');
    });

    it('picks left as build side when left is smaller', () => {
      const stats = makeStats({ small: { rowCount: 10 }, big: { rowCount: 100000 } });
      const pass = new PhysicalDesign(stats);

      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('small', 'id', 'big', 'id'),
        scan('small'),
        scan('big')
      );

      const result = pass.apply(plan);

      expect(result._buildSide).toBe('left');
    });
  });

  describe('semi/anti join dedup', () => {
    it('marks dedupeBuild for SEMI join with equi-predicate', () => {
      const pass = new PhysicalDesign();
      const plan = LogicalJoin(
        JoinType.SEMI,
        eqJoin('a', 'id', 'b', 'id'),
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result._dedupeBuild).toBe(true);
    });

    it('marks dedupeBuild for ANTI join with equi-predicate', () => {
      const pass = new PhysicalDesign();
      const plan = LogicalJoin(
        JoinType.ANTI,
        eqJoin('a', 'id', 'b', 'id'),
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result._dedupeBuild).toBe(true);
    });

    it('does not mark dedupeBuild for non-equi predicate', () => {
      const pass = new PhysicalDesign();
      const plan = LogicalJoin(
        JoinType.SEMI,
        bin(colRef('a', 'id'), '>', colRef('b', 'id')),
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result._dedupeBuild).toBeUndefined();
    });
  });

  describe('aggregate strategy selection', () => {
    it('uses UNGROUPED for scalar aggregate', () => {
      const pass = new PhysicalDesign();
      const plan = LogicalAggregate(
        [],
        [{ fn: 'COUNT', args: [] }],
        scan('t')
      );

      const result = pass.apply(plan);

      expect(result.physicalStrategy).toBe(PhysicalStrategy.UNGROUPED);
    });

    it('uses STREAM aggregate when input is sorted on group keys', () => {
      const pass = new PhysicalDesign();
      const sorted = LogicalSort(
        [{ expr: colRef('t', 'status'), direction: 'ASC' }],
        scan('t')
      );
      const plan = LogicalAggregate(
        [colRef('t', 'status')],
        [{ fn: 'COUNT', args: [] }],
        sorted
      );

      const result = pass.apply(plan);

      expect(result.physicalStrategy).toBe(PhysicalStrategy.STREAM);
    });

    it('uses HASH aggregate when input is not sorted', () => {
      const pass = new PhysicalDesign();
      const plan = LogicalAggregate(
        [colRef('t', 'status')],
        [{ fn: 'COUNT', args: [] }],
        scan('t')
      );

      const result = pass.apply(plan);

      expect(result.physicalStrategy).toBe(PhysicalStrategy.HASH);
    });

    it('uses PERFECT_HASH for small domain group keys', () => {
      const stats = makeStats({
        t: {
          rowCount: 10000,
          columns: {
            STATUS: { ndv: 5, min: 1, max: 5 },
          },
        },
      });
      const pass = new PhysicalDesign(stats);
      const plan = LogicalAggregate(
        [colRef('t', 'STATUS')],
        [{ fn: 'COUNT', args: [] }],
        scan('t')
      );

      const result = pass.apply(plan);

      expect(result.physicalStrategy).toBe(PhysicalStrategy.PERFECT_HASH);
    });

    it('does not use PERFECT_HASH when NDV exceeds 256', () => {
      const stats = makeStats({
        t: {
          rowCount: 10000,
          columns: {
            ID: { ndv: 10000, min: 1, max: 10000 },
          },
        },
      });
      const pass = new PhysicalDesign(stats);
      const plan = LogicalAggregate(
        [colRef('t', 'ID')],
        [{ fn: 'COUNT', args: [] }],
        scan('t')
      );

      const result = pass.apply(plan);

      expect(result.physicalStrategy).not.toBe(PhysicalStrategy.PERFECT_HASH);
    });
  });

  describe('sort order propagation', () => {
    it('SORT node produces _sortedBy matching orderKeys', () => {
      const pass = new PhysicalDesign();
      const plan = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        scan('t')
      );

      const result = pass.apply(plan);

      expect(result._sortedBy).toContain('T.ID');
    });

    it('FILTER preserves child sort order', () => {
      const pass = new PhysicalDesign();
      const sorted = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        scan('t')
      );
      const plan = LogicalFilter(
        bin(colRef('t', 'val'), '>', lit(0)),
        sorted
      );

      const result = pass.apply(plan);

      expect(result._sortedBy.length).toBeGreaterThan(0);
    });

    it('HASH join clears sort order', () => {
      const pass = new PhysicalDesign();
      const plan = LogicalJoin(
        JoinType.INNER,
        eqJoin('a', 'id', 'b', 'id'),
        scan('a'),
        scan('b')
      );

      const result = pass.apply(plan);

      expect(result._sortedBy).toEqual([]);
    });
  });

  describe('cardinality estimation', () => {
    it('annotates SCAN with _cardinality from stats', () => {
      const stats = makeStats({ t: { rowCount: 5000 } });
      const pass = new PhysicalDesign(stats);

      const result = pass.apply(scan('t'));

      expect(result._cardinality).toBe(5000);
    });

    it('annotates LIMIT with capped _cardinality', () => {
      const stats = makeStats({ t: { rowCount: 5000 } });
      const pass = new PhysicalDesign(stats);
      const plan = LogicalLimit(10, 0, scan('t'));

      const result = pass.apply(plan);

      expect(result._cardinality).toBe(10);
    });

    it('annotates INDEX_SCAN with _cardinality from stats', () => {
      const stats = makeStats({ t: { rowCount: 50000 } });
      const pass = new PhysicalDesign(stats);

      const indexScan = {
        type: PlanNodeType.INDEX_SCAN,
        table: 't',
        alias: 't',
        columnName: 'id',
        children: [],
      };
      const result = pass.apply(indexScan);

      expect(result._cardinality).toBe(50000);
    });

    it('SORT with limit uses topN cost', () => {
      const pass = new PhysicalDesign();
      const sort = LogicalSort(
        [{ expr: colRef('t', 'id'), direction: 'ASC' }],
        scan('t')
      );
      sort.limit = 10;

      const result = pass.apply(sort);

      expect(result._cost).toBeDefined();
      expect(result._cardinality).toBeLessThanOrEqual(10);
    });
  });
});
