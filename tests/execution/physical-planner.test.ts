import { describe, it, expect } from 'vitest';
import { PhysicalNodeType, isPhysicalJoin, totalPhysicalCost, physicalPlanToString } from '../../src/execution/physical-plan.js';
import { PhysicalPlanner } from '../../src/execution/physical-planner.js';
import {
  JoinType,
  LogicalScan,
  LogicalFilter,
  LogicalJoin,
  LogicalSort,
  LogicalAggregate,
  LogicalIndexScan,
  LogicalTopN,
  LogicalProject,
} from '../../src/planner/logical-plan.js';
import { colRef, lit, bin, eqJoin, scan, makeStats, planPhysical, annotate } from '../helpers/plan-fixtures.js';
import { Config } from '../../src/config.js';
import { BloomFilter } from '../../src/utils/bloom-filter.js';

describe('PhysicalPlanner property derivation', () => {
  it('derives cardinality from statistics rather than trusting the annotation on the plan', () => {
    const stats = makeStats({ A: { rowCount: 50000 } });
    const stale = { ...scan('A'), _cardinality: 7 };

    expect(new PhysicalPlanner(stats).plan(stale).cardinality).toBe(50000);
  });

  it('ignores a sort order the plan claims but its shape does not support', () => {
    const stats = makeStats({ A: { rowCount: 100000, columns: { ID: { ndv: 100000 } } }, B: { rowCount: 100000, columns: { ID: { ndv: 100000 } } } });
    const left = { ...scan('A'), _sortedBy: [{ key: 'A.ID', direction: 'ASC' }] };
    const right = { ...scan('B'), _sortedBy: [{ key: 'B.ID', direction: 'ASC' }] };

    const physical = new PhysicalPlanner(stats).plan(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), left, right));

    expect(physical.type).toBe(PhysicalNodeType.HASH_JOIN);
  });

  it('keeps the sort order a real Sort node establishes', () => {
    const stats = makeStats({ A: { rowCount: 100000, columns: { ID: { ndv: 100000 } } }, B: { rowCount: 100000, columns: { ID: { ndv: 100000 } } } });
    const left = LogicalSort([{ expr: colRef('A', 'id'), direction: 'ASC' }], scan('A'));
    const right = LogicalSort([{ expr: colRef('B', 'id'), direction: 'ASC' }], scan('B'));

    const physical = new PhysicalPlanner(stats).plan(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), left, right));

    expect(physical.type).toBe(PhysicalNodeType.MERGE_JOIN);
  });
});

