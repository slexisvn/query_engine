import { describe, it, expect } from 'vitest';
import { descriptorOf, InputRequirement, PartitioningEffect } from '../../src/planner/plan-node-descriptor.js';
import { ExchangeType, PlanNodeType, SetOpType } from '../../src/planner/logical-plan.js';
import { PlanRewriter } from '../../src/planner/plan-rewriter.js';
import { DefaultCostModel } from '../../src/planner/cost-model.js';
import { PhysicalPlanner } from '../../src/execution/physical-planner.js';
import { DataType } from '../../src/storage/data-type.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

const ALL_TYPES = Object.values(PlanNodeType);
const COST_BASED_TYPES = [PlanNodeType.JOIN, PlanNodeType.AGGREGATE];
const UNKNOWN_TYPE = 'NotARealNode';

function nodeOf(type, extra = {}) {
  return { type, children: [], ...extra };
}

const orderKey = { expr: { kind: BoundExprKind.COLUMN_REF, tableAlias: 'T', columnName: 'C', dataType: DataType.FLOAT64 } };

const COST_FIXTURES = {
  [PlanNodeType.SORT]: { orderKeys: [orderKey] },
  [PlanNodeType.TOP_N]: { orderKeys: [orderKey], count: 10 },
  [PlanNodeType.LIMIT]: { count: 10 },
  [PlanNodeType.SET_OP]: { op: SetOpType.INTERSECT, all: false },
  [PlanNodeType.WINDOW]: { windowExprs: [{ partitionBy: [orderKey.expr], orderBy: [orderKey] }] },
  [PlanNodeType.EXCHANGE]: { exchangeType: ExchangeType.HASH_SHUFFLE, partitionCount: 8 },
  [PlanNodeType.MERGE_EXCHANGE]: { orderKeys: [orderKey], limit: null },
};

const costModel = new DefaultCostModel();

function costOf(type, inputCardinalities, cardinality, extra = {}) {
  return descriptorOf(type).cost(
    costModel,
    nodeOf(type, { ...COST_FIXTURES[type], ...extra }),
    inputCardinalities,
    cardinality,
  );
}

const CONSUMES_WHOLE_INPUT = [
  PlanNodeType.FILTER,
  PlanNodeType.SORT,
  PlanNodeType.TOP_N,
  PlanNodeType.DISTINCT,
  PlanNodeType.SET_OP,
  PlanNodeType.WINDOW,
  PlanNodeType.DEPENDENT_JOIN,
  PlanNodeType.CTE_ANCHOR,
  PlanNodeType.MATERIALIZE,
  PlanNodeType.EXCHANGE,
  PlanNodeType.PARTIAL_AGGREGATE,
  PlanNodeType.FINAL_AGGREGATE,
];

const BUFFERS_WHOLE_INPUT = [
  PlanNodeType.SORT,
  PlanNodeType.DISTINCT,
  PlanNodeType.SET_OP,
  PlanNodeType.WINDOW,
  PlanNodeType.DEPENDENT_JOIN,
  PlanNodeType.CTE_ANCHOR,
  PlanNodeType.MATERIALIZE,
  PlanNodeType.PARTIAL_AGGREGATE,
  PlanNodeType.FINAL_AGGREGATE,
];

