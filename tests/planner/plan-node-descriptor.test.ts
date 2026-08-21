import { describe, it, expect } from 'vitest';
import { descriptorOf, InputRequirement, PartitioningEffect } from '../../src/planner/plan-node-descriptor.js';
import { PlanNodeType } from '../../src/planner/logical-plan.js';
import { PlanRewriter } from '../../src/planner/plan-rewriter.js';
import { DefaultCostModel } from '../../src/planner/cost-model.js';

const ALL_TYPES = Object.values(PlanNodeType);
const COST_BASED_TYPES = [PlanNodeType.JOIN, PlanNodeType.AGGREGATE];
const UNKNOWN_TYPE = 'NotARealNode';

function nodeOf(type, extra = {}) {
  return { type, children: [], ...extra };
}

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

  describe('cost rules', () => {
    const costModel = new DefaultCostModel();
    const cost = (type, inputCardinality, cardinality, extra) =>
      descriptorOf(type).cost(costModel, nodeOf(type, extra), inputCardinality, cardinality);

    it('charges scans by what they produce, not by what sits below them', () => {
      expect(cost(PlanNodeType.SCAN, 1, 1000)).toBeGreaterThan(cost(PlanNodeType.SCAN, 1000, 10));
    });

    for (const type of [PlanNodeType.FILTER, PlanNodeType.SORT, PlanNodeType.DISTINCT]) {
      it(`charges ${type} by the rows it has to read`, () => {
        expect(cost(type, 10000, 1)).toBeGreaterThan(cost(type, 10, 1));
      });
    }

    it('charges a wider TopN more than a narrow one over the same input', () => {
      const narrow = cost(PlanNodeType.TOP_N, 10000, 1, { count: 2 });
      const wide = cost(PlanNodeType.TOP_N, 10000, 1, { count: 5000 });

      expect(wide).toBeGreaterThan(narrow);
    });

    it('charges sorting more than filtering the same number of rows', () => {
      expect(cost(PlanNodeType.SORT, 10000, 1)).toBeGreaterThan(cost(PlanNodeType.FILTER, 10000, 1));
    });
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
