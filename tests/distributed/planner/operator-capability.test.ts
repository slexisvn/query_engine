import { describe, it, expect } from 'vitest';
import {
  capabilityOf,
  runsOnWorkers,
  preservesPartitioning,
  preservesColocation,
} from '../../../src/distributed/planner/operator-capability.js';
import { PlanNodeType } from '../../../src/planner/logical-plan.js';

const NOTHING_ABOVE = { combinedAbove: false, groupsColocated: false };
const COMBINED_ABOVE = { combinedAbove: true, groupsColocated: false };
const GROUPS_COLOCATED = { combinedAbove: false, groupsColocated: true };

const ROW_AT_A_TIME = [PlanNodeType.SCAN, PlanNodeType.INDEX_SCAN, PlanNodeType.FILTER, PlanNodeType.PROJECT];
const NEEDS_COMBINING = [PlanNodeType.SORT, PlanNodeType.TOP_N, PlanNodeType.LIMIT, PlanNodeType.DISTINCT, PlanNodeType.SET_OP];
const COORDINATOR_BOUND = [PlanNodeType.WINDOW, PlanNodeType.DEPENDENT_JOIN, PlanNodeType.MATERIALIZE, PlanNodeType.CTE_SCAN];

const placeable = (type, input) => runsOnWorkers(capabilityOf(type), input);

describe('operator placement', () => {
  describe('what may run on a worker', () => {
    for (const type of ROW_AT_A_TIME) {
      it(`runs ${type} on workers whatever sits above it`, () => {
        expect(placeable(type, NOTHING_ABOVE)).toBe(true);
        expect(placeable(type, COMBINED_ABOVE)).toBe(true);
        expect(placeable(type, GROUPS_COLOCATED)).toBe(true);
      });
    }

    for (const type of NEEDS_COMBINING) {
      it(`holds ${type} back unless its partial results are combined above it`, () => {
        expect(placeable(type, NOTHING_ABOVE)).toBe(false);
        expect(placeable(type, GROUPS_COLOCATED)).toBe(false);
        expect(placeable(type, COMBINED_ABOVE)).toBe(true);
      });
    }

    it('holds a grouped aggregate back unless its groups already sit together', () => {
      expect(placeable(PlanNodeType.AGGREGATE, NOTHING_ABOVE)).toBe(false);
      expect(placeable(PlanNodeType.AGGREGATE, COMBINED_ABOVE)).toBe(false);
      expect(placeable(PlanNodeType.AGGREGATE, GROUPS_COLOCATED)).toBe(true);
    });

    for (const type of COORDINATOR_BOUND) {
      it(`never places ${type} on a worker`, () => {
        expect(placeable(type, NOTHING_ABOVE)).toBe(false);
        expect(placeable(type, COMBINED_ABOVE)).toBe(false);
        expect(placeable(type, GROUPS_COLOCATED)).toBe(false);
      });
    }

    it('never places an unrecognised operator on a worker', () => {
      expect(placeable('NotARealNode', COMBINED_ABOVE)).toBe(false);
      expect(placeable('NotARealNode', GROUPS_COLOCATED)).toBe(false);
    });
  });

  describe('what survives an operator', () => {
    it('carries the input partitioning through row-at-a-time operators', () => {
      for (const type of ROW_AT_A_TIME) {
        expect(preservesPartitioning(capabilityOf(type))).toBe(true);
      }
    });

    it('loses the input partitioning across an operator that reorders or regroups rows', () => {
      for (const type of [...NEEDS_COMBINING, PlanNodeType.AGGREGATE, ...COORDINATOR_BOUND]) {
        expect(preservesPartitioning(capabilityOf(type))).toBe(false);
      }
    });

    it('keeps groups colocated only while the operator also keeps the partitioning', () => {
      expect(preservesColocation(capabilityOf(PlanNodeType.FILTER), true)).toBe(true);
      expect(preservesColocation(capabilityOf(PlanNodeType.SORT), true)).toBe(false);
    });

    it('cannot colocate groups that were not colocated below', () => {
      expect(preservesColocation(capabilityOf(PlanNodeType.FILTER), false)).toBe(false);
    });
  });
});
