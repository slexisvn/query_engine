import { describe, it, expect } from 'vitest';
import {
  ASSOCIATIVITY,
  LEFT_ASSCOM,
  RIGHT_ASSCOM,
  JOIN_TYPES,
  JOIN_TYPE_PROPERTIES,
  Reorderability,
  computeJoinConstraints,
  nullRejectedRelations,
} from '../../../src/optimizer/join-order/join-conflicts.js';
import { JoinType } from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { makeColRef, makeEqPred, operatorNode, predicateEntry, relationLeaf } from '../../helpers/join-graphs.js';

const A = 0b001;
const B = 0b010;
const C = 0b100;
const D = 0b1000;

function constraintFor(constraints, operator) {
  return constraints.find(constraint => constraint.operator === operator);
}

function entry(sesMask, leftMask, rightMask) {
  return predicateEntry(makeEqPred('X', 'id', 'Y', 'fk'), sesMask, leftMask, rightMask);
}

describe('join type properties', () => {
  it('treats only inner and cross joins as commutative and conjunctive', () => {
    const commutative = JOIN_TYPES.filter(type => JOIN_TYPE_PROPERTIES[type].commutative);
    const conjunctive = JOIN_TYPES.filter(type => JOIN_TYPE_PROPERTIES[type].conjunctive);

    expect(commutative).toEqual([JoinType.INNER, JoinType.CROSS]);
    expect(conjunctive).toEqual([JoinType.INNER, JoinType.CROSS]);
  });

  it('defines a property row for every join type', () => {
    for (const type of JOIN_TYPES) expect(JOIN_TYPE_PROPERTIES[type]).toBeDefined();
  });
});

describe('reorderability tables', () => {
  const tables = { ASSOCIATIVITY, LEFT_ASSCOM, RIGHT_ASSCOM };

  it('define an entry for every ordered pair of join types', () => {
    for (const [name, table] of Object.entries(tables)) {
      for (const lower of JOIN_TYPES) {
        for (const upper of JOIN_TYPES) {
          expect(Object.values(Reorderability), `${name}[${lower}][${upper}]`).toContain(table[lower][upper]);
        }
      }
    }
  });

  it('lets an inner join below permit any left-argument-preserving operator above it', () => {
    expect(ASSOCIATIVITY[JoinType.INNER][JoinType.LEFT]).toBe(Reorderability.ALWAYS);
    expect(ASSOCIATIVITY[JoinType.INNER][JoinType.SEMI]).toBe(Reorderability.ALWAYS);
    expect(ASSOCIATIVITY[JoinType.INNER][JoinType.ANTI]).toBe(Reorderability.ALWAYS);
    expect(ASSOCIATIVITY[JoinType.INNER][JoinType.MARK]).toBe(Reorderability.ALWAYS);
  });

  it('refuses to associate an inner join underneath a left join', () => {
    expect(ASSOCIATIVITY[JoinType.LEFT][JoinType.INNER]).toBe(Reorderability.NEVER);
    expect(ASSOCIATIVITY[JoinType.LEFT][JoinType.SEMI]).toBe(Reorderability.NEVER);
    expect(ASSOCIATIVITY[JoinType.LEFT][JoinType.ANTI]).toBe(Reorderability.NEVER);
  });

  it('makes left join associativity conditional on the middle operand rejecting nulls', () => {
    expect(ASSOCIATIVITY[JoinType.LEFT][JoinType.LEFT]).toBe(Reorderability.MIDDLE_MUST_BE_NULL_REJECTED);
  });

  it('never associates around a right, full or single join', () => {
    for (const frozen of [JoinType.RIGHT, JoinType.FULL, JoinType.SINGLE]) {
      for (const other of JOIN_TYPES) {
        expect(ASSOCIATIVITY[frozen][other]).toBe(Reorderability.NEVER);
        expect(ASSOCIATIVITY[other][frozen]).toBe(Reorderability.NEVER);
        expect(LEFT_ASSCOM[frozen][other]).toBe(Reorderability.NEVER);
        expect(LEFT_ASSCOM[other][frozen]).toBe(Reorderability.NEVER);
      }
    }
  });

  it('allows left asscom among every left-argument-preserving pair', () => {
    const preserving = [JoinType.INNER, JoinType.CROSS, JoinType.LEFT, JoinType.SEMI, JoinType.ANTI, JoinType.MARK];
    for (const lower of preserving) {
      for (const upper of preserving) {
        expect(LEFT_ASSCOM[lower][upper], `${lower}/${upper}`).toBe(Reorderability.ALWAYS);
      }
    }
  });

  it('allows right asscom only between two conjunctive joins', () => {
    for (const lower of JOIN_TYPES) {
      for (const upper of JOIN_TYPES) {
        const bothConjunctive = JOIN_TYPE_PROPERTIES[lower].conjunctive && JOIN_TYPE_PROPERTIES[upper].conjunctive;
        expect(RIGHT_ASSCOM[lower][upper] === Reorderability.ALWAYS).toBe(bothConjunctive);
      }
    }
  });
});

