import { describe, it, expect } from 'vitest';
import { PlanProperties } from '../../../src/optimizer/passes/plan-properties.js';
import {
  JoinType,
  LogicalScan,
  LogicalFilter,
  LogicalJoin,
  LogicalSort,
  LogicalAggregate,
  LogicalLimit,
  LogicalDistinct,
  LogicalIndexScan,
} from '../../../src/planner/logical-plan.js';
import { colRef, lit, bin, eqJoin, scan, makeStats, annotate } from '../../helpers/plan-fixtures.js';

describe('PlanProperties immutability', () => {
  it('leaves the input plan unannotated', () => {
    const stats = makeStats({ A: { rowCount: 4200 } });
    const input = LogicalFilter(bin(colRef('A', 'id'), '>', lit(1)), scan('A'));

    const annotated = new PlanProperties(stats).apply(input);

    expect(annotated._cardinality).toBeGreaterThan(0);
    expect(input._cardinality).toBeUndefined();
    expect(input.children[0]._cardinality).toBeUndefined();
  });

  it('does not let one annotation run leak into a plan shared with another', () => {
    const shared = scan('A');
    const first = new PlanProperties(makeStats({ A: { rowCount: 100 } })).apply(shared);
    const second = new PlanProperties(makeStats({ A: { rowCount: 900 } })).apply(shared);

    expect(first._cardinality).toBe(100);
    expect(second._cardinality).toBe(900);
    expect(shared._cardinality).toBeUndefined();
  });
});

