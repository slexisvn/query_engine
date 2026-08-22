import { JoinType, type LogicalJoinNode } from '../../planner/logical-plan.js';
import { isNullRejecting } from '../passes/null-rejection.js';
import type { PlanRefs } from '../passes/plan-refs.js';
import type { BoundExpr } from '../../binder/expression-binder.js';
import { bitIndices } from './bitmask.js';

export interface JoinTypeProperties {
  commutative: boolean;
  conjunctive: boolean;
}

export const JOIN_TYPE_PROPERTIES: Record<JoinType, JoinTypeProperties> = {
  [JoinType.INNER]: { commutative: true, conjunctive: true },
  [JoinType.CROSS]: { commutative: true, conjunctive: true },
  [JoinType.LEFT]: { commutative: false, conjunctive: false },
  [JoinType.RIGHT]: { commutative: false, conjunctive: false },
  [JoinType.FULL]: { commutative: false, conjunctive: false },
  [JoinType.SEMI]: { commutative: false, conjunctive: false },
  [JoinType.ANTI]: { commutative: false, conjunctive: false },
  [JoinType.MARK]: { commutative: false, conjunctive: false },
  [JoinType.SINGLE]: { commutative: false, conjunctive: false },
};

export enum Reorderability {
  ALWAYS = 'Always',
  NEVER = 'Never',
  MIDDLE_MUST_BE_NULL_REJECTED = 'MiddleMustBeNullRejected',
}

export const JOIN_TYPES: readonly JoinType[] = Object.values(JoinType);

const JOIN_TYPE_SLOT: Record<JoinType, number> = Object.fromEntries(
  JOIN_TYPES.map((type, slot) => [type, slot]),
) as Record<JoinType, number>;

const CONJUNCTIVE_JOIN_TYPES: readonly JoinType[] = JOIN_TYPES.filter(t => JOIN_TYPE_PROPERTIES[t].conjunctive);

const LEFT_ARGUMENT_PRESERVING: readonly JoinType[] = [
  JoinType.INNER,
  JoinType.CROSS,
  JoinType.LEFT,
  JoinType.SEMI,
  JoinType.ANTI,
  JoinType.MARK,
];

type ReorderabilityTable = Record<JoinType, Record<JoinType, Reorderability>>;

function reorderabilityTable(
  allowed: ReadonlyArray<readonly [readonly JoinType[], readonly JoinType[], Reorderability]>,
): ReorderabilityTable {
  const table = Object.fromEntries(
    JOIN_TYPES.map(lower => [
      lower,
      Object.fromEntries(JOIN_TYPES.map(upper => [upper, Reorderability.NEVER])),
    ]),
  ) as ReorderabilityTable;

  for (const [lowers, uppers, rule] of allowed) {
    for (const lower of lowers) {
      for (const upper of uppers) table[lower][upper] = rule;
    }
  }
  return table;
}

export const ASSOCIATIVITY: ReorderabilityTable = reorderabilityTable([
  [CONJUNCTIVE_JOIN_TYPES, LEFT_ARGUMENT_PRESERVING, Reorderability.ALWAYS],
  [[JoinType.LEFT], [JoinType.LEFT], Reorderability.MIDDLE_MUST_BE_NULL_REJECTED],
]);

export const LEFT_ASSCOM: ReorderabilityTable = reorderabilityTable([
  [LEFT_ARGUMENT_PRESERVING, LEFT_ARGUMENT_PRESERVING, Reorderability.ALWAYS],
]);

export const RIGHT_ASSCOM: ReorderabilityTable = reorderabilityTable([
  [CONJUNCTIVE_JOIN_TYPES, CONJUNCTIVE_JOIN_TYPES, Reorderability.ALWAYS],
]);

export enum JoinTreeNodeKind {
  RELATION = 'Relation',
  OPERATOR = 'Operator',
}

export interface JoinPredicateEntry {
  predicate: BoundExpr | null;
  sesMask: number;
  leftMask: number;
  rightMask: number;
}

export interface JoinTreeRelation {
  kind: JoinTreeNodeKind.RELATION;
  mask: number;
}

export interface JoinTreeOperator {
  kind: JoinTreeNodeKind.OPERATOR;
  joinType: JoinType;
  source: LogicalJoinNode;
  predicates: JoinPredicateEntry[];
  left: JoinTreeNode;
  right: JoinTreeNode;
  leftRels: number;
  rightRels: number;
  sesMask: number;
  nullRejectedMask: number;
}

export type JoinTreeNode = JoinTreeRelation | JoinTreeOperator;

export interface JoinConstraint {
  operator: JoinTreeOperator;
  conflictMask: number;
  leftTes: number;
  rightTes: number;
}

export function relationRefsOf(mask: number, relationNames: readonly string[]): PlanRefs {
  const aliases = new Set<string>();
  for (const index of bitIndices(mask)) aliases.add(relationNames[index]);
  return { aliases, columns: new Set<string>() };
}