describe('plan node descriptors', () => {
  describe('coverage of the node type enum', () => {
    it('describes every plan node type', () => {
      const undescribed = ALL_TYPES.filter(type => descriptorOf(type).rewriteMethod === null);
      expect(undescribed).toEqual([]);
    });

    it('falls back to a coordinator-only description for an unrecognised node', () => {
      const descriptor = descriptorOf(UNKNOWN_TYPE);

      expect(descriptor.rewriteMethod).toBeNull();
      expect(descriptor.physicalType).toBeNull();
      expect(descriptor.preservesSchema).toBe(false);
      expect(descriptor.capability.input).toBe(InputRequirement.GLOBAL);
      expect(descriptor.capability.output).toBe(PartitioningEffect.DESTROYS);
    });
  });

  describe('rewrite dispatch', () => {
    it('routes every node type to the hook its descriptor names', () => {
      const missed = [];

      for (const type of ALL_TYPES) {
        const method = descriptorOf(type).rewriteMethod;
        let reached = false;
        const rewriter = new PlanRewriter();
        rewriter[method] = (node) => { reached = true; return node; };

        rewriter.rewrite(nodeOf(type));
        if (!reached) missed.push(type);
      }

      expect(missed).toEqual([]);
    });

    it('gives each node type its own hook so rewriting one type leaves the others alone', () => {
      const methods = ALL_TYPES.map(type => descriptorOf(type).rewriteMethod);

      expect(new Set(methods).size).toBe(ALL_TYPES.length);
    });

    it('falls through to the default rewrite for an unrecognised node', () => {
      const child = nodeOf(PlanNodeType.SCAN);
      const rewriter = new PlanRewriter();
      rewriter.rewriteScan = () => nodeOf(PlanNodeType.EMPTY);

      const result = rewriter.rewrite({ type: UNKNOWN_TYPE, children: [child] });

      expect(result.children[0].type).toBe(PlanNodeType.EMPTY);
    });
  });

  describe('physical operator selection', () => {
    it('leaves the physical operator open only for the cost-based node types', () => {
      const open = ALL_TYPES.filter(type => descriptorOf(type).physicalType === null);

      expect(open.sort()).toEqual([...COST_BASED_TYPES].sort());
    });

    it('maps each remaining node type onto a distinct physical operator', () => {
      const physical = ALL_TYPES
        .map(type => descriptorOf(type).physicalType)
        .filter(type => type !== null);

      expect(new Set(physical).size).toBe(physical.length);
    });
  });

  describe('cost rule reachability', () => {
    it('carries a cost rule exactly for the node types the descriptor also runs', () => {
      const withRule = ALL_TYPES.filter(type => descriptorOf(type).cost !== null);
      const withOperator = ALL_TYPES.filter(type => descriptorOf(type).physicalType !== null);

      expect(withRule.sort()).toEqual(withOperator.sort());
    });

    it('leaves no cost rule on the node types the physical planner costs by enumeration', () => {
      for (const type of COST_BASED_TYPES) {
        expect(descriptorOf(type).cost).toBeNull();
      }
    });

    it('refuses to price a node type whose operator is chosen by enumeration', () => {
      const planner = new PhysicalPlanner();
      const join = nodeOf(PlanNodeType.JOIN);

      expect(() => planner.operatorCost(join, [])).toThrow(/No cost rule/);
    });
  });

  describe('cost rules', () => {
    it('charges scans by what they produce, not by what sits below them', () => {
      expect(costOf(PlanNodeType.SCAN, [1], 1000)).toBeGreaterThan(costOf(PlanNodeType.SCAN, [1000], 10));
    });

    for (const type of CONSUMES_WHOLE_INPUT) {
      it(`charges ${type} more as its input grows, even when its output does not`, () => {
        const small = costOf(type, [10, 10], 1);
        const large = costOf(type, [10000, 10], 1);

        expect(large).toBeGreaterThan(small);
      });
    }

    for (const type of BUFFERS_WHOLE_INPUT) {
      it(`charges ${type} at least as much as scanning the input it has to hold`, () => {
        expect(costOf(type, [10000, 10000], 1)).toBeGreaterThanOrEqual(costModel.scanCost(10000));
      });
    }

    it('charges a partial aggregate more than a scan of the rows it emits', () => {
      expect(costOf(PlanNodeType.PARTIAL_AGGREGATE, [100000], 50)).toBeGreaterThan(costModel.scanCost(50));
    });

    it('charges a partial aggregate the same hashing work as the distinct it shares a shape with', () => {
      expect(costOf(PlanNodeType.PARTIAL_AGGREGATE, [100000], 50))
        .toBe(costOf(PlanNodeType.DISTINCT, [100000], 50));
    });

    it('charges a final aggregate by the partial rows it combines, not by the groups it emits', () => {
      const manyPartials = costOf(PlanNodeType.FINAL_AGGREGATE, [100000], 50);
      const fewPartials = costOf(PlanNodeType.FINAL_AGGREGATE, [100], 50);

      expect(manyPartials).toBeGreaterThan(fewPartials);
    });

    it('charges a wider TopN more than a narrow one over the same input', () => {
      const narrow = costOf(PlanNodeType.TOP_N, [10000], 1, { count: 2 });
      const wide = costOf(PlanNodeType.TOP_N, [10000], 1, { count: 5000 });

      expect(wide).toBeGreaterThan(narrow);
    });

    it('charges sorting more than filtering the same number of rows', () => {
      expect(costOf(PlanNodeType.SORT, [10000], 1)).toBeGreaterThan(costOf(PlanNodeType.FILTER, [10000], 1));
    });

    it('charges a limit only for the rows it lets through', () => {
      expect(costOf(PlanNodeType.LIMIT, [1000000], 10)).toBe(costModel.scanCost(10));
    });

    it('charges nothing for a node the optimizer proved empty', () => {
      expect(costOf(PlanNodeType.EMPTY, [1000000], 0)).toBe(0);
    });

    describe('dependent join', () => {
      it('charges for re-running the subquery per outer row', () => {
        const oneRowSubquery = costOf(PlanNodeType.DEPENDENT_JOIN, [10000, 1], 10000);
        const wideSubquery = costOf(PlanNodeType.DEPENDENT_JOIN, [10000, 1000], 10000);

        expect(wideSubquery).toBeGreaterThan(oneRowSubquery);
      });

      it('grows quadratically rather than linearly as both sides grow', () => {
        const small = costOf(PlanNodeType.DEPENDENT_JOIN, [100, 100], 100);
        const doubled = costOf(PlanNodeType.DEPENDENT_JOIN, [200, 200], 200);

        expect(doubled).toBeGreaterThan(small * 2);
      });

      it('costs more than the hash join a decorrelated plan would use instead', () => {
        const dependent = costOf(PlanNodeType.DEPENDENT_JOIN, [10000, 10000], 10000);

        expect(dependent).toBeGreaterThan(costModel.hashJoinCost(10000, 10000, 10000));
      });
    });

    describe('set operations', () => {
      const unionAll = { op: SetOpType.UNION, all: true };
      const unionDistinct = { op: SetOpType.UNION, all: false };

      it('charges a UNION ALL for both branches, not just the left one', () => {
        const balanced = costOf(PlanNodeType.SET_OP, [1000, 1000], 2000, unionAll);
        const leftOnly = costOf(PlanNodeType.SET_OP, [1000, 0], 1000, unionAll);

        expect(balanced).toBeGreaterThan(leftOnly);
      });

      it('charges a UNION more than a UNION ALL over the same branches', () => {
        const deduped = costOf(PlanNodeType.SET_OP, [1000, 1000], 1000, unionDistinct);
        const passedThrough = costOf(PlanNodeType.SET_OP, [1000, 1000], 2000, unionAll);

        expect(deduped).toBeGreaterThan(passedThrough);
      });

      it('charges INTERSECT and EXCEPT for hashing the right branch', () => {
        for (const op of [SetOpType.INTERSECT, SetOpType.EXCEPT]) {
          const wideRight = costOf(PlanNodeType.SET_OP, [1000, 100000], 1000, { op, all: false });
          const narrowRight = costOf(PlanNodeType.SET_OP, [1000, 10], 1000, { op, all: false });

          expect(wideRight).toBeGreaterThan(narrowRight);
        }
      });
    });

    describe('window', () => {
      it('charges at least as much as sorting the rows it orders', () => {
        const cost = costOf(PlanNodeType.WINDOW, [100000], 100000);

        expect(cost).toBeGreaterThan(costModel.sortCost(100000));
      });

      it('charges nothing for ordering a window that does not order', () => {
        const unordered = costOf(PlanNodeType.WINDOW, [100000], 100000, {
          windowExprs: [{ partitionBy: [orderKey.expr], orderBy: [] }],
        });
        const ordered = costOf(PlanNodeType.WINDOW, [100000], 100000);

        expect(ordered).toBeGreaterThan(unordered);
      });

      it('charges nothing for partitioning a window that does not partition', () => {
        const unpartitioned = costOf(PlanNodeType.WINDOW, [100000], 100000, {
          windowExprs: [{ partitionBy: [], orderBy: [orderKey] }],
        });
        const partitioned = costOf(PlanNodeType.WINDOW, [100000], 100000);

        expect(partitioned).toBeGreaterThan(unpartitioned);
      });
    });

    describe('exchanges', () => {
      it('charges more per row than a local scan of the same rows', () => {
        for (const type of [PlanNodeType.EXCHANGE, PlanNodeType.EXCHANGE_RECEIVE, PlanNodeType.MERGE_EXCHANGE]) {
          expect(costOf(type, [100000], 100000)).toBeGreaterThan(costModel.scanCost(100000));
        }
      });

      it('charges a broadcast for every copy it sends', () => {
        const broadcast = costOf(PlanNodeType.EXCHANGE, [10000], 10000, {
          exchangeType: ExchangeType.BROADCAST,
          partitionCount: 8,
        });
        const shuffle = costOf(PlanNodeType.EXCHANGE, [10000], 10000);

        expect(broadcast).toBeCloseTo(shuffle * 8);
      });

      it('charges a merge exchange for the ordered merge a plain receive does not do', () => {
        const merged = costOf(PlanNodeType.MERGE_EXCHANGE, [100000], 100000);
        const received = costOf(PlanNodeType.EXCHANGE_RECEIVE, [100000], 100000);

        expect(merged).toBeGreaterThan(received);
      });

      it('charges a merge exchange more for text keys than for numeric ones', () => {
        const textKey = { expr: { ...orderKey.expr, dataType: DataType.VARCHAR } };
        const text = costOf(PlanNodeType.MERGE_EXCHANGE, [100000], 100000, { orderKeys: [textKey] });
        const numeric = costOf(PlanNodeType.MERGE_EXCHANGE, [100000], 100000);

        expect(text).toBeGreaterThan(numeric);
      });
    });
  });

  describe('cost rules answer to the primitives they claim to spend', () => {
    const cheaperHashing = new DefaultCostModel({ hashProbeCost: 0.1, hashInsertCost: 0.1 });
    const cheaperComparisons = new DefaultCostModel({ comparisonCost: 0.01 });
    const cheaperBuffering = new DefaultCostModel({ bufferCost: 0.1 });

    const priced = (model, type, inputCardinalities, cardinality, extra = {}) => descriptorOf(type).cost(
      model,
      nodeOf(type, { ...COST_FIXTURES[type], ...extra }),
      inputCardinalities,
      cardinality,
    );

    const HASHES = [
      [PlanNodeType.DISTINCT, {}],
      [PlanNodeType.PARTIAL_AGGREGATE, {}],
      [PlanNodeType.FINAL_AGGREGATE, {}],
      [PlanNodeType.SET_OP, { op: SetOpType.INTERSECT, all: false }],
      [PlanNodeType.SET_OP, { op: SetOpType.UNION, all: false }],
      [PlanNodeType.WINDOW, {}],
    ];

    for (const [type, extra] of HASHES) {
      it(`prices ${type}${extra.op ? ` ${extra.op}` : ''} with the hash primitives`, () => {
        expect(priced(cheaperHashing, type, [100000, 100000], 100, extra))
          .toBeLessThan(priced(costModel, type, [100000, 100000], 100, extra));
      });
    }

    const COMPARES = [PlanNodeType.SORT, PlanNodeType.TOP_N, PlanNodeType.WINDOW, PlanNodeType.MERGE_EXCHANGE];

    for (const type of COMPARES) {
      it(`prices ${type} with the comparison primitive`, () => {
        expect(priced(cheaperComparisons, type, [100000], 100000))
          .toBeLessThan(priced(costModel, type, [100000], 100000));
      });
    }

    const BUFFERS = [
      PlanNodeType.SORT,
      PlanNodeType.MATERIALIZE,
      PlanNodeType.CTE_ANCHOR,
      PlanNodeType.WINDOW,
      PlanNodeType.SET_OP,
    ];

    for (const type of BUFFERS) {
      it(`prices ${type} with the buffering primitive`, () => {
        expect(priced(cheaperBuffering, type, [100000, 100000], 100000))
          .toBeLessThan(priced(costModel, type, [100000, 100000], 100000));
      });
    }
  });

  describe('descriptor consistency', () => {
    it('gives every schema-preserving node a physical operator to run', () => {
      const preservesSchema = ALL_TYPES.filter(type => descriptorOf(type).preservesSchema);

      expect(preservesSchema.length).toBeGreaterThan(0);
      for (const type of preservesSchema) {
        expect(descriptorOf(type).physicalType).not.toBeNull();
      }
    });
  });
});