describe('PlanProperties cardinality', () => {
  it('reads scan cardinality from statistics', () => {
    const stats = makeStats({ A: { rowCount: 4200 } });
    expect(annotate(scan('A'), stats)._cardinality).toBe(4200);
  });

  it('falls back to a default when a table has no statistics', () => {
    expect(annotate(scan('UNKNOWN'))._cardinality).toBeGreaterThan(0);
  });

  it('costs a point index scan by the distinct values of the indexed column', () => {
    const stats = makeStats({ A: { rowCount: 900, columns: { id: { ndv: 900 } } } });
    const indexScan = LogicalIndexScan('A', 'A', 'A_idx', 'id', 'point', 1, null, null, true, true, ['id']);

    expect(annotate(indexScan, stats)._cardinality).toBe(1);
  });

  it('does not read a point index scan as if it scanned the whole table', () => {
    const stats = makeStats({ A: { rowCount: 900, columns: { id: { ndv: 90 } } } });
    const indexScan = LogicalIndexScan('A', 'A', 'A_idx', 'id', 'point', 1, null, null, true, true, ['id']);

    expect(annotate(indexScan, stats)._cardinality).toBe(10);
  });

  it('costs a bounded index range from the column bounds', () => {
    const stats = makeStats({ A: { rowCount: 1000, columns: { id: { ndv: 1000, min: 0, max: 100 } } } });
    const indexScan = LogicalIndexScan('A', 'A', 'A_idx', 'id', 'range', null, 0, 25, true, true, ['id']);

    expect(annotate(indexScan, stats)._cardinality).toBe(250);
  });

  it('shrinks cardinality through a filter', () => {
    const stats = makeStats({ A: { rowCount: 10000 } });
    const filtered = annotate(LogicalFilter(bin(colRef('A', 'val'), '=', lit(3)), scan('A')), stats);

    expect(filtered._cardinality).toBeLessThan(10000);
  });

  it('caps cardinality at the limit count', () => {
    const stats = makeStats({ A: { rowCount: 10000 } });
    expect(annotate(LogicalLimit(25, 0, scan('A')), stats)._cardinality).toBe(25);
  });

  it('does not raise cardinality above the child when the limit is larger', () => {
    const stats = makeStats({ A: { rowCount: 10 } });
    expect(annotate(LogicalLimit(1000, 0, scan('A')), stats)._cardinality).toBe(10);
  });

  it('reduces cardinality through a distinct', () => {
    const stats = makeStats({ A: { rowCount: 10000 } });
    expect(annotate(LogicalDistinct(scan('A')), stats)._cardinality).toBeLessThan(10000);
  });

  it('multiplies both sides for a cross join', () => {
    const stats = makeStats({ A: { rowCount: 30 }, B: { rowCount: 40 } });
    const cross = annotate(LogicalJoin(JoinType.CROSS, null, scan('A'), scan('B')), stats);

    expect(cross._cardinality).toBe(1200);
  });

  it('keeps a left join at least as large as its left input', () => {
    const stats = makeStats({ A: { rowCount: 5000 }, B: { rowCount: 10 } });
    const join = annotate(LogicalJoin(JoinType.LEFT, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);

    expect(join._cardinality).toBeGreaterThanOrEqual(5000);
  });

  it('keeps a mark join at exactly its left input size', () => {
    const stats = makeStats({ A: { rowCount: 700 }, B: { rowCount: 10 } });
    const join = annotate(LogicalJoin(JoinType.MARK, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);

    expect(join._cardinality).toBe(700);
  });

  it('keeps a semi join no larger than its left input', () => {
    const stats = makeStats({ A: { rowCount: 700 }, B: { rowCount: 10 } });
    const join = annotate(LogicalJoin(JoinType.SEMI, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);

    expect(join._cardinality).toBeLessThanOrEqual(700);
  });

  it('reduces cardinality through a grouped aggregate', () => {
    const stats = makeStats({ A: { rowCount: 100000 } });
    const agg = annotate(LogicalAggregate([colRef('A', 'id')], [], scan('A')), stats);

    expect(agg._cardinality).toBeLessThan(100000);
  });

  it('annotates every node in the tree', () => {
    const stats = makeStats({ A: { rowCount: 100 } });
    const annotated = annotate(LogicalFilter(bin(colRef('A', 'val'), '>', lit(1)), scan('A')), stats);

    expect(annotated._cardinality).toBeDefined();
    expect(annotated.children[0]._cardinality).toBeDefined();
  });
});

describe('PlanProperties sort order', () => {
  it('records the sort keys of a sort node', () => {
    const sorted = annotate(LogicalSort([{ expr: colRef('A', 'id'), direction: 'ASC' }], scan('A')));
    expect(sorted._sortedBy).toEqual([{ key: 'A.ID', direction: 'ASC' }]);
  });

  it('records descending direction', () => {
    const sorted = annotate(LogicalSort([{ expr: colRef('A', 'id'), direction: 'DESC' }], scan('A')));
    expect(sorted._sortedBy[0].direction).toBe('DESC');
  });

  it('defaults the direction to ascending', () => {
    const sorted = annotate(LogicalSort([{ expr: colRef('A', 'id') }], scan('A')));
    expect(sorted._sortedBy[0].direction).toBe('ASC');
  });

  it('records the indexed column of an index scan', () => {
    const indexScan = LogicalIndexScan('A', 'A', 'A_idx', 'id', 'point', 1, null, null, true, true, ['id']);
    expect(annotate(indexScan)._sortedBy).toEqual(['A.ID']);
  });

  it('preserves child sort order through a filter', () => {
    const sorted = LogicalSort([{ expr: colRef('A', 'id'), direction: 'ASC' }], scan('A'));
    const filtered = annotate(LogicalFilter(bin(colRef('A', 'val'), '>', lit(1)), sorted));

    expect(filtered._sortedBy).toEqual([{ key: 'A.ID', direction: 'ASC' }]);
  });

  it('preserves child sort order through a limit', () => {
    const sorted = LogicalSort([{ expr: colRef('A', 'id'), direction: 'ASC' }], scan('A'));
    expect(annotate(LogicalLimit(5, 0, sorted))._sortedBy).toEqual([{ key: 'A.ID', direction: 'ASC' }]);
  });

  it('clears sort order at a join', () => {
    const stats = makeStats({ A: { rowCount: 100 }, B: { rowCount: 100 } });
    const sorted = LogicalSort([{ expr: colRef('A', 'id'), direction: 'ASC' }], scan('A'));
    const join = annotate(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), sorted, scan('B')), stats);

    expect(join._sortedBy).toEqual([]);
  });

  it('clears sort order at an aggregate', () => {
    const stats = makeStats({ A: { rowCount: 100 } });
    const sorted = LogicalSort([{ expr: colRef('A', 'id'), direction: 'ASC' }], scan('A'));

    expect(annotate(LogicalAggregate([colRef('A', 'id')], [], sorted), stats)._sortedBy).toEqual([]);
  });

  it('reports no sort order for a bare scan', () => {
    expect(annotate(scan('A'))._sortedBy).toEqual([]);
  });

  it('drops sort keys that are not plain column references', () => {
    const sorted = annotate(LogicalSort([{ expr: lit(1), direction: 'ASC' }], scan('A')));
    expect(sorted._sortedBy).toEqual([]);
  });
});

describe('PlanProperties pass identity', () => {
  it('reports its pass name', () => {
    expect(new PlanProperties().name).toBe('PlanProperties');
  });

  it('runs without statistics', () => {
    expect(() => new PlanProperties().apply(scan('A'))).not.toThrow();
  });
});