export function nullRejectedRelations(
  predicate: BoundExpr | null,
  mask: number,
  relationNames: readonly string[],
  ambiguous: number,
): number {
  if (!predicate) return 0;
  let rejected = 0;
  for (const index of bitIndices(mask & ~ambiguous)) {
    if (isNullRejecting(predicate, relationRefsOf(1 << index, relationNames))) rejected |= 1 << index;
  }
  return rejected;
}

export function ambiguousRelations(relationNames: readonly string[]): number {
  const seen = new Map<string, number>();
  let ambiguous = 0;
  relationNames.forEach((name, index) => {
    const first = seen.get(name);
    if (first === undefined) {
      seen.set(name, index);
      return;
    }
    ambiguous |= (1 << first) | (1 << index);
  });
  return ambiguous;
}

interface SubtreeConflicts {
  ascendingFixed: Int32Array;
  ascendingConditional: Int32Array;
  ascendingGuard: Int32Array;
  descendingFixed: Int32Array;
}

function emptyConflicts(): SubtreeConflicts {
  const width = JOIN_TYPES.length;
  return {
    ascendingFixed: new Int32Array(width),
    ascendingConditional: new Int32Array(width),
    ascendingGuard: new Int32Array(width),
    descendingFixed: new Int32Array(width),
  };
}

function rejectsMiddle(operator: JoinTreeOperator, middle: number): boolean {
  return middle !== 0 && (operator.nullRejectedMask & middle) !== 0;
}

function accumulateAscending(target: SubtreeConflicts, operator: JoinTreeOperator): void {
  for (const upper of JOIN_TYPES) {
    const slot = JOIN_TYPE_SLOT[upper];
    const assoc = ASSOCIATIVITY[operator.joinType][upper];
    const asscom = LEFT_ASSCOM[operator.joinType][upper];

    if (assoc === Reorderability.MIDDLE_MUST_BE_NULL_REJECTED) {
      target.ascendingConditional[slot] |= operator.leftRels;
      target.ascendingGuard[slot] |= operator.rightRels;
    } else if (assoc !== Reorderability.ALWAYS) {
      target.ascendingFixed[slot] |= operator.leftRels;
    }

    if (asscom !== Reorderability.ALWAYS) target.ascendingFixed[slot] |= operator.rightRels;
  }
}

function accumulateDescending(target: SubtreeConflicts, operator: JoinTreeOperator): void {
  for (const upper of JOIN_TYPES) {
    const slot = JOIN_TYPE_SLOT[upper];
    const assoc = ASSOCIATIVITY[upper][operator.joinType];
    const asscom = RIGHT_ASSCOM[upper][operator.joinType];

    const assocHolds = assoc === Reorderability.ALWAYS
      || (assoc === Reorderability.MIDDLE_MUST_BE_NULL_REJECTED && rejectsMiddle(operator, operator.leftRels));

    if (!assocHolds) target.descendingFixed[slot] |= operator.rightRels;
    if (asscom !== Reorderability.ALWAYS) target.descendingFixed[slot] |= operator.leftRels;
  }
}

function mergeConflicts(into: SubtreeConflicts, from: SubtreeConflicts): void {
  for (let slot = 0; slot < into.ascendingFixed.length; slot++) {
    into.ascendingFixed[slot] |= from.ascendingFixed[slot];
    into.ascendingConditional[slot] |= from.ascendingConditional[slot];
    into.ascendingGuard[slot] |= from.ascendingGuard[slot];
    into.descendingFixed[slot] |= from.descendingFixed[slot];
  }
}

function ascendingContribution(subtree: SubtreeConflicts, operator: JoinTreeOperator): number {
  const slot = JOIN_TYPE_SLOT[operator.joinType];
  const guard = subtree.ascendingGuard[slot];
  const middleRejected = guard !== 0 && (guard & ~operator.nullRejectedMask) === 0;
  return subtree.ascendingFixed[slot] | (middleRejected ? 0 : subtree.ascendingConditional[slot]);
}

export function computeJoinConstraints(root: JoinTreeNode): JoinConstraint[] {
  const constraints: JoinConstraint[] = [];
  collectConflicts(root, constraints);
  return constraints;
}

function collectConflicts(node: JoinTreeNode, constraints: JoinConstraint[]): SubtreeConflicts {
  if (node.kind === JoinTreeNodeKind.RELATION) return emptyConflicts();

  const left = collectConflicts(node.left, constraints);
  const right = collectConflicts(node.right, constraints);

  const conflictMask = ascendingContribution(left, node)
    | right.descendingFixed[JOIN_TYPE_SLOT[node.joinType]];
  const eligible = node.sesMask | conflictMask;

  constraints.push({
    operator: node,
    conflictMask,
    leftTes: (eligible & node.leftRels) || node.leftRels,
    rightTes: (eligible & node.rightRels) || node.rightRels,
  });

  mergeConflicts(left, right);
  accumulateAscending(left, node);
  accumulateDescending(left, node);
  return left;
}
