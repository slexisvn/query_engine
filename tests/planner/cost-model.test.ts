import { describe, it, expect } from 'vitest';
import { DefaultCostModel, SortKeyClass, sortKeyClassOf } from '../../src/planner/cost-model.js';
import { DataType } from '../../src/storage/data-type.js';
import { Config } from '../../src/config.js';

describe('DefaultCostModel', () => {
  const model = new DefaultCostModel();

  describe('scanCost', () => {
    it('scales linearly with cardinality', () => {
      const c1 = model.scanCost(100);
      const c2 = model.scanCost(200);
      expect(c2).toBeCloseTo(c1 * 2, 5);
    });

    it('returns zero for zero rows', () => {
      expect(model.scanCost(0)).toBe(0);
    });
  });

  describe('filterCost', () => {
    it('scales linearly with cardinality', () => {
      expect(model.filterCost(100)).toBeCloseTo(100 * (model.C_TUPLE + model.C_OPERATOR), 5);
    });
  });

  describe('hashJoinCost', () => {
    it('build side is more expensive per-row than probe side', () => {
      const buildHeavy = model.hashJoinCost(1000, 100);
      const probeHeavy = model.hashJoinCost(100, 1000);
      expect(buildHeavy).toBeGreaterThan(probeHeavy);
    });

    it('uses outputCard when provided', () => {
      const withOutput = model.hashJoinCost(100, 100, 50);
      const withDefault = model.hashJoinCost(100, 100);
      expect(withOutput).not.toBe(withDefault);
    });
  });

  describe('nestedLoopJoinCost', () => {
    it('grows quadratically', () => {
      const c1 = model.nestedLoopJoinCost(10, 10);
      const c2 = model.nestedLoopJoinCost(20, 20);
      expect(c2 / c1).toBeCloseTo(4, 1);
    });
  });

  describe('crossJoinCost', () => {
    it('applies heavy penalty', () => {
      const cross = model.crossJoinCost(100, 100);
      const hash = model.hashJoinCost(100, 100);
      expect(cross).toBeGreaterThan(hash);
    });
  });

  describe('sortCost', () => {
    it('returns zero for single element', () => {
      expect(model.sortCost(1)).toBe(0);
    });

    it('grows super-linearly (n log n)', () => {
      const c100 = model.sortCost(100);
      const c1000 = model.sortCost(1000);
      expect(c1000 / c100).toBeGreaterThan(10);
    });
  });

  describe('topNSortCost', () => {
    it('returns zero for edge cases', () => {
      expect(model.topNSortCost(1, 10)).toBe(0);
      expect(model.topNSortCost(100, 0)).toBe(0);
    });

    it('is cheaper than full sort when limit is small', () => {
      const topN = model.topNSortCost(1000, 10);
      const full = model.sortCost(1000);
      expect(topN).toBeLessThan(full);
    });
  });

  describe('sortMergeJoinCost', () => {
    it('includes sort costs for both sides', () => {
      const smj = model.sortMergeJoinCost(100, 200);
      const mergeOnly = model.mergeJoinCost(100, 200);
      expect(smj).toBeGreaterThan(mergeOnly);
    });
  });

  describe('hashAggregateCost', () => {
    it('increases with cardinality', () => {
      const c1 = model.hashAggregateCost(100);
      const c2 = model.hashAggregateCost(1000);
      expect(c2).toBeGreaterThan(c1);
    });

    it('accounts for number of groups', () => {
      const fewGroups = model.hashAggregateCost(1000, 10);
      const manyGroups = model.hashAggregateCost(1000, 500);
      expect(manyGroups).toBeGreaterThan(fewGroups);
    });
  });

  describe('mergeJoinCostWithSorts', () => {
    it('undercuts a hash join of the same shape when both sides are already sorted', () => {
      const merge = model.mergeJoinCostWithSorts(1000, 1000, true, true, 500);
      expect(merge).toBeLessThan(model.hashJoinCost(1000, 1000, 500));
    });

    it('loses to a hash join on small inputs that both need sorting', () => {
      const merge = model.mergeJoinCostWithSorts(1000, 1000, false, false, 500, SortKeyClass.NUMERIC);
      expect(merge).toBeGreaterThan(model.hashJoinCost(1000, 1000, 500));
    });

    it('charges only the unsorted side when one input is already ordered', () => {
      const oneSorted = model.mergeJoinCostWithSorts(10000, 10000, true, false, 5000);
      const neitherSorted = model.mergeJoinCostWithSorts(10000, 10000, false, false, 5000);
      expect(neitherSorted - oneSorted).toBeCloseTo(model.sortCost(10000), 6);
    });

    it('charges nothing extra when both inputs are already ordered', () => {
      const bothSorted = model.mergeJoinCostWithSorts(10000, 10000, true, true, 5000);
      expect(bothSorted).toBeCloseTo(model.mergeJoinCost(10000, 10000, 5000), 6);
    });

    it('gains on a hash join as fewer inputs need sorting', () => {
      const neither = model.mergeJoinCostWithSorts(500000, 500000, false, false, 250000);
      const one = model.mergeJoinCostWithSorts(500000, 500000, true, false, 250000);
      const both = model.mergeJoinCostWithSorts(500000, 500000, true, true, 250000);

      expect(one).toBeLessThan(neither);
      expect(both).toBeLessThan(one);
      expect(both).toBeLessThan(model.hashJoinCost(500000, 500000, 250000));
    });
  });

  describe('sort key class', () => {
    const rows = 500000;

    it('classifies a lone int32 or date key as radix sortable', () => {
      expect(sortKeyClassOf([DataType.INT32])).toBe(SortKeyClass.RADIX);
      expect(sortKeyClassOf([DataType.DATE])).toBe(SortKeyClass.RADIX);
    });

    it('classifies anything holding text as a text comparison sort', () => {
      expect(sortKeyClassOf([DataType.VARCHAR])).toBe(SortKeyClass.TEXT);
      expect(sortKeyClassOf([DataType.INT32, DataType.VARCHAR])).toBe(SortKeyClass.TEXT);
    });

    it('falls back to a numeric comparison sort for floats and composite keys', () => {
      expect(sortKeyClassOf([DataType.FLOAT64])).toBe(SortKeyClass.NUMERIC);
      expect(sortKeyClassOf([DataType.INT32, DataType.INT32])).toBe(SortKeyClass.NUMERIC);
      expect(sortKeyClassOf([])).toBe(SortKeyClass.NUMERIC);
    });

    it('orders sort cost radix below numeric below text', () => {
      const radix = model.sortCost(rows, SortKeyClass.RADIX);
      const numeric = model.sortCost(rows, SortKeyClass.NUMERIC);
      const text = model.sortCost(rows, SortKeyClass.TEXT);

      expect(radix).toBeLessThan(numeric);
      expect(numeric).toBeLessThan(text);
    });

    it('drops the radix discount below the row count radix sorting needs', () => {
      const tiny = Math.floor(Config.radixSortMinRows / 2);
      expect(model.sortCost(tiny, SortKeyClass.RADIX)).toBe(model.sortCost(tiny, SortKeyClass.NUMERIC));
    });

    it('prefers merge join over hash join for radix sortable keys', () => {
      const merge = model.mergeJoinCostWithSorts(rows, rows, false, false, rows, SortKeyClass.RADIX);
      expect(merge).toBeLessThan(model.hashJoinCost(rows, rows, rows));
    });

    it('prefers hash join over merge join for text keys', () => {
      const merge = model.mergeJoinCostWithSorts(rows, rows, false, false, rows, SortKeyClass.TEXT);
      expect(merge).toBeGreaterThan(model.hashJoinCost(rows, rows, rows));
    });

    it('prefers hash join over merge join for float keys that radix cannot take', () => {
      const merge = model.mergeJoinCostWithSorts(rows, rows, false, false, rows, SortKeyClass.NUMERIC);
      expect(merge).toBeGreaterThan(model.hashJoinCost(rows, rows, rows));
    });
  });

  describe('custom options', () => {
    it('accepts custom cost factors', () => {
      const cheap = new DefaultCostModel({ tupleCost: 0.01 });
      const expensive = new DefaultCostModel({ tupleCost: 10 });
      expect(expensive.scanCost(100)).toBeGreaterThan(cheap.scanCost(100));
    });
  });

  describe('totalJoinCost', () => {
    it('sums build plan cost, probe plan cost, and join cost', () => {
      const buildPlan = { totalCost: 10 };
      const probePlan = { totalCost: 20 };
      const result = model.totalJoinCost(buildPlan, probePlan, 100, 200);
      expect(result).toBeGreaterThan(30);
    });

    it('uses provided outputCard instead of default', () => {
      const buildPlan = { totalCost: 0 };
      const probePlan = { totalCost: 0 };
      const smallOutput = model.totalJoinCost(buildPlan, probePlan, 1000, 1000, 10);
      const largeOutput = model.totalJoinCost(buildPlan, probePlan, 1000, 1000, 100000);
      expect(largeOutput).toBeGreaterThan(smallOutput);
    });

    it('includes child plan costs in total', () => {
      const cheapPlans = model.totalJoinCost({ totalCost: 0 }, { totalCost: 0 }, 100, 100, 50);
      const expensivePlans = model.totalJoinCost({ totalCost: 500 }, { totalCost: 500 }, 100, 100, 50);
      expect(expensivePlans - cheapPlans).toBeCloseTo(1000, 1);
    });
  });

  describe('sortMergeJoinCost', () => {
    it('sort overhead makes sort-merge more expensive than merge alone', () => {
      const smj = model.sortMergeJoinCost(1000, 2000);
      const mergeOnly = model.mergeJoinCost(1000, 2000);
      const sortOverhead = smj - mergeOnly;
      expect(sortOverhead).toBeCloseTo(model.sortCost(1000) + model.sortCost(2000), 5);
    });

    it('sort-merge becomes competitive with hash for large pre-sorted inputs', () => {
      const mergeOnly = model.mergeJoinCost(100000, 100000);
      const hashCost = model.hashJoinCost(100000, 100000);
      expect(mergeOnly).toBeLessThan(hashCost);
    });

    it('carries the key class through to the sorts it adds', () => {
      const radix = model.sortMergeJoinCost(100000, 100000, 100000, SortKeyClass.RADIX);
      const text = model.sortMergeJoinCost(100000, 100000, 100000, SortKeyClass.TEXT);
      expect(radix).toBeLessThan(text);
    });
  });

  describe('spill-to-disk I/O cost', () => {
    it('adds I/O penalty when build side exceeds spill threshold', () => {
      const spilling = new DefaultCostModel({ spillThreshold: 1000 });
      const resident = spilling.hashJoinCost(1000, 1000);
      const overflowing = spilling.hashJoinCost(300000, 1000);

      expect(overflowing / resident).toBeGreaterThan(300);
    });

    it('charges nothing until the build side actually exceeds the threshold', () => {
      const spilling = new DefaultCostModel({ spillThreshold: 1000 });

      expect(spilling.spillPenalty(999, 5000)).toBe(0);
      expect(spilling.spillPenalty(1000, 5000)).toBe(0);
      expect(spilling.spillPenalty(1001, 5000)).toBeGreaterThan(0);
    });

    it('crosses the threshold continuously instead of stepping', () => {
      const spilling = new DefaultCostModel({ spillThreshold: 200000 });
      const below = spilling.hashJoinCost(199999, 199999, 199999);
      const above = spilling.hashJoinCost(200001, 200001, 200001);

      expect(above / below).toBeLessThan(1.001);
      expect(above).toBeGreaterThan(below);
    });

    it('grows the penalty with the fraction of the build side that does not fit', () => {
      const spilling = new DefaultCostModel({ spillThreshold: 1000 });
      const halfResident = spilling.spillPenalty(2000, 1000);
      const tenthResident = spilling.spillPenalty(10000, 1000);

      expect(halfResident).toBeCloseTo(1000 * 0.5 * spilling.C_IO, 6);
      expect(tenthResident).toBeCloseTo(1000 * 0.9 * spilling.C_IO, 6);
    });

    it('charges an external sort for the I/O it performs', () => {
      const spilling = new DefaultCostModel({ spillThreshold: 1000 });
      const resident = new DefaultCostModel({ spillThreshold: 1000000 });

      expect(spilling.sortCost(100000)).toBeGreaterThan(resident.sortCost(100000));
      expect(spilling.sortCost(100000) - resident.sortCost(100000))
        .toBeCloseTo(spilling.spillPenalty(100000, 100000), 6);
    });

    it('charges a top-n only for the rows it keeps resident', () => {
      const spilling = new DefaultCostModel({ spillThreshold: 1000 });

      expect(spilling.topNSortCost(100000, 10)).toBeLessThan(spilling.sortCost(100000));
      expect(spilling.spillPenalty(10, 100000)).toBe(0);
    });

    it('derives the default threshold from the memory limit the executor enforces', () => {
      expect(new DefaultCostModel().SPILL_THRESHOLD)
        .toBe(Math.floor(Config.memoryLimitBytes / Config.defaultRowWidthBytes));
    });

    it('no I/O penalty below spill threshold', () => {
      const noSpill = new DefaultCostModel({ spillThreshold: 500000 });
      const costA = noSpill.hashJoinCost(100000, 100000);
      const spill = new DefaultCostModel({ spillThreshold: 50000 });
      const costB = spill.hashJoinCost(100000, 100000);
      expect(costB).toBeGreaterThan(costA);
    });

    it('spill threshold is configurable', () => {
      const lowThresh = new DefaultCostModel({ spillThreshold: 100 });
      const highThresh = new DefaultCostModel({ spillThreshold: 1000000 });
      const costLow = lowThresh.hashJoinCost(500, 500);
      const costHigh = highThresh.hashJoinCost(500, 500);
      expect(costLow).toBeGreaterThan(costHigh);
    });

    it('takes its default from the config table', () => {
      const saved = Config.costModelSpillThreshold;
      Config.costModelSpillThreshold = 400;
      try {
        const configured = new DefaultCostModel();
        const overridden = new DefaultCostModel({ spillThreshold: 1000000 });
        expect(configured.SPILL_THRESHOLD).toBe(400);
        expect(configured.hashJoinCost(500, 500)).toBeGreaterThan(overridden.hashJoinCost(500, 500));
      } finally {
        Config.costModelSpillThreshold = saved;
      }
    });
  });
});
