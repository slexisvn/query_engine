import { splitConjuncts } from '../../binder/conjuncts.js';
import type { BoundExpr } from '../../binder/expression-binder.js';
import {
  PlanNodeType,
  getChildren,
  type LogicalJoinNode,
  type LogicalPlanNode,
} from '../../planner/logical-plan.js';
import { ownExpressions, referencesCorrelation, type CorrelationSet } from './correlation.js';
import { LiftedDomain, MaterializedDomain, equiBindingColumn, type CorrelationDomain } from './domain.js';
import { DOMAIN_CARRYING_SIDES, DomainRole, LIFTABLE_JOIN_CONDITIONS, domainRoleOf } from './pushdown.js';

const LIFTABLE_PREDICATE_HOLDERS: ReadonlySet<PlanNodeType> = new Set([PlanNodeType.FILTER, PlanNodeType.JOIN]);

function liftablePredicate(node: LogicalPlanNode): BoundExpr | null {
  if (!LIFTABLE_PREDICATE_HOLDERS.has(node.type)) return null;
  if (node.type === PlanNodeType.JOIN && !LIFTABLE_JOIN_CONDITIONS.has(node.joinType)) return null;
  return (node as { condition?: BoundExpr | null }).condition ?? null;
}

function expressionsAreLiftable(node: LogicalPlanNode, set: CorrelationSet, underConsumer: boolean): boolean {
  const predicate = liftablePredicate(node);
  for (const expr of ownExpressions(node)) {
    if (!referencesCorrelation(expr, set)) continue;
    if (expr !== predicate) return false;
    const correlatedConjuncts = splitConjuncts(expr).filter((pred) => referencesCorrelation(pred, set));
    if (underConsumer && correlatedConjuncts.some((pred) => equiBindingColumn(pred, set) === null)) return false;
  }
  return true;
}

function branchesAreLiftable(node: LogicalPlanNode, correlated: ReadonlySet<LogicalPlanNode>): boolean {
  if (node.type === PlanNodeType.SET_OP) return false;
  if (node.type === PlanNodeType.CTE_ANCHOR) return !correlated.has(getChildren(node)[0]);

  const join = node as LogicalJoinNode;
  const correlatedSides = join.children.flatMap((child, index) => (correlated.has(child) ? [index] : []));
  if (correlatedSides.length > 1) return false;
  return correlatedSides.every((index) => DOMAIN_CARRYING_SIDES[join.joinType].includes(index));
}

export function canLiftCorrelation(subquery: LogicalPlanNode, set: CorrelationSet, correlated: ReadonlySet<LogicalPlanNode>): boolean {
  const visit = (node: LogicalPlanNode, underConsumer: boolean): boolean => {
    if (!correlated.has(node)) return true;
    const role = domainRoleOf(node);
    if (role === DomainRole.BRANCHING && !branchesAreLiftable(node, correlated)) return false;
    if (!expressionsAreLiftable(node, set, underConsumer)) return false;
    const childrenUnderConsumer = underConsumer || role === DomainRole.CONSUMES;
    return getChildren(node).every((child) => visit(child, childrenUnderConsumer));
  };
  return visit(subquery, false);
}

export function chooseDomain(
  subquery: LogicalPlanNode,
  outer: LogicalPlanNode,
  set: CorrelationSet,
  correlated: ReadonlySet<LogicalPlanNode>,
): CorrelationDomain {
  return canLiftCorrelation(subquery, set, correlated)
    ? new LiftedDomain(set)
    : new MaterializedDomain(set, outer);
}
