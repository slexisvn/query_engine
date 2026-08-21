import { describe, it, expect } from 'vitest';
import { bestJoinOf, combinePredicates } from '../../../src/optimizer/join-order/join-plan.js';
import { DefaultCostModel } from '../../../src/planner/cost-model.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { makeEqPred, proportionalEstimator } from '../../helpers/join-graphs.js';

function entry(mask, cardinality, totalCost, table) {
  return { plan: { type: 'Scan', table }, cardinality, totalCost, mask };
}

describe('combinePredicates', () => {
  it('returns null for an empty predicate set', () => {
    expect(combinePredicates([])).toBeNull();
  });

  it('returns the predicate itself when only one is given', () => {
    const pred = makeEqPred('A', 'id', 'B', 'fk');
    expect(combinePredicates([pred])).toBe(pred);
  });

  it('collapses structurally identical predicates to a single node', () => {
    const first = makeEqPred('A', 'id', 'B', 'fk');
    const second = makeEqPred('A', 'id', 'B', 'fk');

    expect(combinePredicates([first, second])).toBe(first);
  });

  it('conjoins distinct predicates with AND', () => {
    const left = makeEqPred('A', 'id', 'B', 'fk');
    const right = makeEqPred('A', 'code', 'B', 'code');

    const combined = combinePredicates([left, right]);

    expect(combined.kind).toBe(BoundExprKind.BINARY);
    expect(combined.op).toBe('AND');
    expect(combined.left).toBe(left);
    expect(combined.right).toBe(right);
  });

  it('conjoins three distinct predicates into a left-deep AND chain', () => {
    const preds = [
      makeEqPred('A', 'id', 'B', 'fk'),
      makeEqPred('A', 'code', 'B', 'code'),
      makeEqPred('A', 'zone', 'B', 'zone'),
    ];

    const combined = combinePredicates(preds);

    expect(combined.right).toBe(preds[2]);
    expect(combined.left.right).toBe(preds[1]);
    expect(combined.left.left).toBe(preds[0]);
  });

  it('distinguishes predicates that differ only in operator', () => {
    const equality = makeEqPred('A', 'id', 'B', 'fk');
    const inequality = { ...equality, op: '<' };

    const combined = combinePredicates([equality, inequality]);

    expect(combined.op).toBe('AND');
  });
});

describe('bestJoinOf', () => {
  const costModel = new DefaultCostModel();
  const estimator = proportionalEstimator();
  const predicate = [makeEqPred('A', 'id', 'B', 'fk')];

  it('places the smaller input on the build side', () => {
    const small = entry(0b01, 100, 10, 'A');
    const large = entry(0b10, 100000, 20, 'B');

    const result = bestJoinOf(small, large, predicate, costModel, estimator);

    expect(result.plan.buildSide.table).toBe('A');
    expect(result.plan.probeSide.table).toBe('B');
  });

  it('places the smaller input on the build side regardless of argument order', () => {
    const small = entry(0b01, 100, 10, 'A');
    const large = entry(0b10, 100000, 20, 'B');

    const result = bestJoinOf(large, small, predicate, costModel, estimator);

    expect(result.plan.buildSide.table).toBe('A');
  });

  it('unions the two input masks', () => {
    const result = bestJoinOf(entry(0b001, 10, 1, 'A'), entry(0b100, 20, 2, 'C'), predicate, costModel, estimator);
    expect(result.mask).toBe(0b101);
  });

  it('carries the estimated join cardinality', () => {
    const result = bestJoinOf(entry(0b01, 2000, 1, 'A'), entry(0b10, 3000, 2, 'B'), predicate, costModel, estimator);
    expect(result.cardinality).toBe(estimator.estimateJoin(2000, 3000, predicate[0]));
  });

  it('accumulates the cost of both inputs', () => {
    const left = entry(0b01, 100, 37, 'A');
    const right = entry(0b10, 200, 41, 'B');

    const result = bestJoinOf(left, right, predicate, costModel, estimator);

    expect(result.totalCost).toBeGreaterThan(left.totalCost + right.totalCost);
  });

  it('produces a cross-product cardinality when no predicate connects the sides', () => {
    const result = bestJoinOf(entry(0b01, 30, 1, 'A'), entry(0b10, 40, 1, 'B'), [], costModel, estimator);

    expect(result.plan.condition).toBeNull();
    expect(result.cardinality).toBe(1200);
  });
});
