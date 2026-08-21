import { JoinType } from './logical-plan.js';
import { isPureEquiJoin } from './sort-properties.js';
import type { BoundExpr } from '../binder/expression-binder.js';

export type JoinBuildSide = 'left' | 'right';

const PROBE_PRESERVING_JOINS: ReadonlySet<JoinType> = new Set([
  JoinType.LEFT,
  JoinType.SEMI,
  JoinType.ANTI,
  JoinType.MARK,
  JoinType.SINGLE,
]);

const DEDUPABLE_JOINS: ReadonlySet<JoinType> = new Set([
  JoinType.SEMI,
  JoinType.ANTI,
  JoinType.MARK,
]);

export function chooseJoinBuildSide(joinType: JoinType, leftCardinality: number, rightCardinality: number): JoinBuildSide {
  if (PROBE_PRESERVING_JOINS.has(joinType)) return 'right';
  if (joinType === JoinType.RIGHT) return 'left';
  return rightCardinality < leftCardinality ? 'right' : 'left';
}

export function isBuildSidePreserved(joinType: JoinType, buildIsLeftChild: boolean): boolean {
  return joinType === JoinType.FULL || (joinType === JoinType.LEFT && buildIsLeftChild);
}

export function isEquiJoinDedupable(joinType: JoinType, condition: BoundExpr | null): boolean {
  return DEDUPABLE_JOINS.has(joinType) && isPureEquiJoin(condition);
}