describe('PhysicalPlanner join selection', () => {
  it('defaults to a hash join for an inner equi-join', () => {
    const stats = makeStats({ A: { rowCount: 10000 }, B: { rowCount: 10000 } });
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);

    expect(physical.type).toBe(PhysicalNodeType.HASH_JOIN);
  });

  it('chooses a merge join when both inputs are already sorted on the join keys', () => {
    const stats = makeStats({ A: { rowCount: 100000, columns: { ID: { ndv: 100000 } } }, B: { rowCount: 100000, columns: { ID: { ndv: 100000 } } } });
    const left = LogicalSort([{ expr: colRef('A', 'id'), direction: 'ASC' }], scan('A'));
    const right = LogicalSort([{ expr: colRef('B', 'id'), direction: 'ASC' }], scan('B'));
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), left, right), stats);

    expect(physical.type).toBe(PhysicalNodeType.MERGE_JOIN);
  });

  it('reports no sort requirement when both merge inputs are already ordered', () => {
    const stats = makeStats({ A: { rowCount: 100000, columns: { ID: { ndv: 100000 } } }, B: { rowCount: 100000, columns: { ID: { ndv: 100000 } } } });
    const left = LogicalSort([{ expr: colRef('A', 'id'), direction: 'ASC' }], scan('A'));
    const right = LogicalSort([{ expr: colRef('B', 'id'), direction: 'ASC' }], scan('B'));
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), left, right), stats);

    expect(physical.requiresSort).toEqual({ left: false, right: false });
  });

  it('flags the unsorted side when only one merge input is ordered', () => {
    const stats = makeStats({ A: { rowCount: 500000 }, B: { rowCount: 500000 } });
    const left = LogicalIndexScan('A', 'A', 'A_id_idx', 'id', 'range', null, 0, 1000000, true, true, ['id', 'val']);
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), left, scan('B')), stats);

    if (physical.type === PhysicalNodeType.MERGE_JOIN) {
      expect(physical.requiresSort.left).toBe(false);
      expect(physical.requiresSort.right).toBe(true);
    } else {
      expect(physical.type).toBe(PhysicalNodeType.HASH_JOIN);
    }
  });

  it('never chooses a merge join for a cross join', () => {
    const stats = makeStats({ A: { rowCount: 10 }, B: { rowCount: 10 } });
    const physical = planPhysical(LogicalJoin(JoinType.CROSS, null, scan('A'), scan('B')), stats);

    expect(physical.type).not.toBe(PhysicalNodeType.MERGE_JOIN);
  });

  it('chooses a nested loop join for a tiny non-equi join', () => {
    const stats = makeStats({ A: { rowCount: 1 }, B: { rowCount: 1 } });
    const condition = bin(colRef('A', 'id'), '<', colRef('B', 'id'));
    const physical = planPhysical(LogicalJoin(JoinType.INNER, condition, scan('A'), scan('B')), stats);

    expect(physical.type).toBe(PhysicalNodeType.NESTED_LOOP_JOIN);
  });

  it('costs a non-equi join by its comparison count, not as if it were hashable', () => {
    const nonEquiCostAt = (rows) => planPhysical(
      LogicalJoin(JoinType.INNER, bin(colRef('A', 'id'), '<', colRef('B', 'id')), scan('A'), scan('B')),
      makeStats({ A: { rowCount: rows }, B: { rowCount: rows } }),
    ).cost;

    const single = nonEquiCostAt(2000);
    const doubled = nonEquiCostAt(4000);

    expect(doubled / single).toBeGreaterThan(3.5);
  });

  it('drops the nested loop candidate once its inputs cannot be held in memory', () => {
    const stats = makeStats({ A: { rowCount: Config.nestedLoopMaxRows }, B: { rowCount: Config.nestedLoopMaxRows } });
    const condition = bin(colRef('A', 'id'), '<', colRef('B', 'id'));
    const physical = planPhysical(LogicalJoin(JoinType.INNER, condition, scan('A'), scan('B')), stats);

    expect(physical.type).toBe(PhysicalNodeType.HASH_JOIN);
  });

  it('chooses a hash join for a large non-equi join', () => {
    const stats = makeStats({ A: { rowCount: 100000, columns: { ID: { ndv: 100000 } } }, B: { rowCount: 100000, columns: { ID: { ndv: 100000 } } } });
    const condition = bin(colRef('A', 'id'), '<', colRef('B', 'id'));
    const physical = planPhysical(LogicalJoin(JoinType.INNER, condition, scan('A'), scan('B')), stats);

    expect(physical.type).toBe(PhysicalNodeType.HASH_JOIN);
  });

  it('marks every join node as a join operator', () => {
    const stats = makeStats({ A: { rowCount: 100 }, B: { rowCount: 100 } });
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);

    expect(isPhysicalJoin(physical)).toBe(true);
  });
});