describe('computeJoinConstraints', () => {
  it('adds no conflicts to a tree of inner joins', () => {
    const inner = operatorNode(JoinType.INNER, relationLeaf(0), relationLeaf(1), [entry(A | B, A, B)]);
    const root = operatorNode(JoinType.INNER, inner, relationLeaf(2), [entry(B | C, B, C)]);

    for (const constraint of computeJoinConstraints(root)) expect(constraint.conflictMask).toBe(0);
  });

  it('forces an inner join above a left join to wait for the preserved side', () => {
    const left = operatorNode(JoinType.LEFT, relationLeaf(0), relationLeaf(1), [entry(A | B, A, B)]);
    const root = operatorNode(JoinType.INNER, left, relationLeaf(2), [entry(A | C, A, C)]);

    const constraints = computeJoinConstraints(root);
    expect(constraintFor(constraints, root).conflictMask).toBe(A);
    expect(constraintFor(constraints, left).conflictMask).toBe(0);
  });

  it('forces an inner join above a left join to wait for the whole outer join when its predicate touches the null side', () => {
    const left = operatorNode(JoinType.LEFT, relationLeaf(0), relationLeaf(1), [entry(A | B, A, B)]);
    const root = operatorNode(JoinType.INNER, left, relationLeaf(2), [entry(B | C, B, C)]);

    const constraint = constraintFor(computeJoinConstraints(root), root);
    expect(constraint.conflictMask | B | C).toBe(A | B | C);
    expect(constraint.leftTes).toBe(A | B);
    expect(constraint.rightTes).toBe(C);
  });

  it('drops the left join chain conflict when the upper predicate rejects nulls from the middle input', () => {
    const lower = operatorNode(JoinType.LEFT, relationLeaf(0), relationLeaf(1), [entry(A | B, A, B)]);
    const root = operatorNode(JoinType.LEFT, lower, relationLeaf(2), [entry(B | C, B, C)]);
    root.nullRejectedMask = B;

    expect(constraintFor(computeJoinConstraints(root), root).conflictMask).toBe(0);
  });

  it('keeps the left join chain conflict when the upper predicate tolerates nulls from the middle input', () => {
    const lower = operatorNode(JoinType.LEFT, relationLeaf(0), relationLeaf(1), [entry(A | B, A, B)]);
    const root = operatorNode(JoinType.LEFT, lower, relationLeaf(2), [entry(B | C, B, C)]);
    root.nullRejectedMask = 0;

    expect(constraintFor(computeJoinConstraints(root), root).conflictMask).toBe(A);
  });

  it('drops the chain conflict when the upper predicate rejects nulls from part of a composite middle', () => {
    const middle = operatorNode(JoinType.INNER, relationLeaf(1), relationLeaf(2), [entry(B | C, B, C)]);
    const lower = operatorNode(JoinType.LEFT, relationLeaf(0), middle, [entry(A | B, A, B | C)]);
    const root = operatorNode(JoinType.LEFT, lower, relationLeaf(3), [entry(B | D, B, D)]);
    root.nullRejectedMask = B;

    expect(constraintFor(computeJoinConstraints(root), root).conflictMask & A).toBe(0);
  });

  it('keeps a chain conflict whose own middle is unrejected even when a sibling chain is rejected', () => {
    const rejected = operatorNode(JoinType.LEFT, relationLeaf(0), relationLeaf(1), [entry(A | B, A, B)]);
    const tolerated = operatorNode(JoinType.LEFT, rejected, relationLeaf(2), [entry(A | C, A, C)]);
    const root = operatorNode(JoinType.LEFT, tolerated, relationLeaf(3), [entry(B | D, B, D)]);
    root.nullRejectedMask = B;

    expect(constraintFor(computeJoinConstraints(root), root).conflictMask & (A | B)).toBe(A | B);
  });

  it('pins a left join nested in the right input of another join', () => {
    const lower = operatorNode(JoinType.LEFT, relationLeaf(1), relationLeaf(2), [entry(B | C, B, C)]);
    const root = operatorNode(JoinType.LEFT, relationLeaf(0), lower, [entry(A | B, A, B)]);

    const constraint = constraintFor(computeJoinConstraints(root), root);
    expect(constraint.conflictMask & B).toBe(B);
    expect(constraint.rightTes).toBe(B | C);
  });

  it('falls back to the whole operand when a predicate leaves one side unconstrained', () => {
    const root = operatorNode(JoinType.LEFT, relationLeaf(0), relationLeaf(1), [entry(A, A, B)]);

    const constraint = constraintFor(computeJoinConstraints(root), root);
    expect(constraint.leftTes).toBe(A);
    expect(constraint.rightTes).toBe(B);
  });

  it('emits one constraint per operator in the tree', () => {
    const inner = operatorNode(JoinType.INNER, relationLeaf(0), relationLeaf(1), [entry(A | B, A, B)]);
    const root = operatorNode(JoinType.LEFT, inner, relationLeaf(2), [entry(B | C, B, C)]);

    expect(computeJoinConstraints(root)).toHaveLength(2);
  });
});

describe('nullRejectedRelations', () => {
  const names = ['A', 'B'];

  it('reports a relation whose nulls make an equality predicate unsatisfiable', () => {
    expect(nullRejectedRelations(makeEqPred('A', 'id', 'B', 'fk'), A | B, names)).toBe(A | B);
  });

  it('reports nothing for a predicate that survives nulls', () => {
    const tolerant = {
      kind: BoundExprKind.BINARY,
      op: 'OR',
      left: { kind: BoundExprKind.IS_NULL, expr: makeColRef('B', 'fk'), negated: false },
      right: makeEqPred('A', 'id', 'B', 'fk'),
    };

    expect(nullRejectedRelations(tolerant, A | B, names) & B).toBe(0);
  });

  it('reports nothing without a predicate', () => {
    expect(nullRejectedRelations(null, A | B, names)).toBe(0);
  });
});