describe('PhysicalPlanner build side selection', () => {
  it('builds on the smaller input of an inner join', () => {
    const stats = makeStats({ A: { rowCount: 1000000 }, B: { rowCount: 100 } });
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);

    expect(physical.buildSide).toBe('right');
  });

  it('builds on the left when the left input is smaller', () => {
    const stats = makeStats({ A: { rowCount: 100 }, B: { rowCount: 1000000 } });
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);

    expect(physical.buildSide).toBe('left');
  });

  it('always builds on the right for a left outer join', () => {
    const stats = makeStats({ A: { rowCount: 100 }, B: { rowCount: 1000000 } });
    const physical = planPhysical(LogicalJoin(JoinType.LEFT, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);

    expect(physical.buildSide).toBe('right');
  });

  it('always builds on the right for a semi join', () => {
    const stats = makeStats({ A: { rowCount: 10 }, B: { rowCount: 1000000 } });
    const physical = planPhysical(LogicalJoin(JoinType.SEMI, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);

    expect(physical.buildSide).toBe('right');
  });

  it('builds on the left for a right outer join', () => {
    const stats = makeStats({ A: { rowCount: 1000000 }, B: { rowCount: 10 } });
    const physical = planPhysical(LogicalJoin(JoinType.RIGHT, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);

    expect(physical.buildSide).toBe('left');
  });
});

describe('PhysicalPlanner build deduplication', () => {
  const stats = makeStats({ A: { rowCount: 10000 }, B: { rowCount: 10000 } });

  it('deduplicates the build side of a semi join on an equi-predicate', () => {
    const physical = planPhysical(LogicalJoin(JoinType.SEMI, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);
    expect(physical.dedupeBuild).toBe(true);
  });

  it('deduplicates the build side of an anti join on an equi-predicate', () => {
    const physical = planPhysical(LogicalJoin(JoinType.ANTI, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);
    expect(physical.dedupeBuild).toBe(true);
  });

  it('deduplicates the build side of a mark join on an equi-predicate', () => {
    const physical = planPhysical(LogicalJoin(JoinType.MARK, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);
    expect(physical.dedupeBuild).toBe(true);
  });

  it('does not deduplicate when the predicate is not an equality', () => {
    const condition = bin(colRef('A', 'id'), '<', colRef('B', 'id'));
    const physical = planPhysical(LogicalJoin(JoinType.SEMI, condition, scan('A'), scan('B')), stats);
    expect(physical.dedupeBuild).toBe(false);
  });

  it('does not deduplicate an inner join', () => {
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);
    expect(physical.dedupeBuild).toBe(false);
  });
});

describe('PhysicalPlanner aggregate selection', () => {
  it('uses an ungrouped aggregate for a scalar aggregate', () => {
    const stats = makeStats({ T: { rowCount: 10000 } });
    const physical = planPhysical(LogicalAggregate([], [{ name: 'COUNT_STAR', args: [] }], scan('T')), stats);

    expect(physical.type).toBe(PhysicalNodeType.UNGROUPED_AGGREGATE);
  });

  it('uses a stream aggregate when the input is sorted on the group keys', () => {
    const stats = makeStats({ T: { rowCount: 100000 } });
    const sorted = LogicalSort([{ expr: colRef('T', 'id'), direction: 'ASC' }], scan('T'));
    const physical = planPhysical(LogicalAggregate([colRef('T', 'id')], [], sorted), stats);

    expect(physical.type).toBe(PhysicalNodeType.STREAM_AGGREGATE);
  });

  it('uses a hash aggregate when the input is unsorted', () => {
    const stats = makeStats({ T: { rowCount: 100000, columns: { ID: { ndv: 5000, min: 0, max: 1000000 } } } });
    const physical = planPhysical(LogicalAggregate([colRef('T', 'id')], [], scan('T')), stats);

    expect(physical.type).toBe(PhysicalNodeType.HASH_AGGREGATE);
  });

  it('uses a perfect hash aggregate for a small dense group domain', () => {
    const stats = makeStats({ T: { rowCount: 100000, columns: { ID: { ndv: 8, min: 0, max: 7 } } } });
    const physical = planPhysical(LogicalAggregate([colRef('T', 'id')], [], scan('T')), stats);

    expect(physical.type).toBe(PhysicalNodeType.PERFECT_HASH_AGGREGATE);
  });

  it('rejects a perfect hash aggregate when the domain is too wide', () => {
    const stats = makeStats({ T: { rowCount: 100000, columns: { ID: { ndv: 300, min: 0, max: 299 } } } });
    const physical = planPhysical(LogicalAggregate([colRef('T', 'id')], [], scan('T')), stats);

    expect(physical.type).toBe(PhysicalNodeType.HASH_AGGREGATE);
  });

  it('rejects a perfect hash aggregate without column statistics', () => {
    const stats = makeStats({ T: { rowCount: 100 } });
    const physical = planPhysical(LogicalAggregate([colRef('T', 'id')], [], scan('T')), stats);

    expect(physical.type).toBe(PhysicalNodeType.HASH_AGGREGATE);
  });
});

describe('PhysicalPlanner tree shape', () => {
  const stats = makeStats({ A: { rowCount: 1000 }, B: { rowCount: 1000 } });

  it('maps a scan to a table scan operator', () => {
    expect(planPhysical(scan('A'), stats).type).toBe(PhysicalNodeType.TABLE_SCAN);
  });

  it('maps a filter to a filter operator over its child', () => {
    const physical = planPhysical(LogicalFilter(bin(colRef('A', 'val'), '>', lit(1)), scan('A')), stats);

    expect(physical.type).toBe(PhysicalNodeType.FILTER);
    expect(physical.children[0].type).toBe(PhysicalNodeType.TABLE_SCAN);
  });

  it('keeps a reference to the logical node it came from', () => {
    const logical = scan('A');
    const physical = planPhysical(logical, stats);

    expect(physical.logical.table).toBe(logical.table);
  });

  it('carries the estimated cardinality onto the physical node', () => {
    const physical = planPhysical(scan('A'), stats);
    expect(physical.cardinality).toBe(1000);
  });

  it('assigns a non-negative cost to every node', () => {
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);

    expect(physical.cost).toBeGreaterThanOrEqual(0);
    for (const child of physical.children) expect(child.cost).toBeGreaterThanOrEqual(0);
  });

  it('sums child costs into the subtree total', () => {
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);
    const expected = physical.cost + physical.children[0].cost + physical.children[1].cost;

    expect(totalPhysicalCost(physical)).toBeCloseTo(expected, 6);
  });

  it('rejects a logical node with no physical operator', () => {
    expect(() => planPhysical({ type: 'NotARealNode', children: [] }, stats)).toThrow('No physical operator');
  });

  it('renders the operator tree for explain output', () => {
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats);
    const text = physicalPlanToString(physical);

    expect(text).toContain('HashJoin');
    expect(text).toContain('TableScan');
    expect(text).toContain('build=');
  });
});

describe('PhysicalPlanner cost sensitivity', () => {
  it('prefers a cheaper plan when one side shrinks', () => {
    const balanced = makeStats({ A: { rowCount: 100000, columns: { ID: { ndv: 100000 } } }, B: { rowCount: 100000, columns: { ID: { ndv: 100000 } } } });
    const skewed = makeStats({ A: { rowCount: 100000 }, B: { rowCount: 100 } });
    const logical = () => LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B'));

    expect(planPhysical(logical(), skewed).cost).toBeLessThan(planPhysical(logical(), balanced).cost);
  });

  it('costs a sorted merge join below the equivalent hash join', () => {
    const stats = makeStats({ A: { rowCount: 200000, columns: { ID: { ndv: 200000 } } }, B: { rowCount: 200000, columns: { ID: { ndv: 200000 } } } });
    const sortedJoin = LogicalJoin(
      JoinType.INNER,
      eqJoin('A', 'id', 'B', 'id'),
      LogicalSort([{ expr: colRef('A', 'id'), direction: 'ASC' }], scan('A')),
      LogicalSort([{ expr: colRef('B', 'id'), direction: 'ASC' }], scan('B')),
    );
    const hashJoin = LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B'));

    expect(planPhysical(sortedJoin, stats).cost).toBeLessThan(planPhysical(hashJoin, stats).cost);
  });

  it('produces the same plan for the same input', () => {
    const stats = makeStats({ A: { rowCount: 5000 }, B: { rowCount: 200 } });
    const logical = () => LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B'));

    expect(physicalPlanToString(planPhysical(logical(), stats)))
      .toBe(physicalPlanToString(planPhysical(logical(), stats)));
  });

  it('reads cardinality from the annotated logical plan', () => {
    const stats = makeStats({ A: { rowCount: 4242 } });
    const annotated = annotate(scan('A'), stats);

    expect(new PhysicalPlanner(stats).plan(annotated).cardinality).toBe(4242);
  });
});

describe('PhysicalPlanner runtime filters', () => {
  const bigStats = makeStats({ A: { rowCount: 5000000 }, B: { rowCount: 200000 } });
  const smallStats = makeStats({ A: { rowCount: 50 }, B: { rowCount: 40 } });

  it('plans a runtime filter for a large inner join', () => {
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), bigStats);
    expect(physical.runtimeFilterEntries).toBeGreaterThan(0);
  });

  it('sizes the runtime filter from the build side cardinality', () => {
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), bigStats);
    expect(physical.runtimeFilterEntries).toBe(200000);
  });

  it('plans a runtime filter for a large semi join', () => {
    const physical = planPhysical(LogicalJoin(JoinType.SEMI, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), bigStats);
    expect(physical.runtimeFilterEntries).toBeGreaterThan(0);
  });

  it('omits the runtime filter for a small join', () => {
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), smallStats);
    expect(physical.runtimeFilterEntries).toBe(0);
  });

  it('omits the runtime filter for a left outer join', () => {
    const physical = planPhysical(LogicalJoin(JoinType.LEFT, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), bigStats);
    expect(physical.runtimeFilterEntries).toBe(0);
  });

  it('omits the runtime filter for an anti join', () => {
    const physical = planPhysical(LogicalJoin(JoinType.ANTI, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), bigStats);
    expect(physical.runtimeFilterEntries).toBe(0);
  });

  it('caps the runtime filter size when the build estimate exceeds the configured capacity', () => {
    const hugeStats = makeStats({ A: { rowCount: 4e9 }, B: { rowCount: 9e9 } });
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), hugeStats);

    expect(physical.runtimeFilterEntries).toBeGreaterThan(0);
    expect(physical.runtimeFilterEntries).toBeLessThanOrEqual(Config.joinRuntimeFilterCapacity);
  });

  it('keeps a runtime filter allocatable for an extreme build estimate', () => {
    const hugeStats = makeStats({ A: { rowCount: 4e9 }, B: { rowCount: 9e9 } });
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), hugeStats);
    const filter = new BloomFilter(physical.runtimeFilterEntries, Config.joinRuntimeFilterFalsePositiveRate);

    filter.add(7);
    expect(filter.mightContain(7)).toBe(true);
    expect(filter.byteSize).toBeLessThan(Config.memoryLimitBytes);
  });

  it('shows the runtime filter in the rendered plan', () => {
    const physical = planPhysical(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), bigStats);
    expect(physicalPlanToString(physical)).toContain('runtimeFilter');
  });
});

describe('PhysicalPlanner candidate enumeration', () => {
  const planner = new PhysicalPlanner(makeStats({ A: { rowCount: 100000, columns: { ID: { ndv: 100000 } } }, B: { rowCount: 100000, columns: { ID: { ndv: 100000 } } } }));

  function joinCandidates(logical, stats) {
    const annotated = annotate(logical, stats);
    const children = annotated.children.map(child => new PhysicalPlanner(stats).plan(child));
    return new PhysicalPlanner(stats).joinCandidates(annotated, children);
  }

  it('offers hash and nested loop for every join', () => {
    const stats = makeStats({ A: { rowCount: 1000 }, B: { rowCount: 1000 } });
    const types = joinCandidates(LogicalJoin(JoinType.CROSS, null, scan('A'), scan('B')), stats).map(c => c.type);

    expect(types).toContain(PhysicalNodeType.HASH_JOIN);
    expect(types).toContain(PhysicalNodeType.NESTED_LOOP_JOIN);
  });

  it('adds a merge candidate for an equi-join', () => {
    const stats = makeStats({ A: { rowCount: 1000 }, B: { rowCount: 1000 } });
    const types = joinCandidates(LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B')), stats).map(c => c.type);

    expect(types).toContain(PhysicalNodeType.MERGE_JOIN);
  });

  it('offers no merge candidate for a cross join', () => {
    const stats = makeStats({ A: { rowCount: 1000 }, B: { rowCount: 1000 } });
    const types = joinCandidates(LogicalJoin(JoinType.CROSS, null, scan('A'), scan('B')), stats).map(c => c.type);

    expect(types).not.toContain(PhysicalNodeType.MERGE_JOIN);
  });

  it('selects the cheapest candidate', () => {
    const stats = makeStats({ A: { rowCount: 5000 }, B: { rowCount: 4000 } });
    const logical = LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B'));
    const candidates = joinCandidates(logical, stats);
    const chosen = planPhysical(logical, stats);
    const cheapestCost = Math.min(...candidates.map(c => c.cost));

    expect(chosen.cost).toBeCloseTo(cheapestCost, 6);
  });

  it('never selects a candidate more expensive than another', () => {
    const stats = makeStats({ A: { rowCount: 90000 }, B: { rowCount: 3 } });
    const logical = LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B'));
    const chosen = planPhysical(logical, stats);

    for (const candidate of joinCandidates(logical, stats)) {
      expect(chosen.cost).toBeLessThanOrEqual(candidate.cost + 1e-6);
    }
  });

  it('offers a single candidate for an ungrouped aggregate', () => {
    const stats = makeStats({ T: { rowCount: 1000 } });
    const annotated = annotate(LogicalAggregate([], [], scan('T')), stats);
    const children = annotated.children.map(child => new PhysicalPlanner(stats).plan(child));

    expect(new PhysicalPlanner(stats).aggregateCandidates(annotated, children)).toHaveLength(1);
  });

  it('offers hash and stream candidates for a sorted grouped aggregate', () => {
    const stats = makeStats({ T: { rowCount: 100000 } });
    const sorted = LogicalSort([{ expr: colRef('T', 'id'), direction: 'ASC' }], scan('T'));
    const annotated = annotate(LogicalAggregate([colRef('T', 'id')], [], sorted), stats);
    const children = annotated.children.map(child => new PhysicalPlanner(stats).plan(child));
    const types = new PhysicalPlanner(stats).aggregateCandidates(annotated, children).map(c => c.type);

    expect(types).toContain(PhysicalNodeType.HASH_AGGREGATE);
    expect(types).toContain(PhysicalNodeType.STREAM_AGGREGATE);
  });

  it('picks the cheapest aggregate candidate', () => {
    const stats = makeStats({ T: { rowCount: 100000, columns: { ID: { ndv: 8, min: 0, max: 7 } } } });
    const logical = LogicalAggregate([colRef('T', 'id')], [], scan('T'));
    const annotated = annotate(logical, stats);
    const children = annotated.children.map(child => new PhysicalPlanner(stats).plan(child));
    const candidates = new PhysicalPlanner(stats).aggregateCandidates(annotated, children);

    expect(planPhysical(logical, stats).cost).toBeCloseTo(Math.min(...candidates.map(c => c.cost)), 6);
  });
});

describe('PhysicalPlanner order satisfied by a merge join', () => {
  const stats = () => makeStats({ A: { rowCount: 100000, columns: { ID: { ndv: 100000 } } }, B: { rowCount: 100000, columns: { ID: { ndv: 100000 } } } });
  const ascOn = (table, column) => [{ expr: colRef(table, column), direction: 'ASC' }];
  const ordered = (table) => LogicalSort(ascOn(table, 'id'), scan(table));
  const mergeableJoin = () => LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), ordered('A'), ordered('B'));

  it('reaches a merge join from inputs that already carry the join order', () => {
    expect(planPhysical(mergeableJoin(), stats()).type).toBe(PhysicalNodeType.MERGE_JOIN);
  });

  it('drops a Sort whose keys the merge join already delivers', () => {
    const physical = planPhysical(LogicalSort(ascOn('A', 'id'), mergeableJoin()), stats());

    expect(physical.type).toBe(PhysicalNodeType.MERGE_JOIN);
  });

  it('accepts the other side of the equi-join as the delivered order', () => {
    const physical = planPhysical(LogicalSort(ascOn('B', 'id'), mergeableJoin()), stats());

    expect(physical.type).toBe(PhysicalNodeType.MERGE_JOIN);
  });

  it('keeps the Sort when the requested direction is the opposite one', () => {
    const descending = [{ expr: colRef('A', 'id'), direction: 'DESC' }];
    const physical = planPhysical(LogicalSort(descending, mergeableJoin()), stats());

    expect(physical.type).toBe(PhysicalNodeType.SORT);
    expect(physical.children[0].type).toBe(PhysicalNodeType.MERGE_JOIN);
  });

  it('keeps the Sort when it orders by a column the join does not key on', () => {
    const physical = planPhysical(LogicalSort(ascOn('A', 'val'), mergeableJoin()), stats());

    expect(physical.type).toBe(PhysicalNodeType.SORT);
    expect(physical.children[0].type).toBe(PhysicalNodeType.MERGE_JOIN);
  });

  it('keeps the Sort when it needs more keys than the join delivers', () => {
    const twoKeys = [
      { expr: colRef('A', 'id'), direction: 'ASC' },
      { expr: colRef('A', 'val'), direction: 'ASC' },
    ];
    const physical = planPhysical(LogicalSort(twoKeys, mergeableJoin()), stats());

    expect(physical.type).toBe(PhysicalNodeType.SORT);
  });

  it('keeps the Sort above an outer join because unmatched rows carry null keys', () => {
    const outer = LogicalJoin(JoinType.LEFT, eqJoin('A', 'id', 'B', 'id'), ordered('A'), ordered('B'));
    const physical = planPhysical(LogicalSort(ascOn('A', 'id'), outer), stats());

    expect(physical.children[0].type).toBe(PhysicalNodeType.MERGE_JOIN);
    expect(physical.type).toBe(PhysicalNodeType.SORT);
  });

  it('keeps the Sort above a hash join that delivers no order', () => {
    const unordered = LogicalJoin(JoinType.INNER, eqJoin('A', 'id', 'B', 'id'), scan('A'), scan('B'));
    const physical = planPhysical(LogicalSort(ascOn('A', 'id'), unordered), stats());

    expect(physical.children[0].type).toBe(PhysicalNodeType.HASH_JOIN);
    expect(physical.type).toBe(PhysicalNodeType.SORT);
  });

  it('sees through a projection between the sort and the merge join', () => {
    const projected = LogicalProject([{ expr: colRef('A', 'id'), alias: 'ID' }], mergeableJoin());
    const physical = planPhysical(LogicalSort(ascOn('A', 'id'), projected), stats());

    expect(physical.type).toBe(PhysicalNodeType.PROJECT);
    expect(physical.children[0].type).toBe(PhysicalNodeType.MERGE_JOIN);
  });

  it('degrades Top-N to a Limit when the merge join already delivers the order', () => {
    const physical = planPhysical(LogicalTopN(ascOn('A', 'id'), 10, 0, mergeableJoin()), stats());

    expect(physical.type).toBe(PhysicalNodeType.LIMIT);
    expect(physical.logical.count).toBe(10);
    expect(physical.children[0].type).toBe(PhysicalNodeType.MERGE_JOIN);
  });

  it('carries the Top-N offset onto the Limit it degrades to', () => {
    const physical = planPhysical(LogicalTopN(ascOn('A', 'id'), 10, 25, mergeableJoin()), stats());

    expect(physical.type).toBe(PhysicalNodeType.LIMIT);
    expect(physical.logical.offset).toBe(25);
  });

  it('costs the degraded Limit below the Top-N it replaces', () => {
    const degraded = planPhysical(LogicalTopN(ascOn('A', 'id'), 10, 0, mergeableJoin()), stats());
    const kept = planPhysical(LogicalTopN(ascOn('A', 'val'), 10, 0, mergeableJoin()), stats());

    expect(kept.type).toBe(PhysicalNodeType.TOP_N);
    expect(degraded.cost).toBeLessThan(kept.cost);
  });

  it('keeps Top-N when it orders by a column the join does not key on', () => {
    const physical = planPhysical(LogicalTopN(ascOn('A', 'val'), 10, 0, mergeableJoin()), stats());

    expect(physical.type).toBe(PhysicalNodeType.TOP_N);
  });

  it('keeps a Sort that also selects rows rather than dropping its limit', () => {
    const limiting = { ...LogicalSort(ascOn('A', 'id'), mergeableJoin()), limit: 5 };
    const physical = planPhysical(limiting, stats());

    expect(physical.type).toBe(PhysicalNodeType.SORT);
    expect(physical.logical.limit).toBe(5);
  });
});
