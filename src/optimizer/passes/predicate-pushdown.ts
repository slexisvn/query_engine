import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, LogicalFilter, LogicalJoin, setChildren, type LogicalPlanNode, type LogicalJoinNode, type LogicalProjectNode, type LogicalFilterNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { BoundExprKind, type BoundExpr, type BoundBinaryNode } from '../../binder/expression-binder.js';
import { walkExpr, containsAggregate } from './expr-walk.js';
import { collectPlanRefs, refBelongsToPlan, type ExprRef } from './plan-refs.js';

type MetadataValue = string | number | boolean | object | null | undefined;

type JoinWithMark = LogicalJoinNode & { markColumn?: string };

export class PredicatePushdown extends OptimizationPass {
  override get name() { return 'PredicatePushdown'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new PushdownRewriter();
    return rewriter.rewrite(plan);
  }
}

class PushdownRewriter extends PlanRewriter {
  override rewriteJoin(node: LogicalJoinNode): LogicalPlanNode {
    const rewritten = this.rewriteChildren(node);
    return pushJoinConditionPredicates(rewritten);
  }

  override rewriteFilter(node: LogicalFilterNode): LogicalPlanNode {
    const child = this.rewrite(node.children[0]);
    const predicates = splitConjuncts(node.condition);
    return pushPredicates(predicates, child);
  }

  override rewriteDefault(node: LogicalPlanNode): LogicalPlanNode {
    return this.rewriteChildren(node);
  }
}

function pushJoinConditionPredicates(joinNode: LogicalJoinNode): LogicalPlanNode {
  if (!joinNode.condition) return joinNode;

  const rightRefs = collectPlanRefs(joinNode.children[1]);
  const rightPreds: BoundExpr[] = [];
  const joinPreds: BoundExpr[] = [];

  for (const pred of splitConjuncts(joinNode.condition)) {
    const refs = collectTableRefs(pred);
    const rightOnly = refs.length > 0 && refs.every((r) => refBelongsToPlan(r, rightRefs));

    if (joinNode.joinType === JoinType.LEFT) {
      if (rightOnly) rightPreds.push(pred);
      else joinPreds.push(pred);
    } else {
      joinPreds.push(pred);
    }
  }

  if (rightPreds.length === 0) return joinNode;

  let right = joinNode.children[1];
  if (rightPreds.length > 0) right = pushPredicates(rightPreds, right);

  const result = {
    ...LogicalJoin(
      joinNode.joinType === JoinType.CROSS && joinPreds.length > 0 ? JoinType.INNER : joinNode.joinType,
      combineConjuncts(joinPreds),
      joinNode.children[0],
      right,
    ),
    ...copyJoinProperties(joinNode),
  };
  return result;
}

function copyJoinProperties(joinNode: LogicalJoinNode): Record<string, MetadataValue> {
  const props: Record<string, MetadataValue> = {};
  const src = joinNode as JoinWithMark & Record<string, MetadataValue>;
  if (src.markColumn) props.markColumn = src.markColumn;
  for (const key of Object.keys(src)) {
    if (key.startsWith('_')) props[key] = src[key];
  }
  return props;
}

function pushPredicates(predicates: BoundExpr[], target: LogicalPlanNode): LogicalPlanNode {
  if (target.type === PlanNodeType.JOIN) {
    return pushIntoJoin(predicates, target);
  }

  if (target.type === PlanNodeType.FILTER) {
    const innerPreds = splitConjuncts(target.condition);
    const allPreds = [...innerPreds, ...predicates];
    const child = target.children[0];
    return pushPredicates(allPreds, child);
  }

  if (target.type === PlanNodeType.AGGREGATE && target.groupBy && target.groupBy.length > 0) {
    const groupByRefs = new Set<string>();
    for (const gb of target.groupBy) {
      if (gb.kind === BoundExprKind.COLUMN_REF) {
        groupByRefs.add(`${(gb.tableAlias || '').toUpperCase()}.${(gb.columnName || '').toUpperCase()}`);
      }
    }
    const pushable: BoundExpr[] = [];
    const remaining: BoundExpr[] = [];
    for (const pred of predicates) {
      const refs = collectTableRefs(pred);
      if (refs.length > 0 && !containsAggregate(pred) && refs.every((r) => groupByRefs.has(`${r.tableAlias}.${r.columnName}`))) {
        pushable.push(pred);
      } else {
        remaining.push(pred);
      }
    }
    if (pushable.length > 0) {
      const newChild = pushPredicates(pushable, target.children[0]);
      const newAgg = { ...target, children: [newChild] };
      if (remaining.length === 0) return newAgg;
      return LogicalFilter(combineConjuncts(remaining), newAgg);
    }
  }

  if (target.type === PlanNodeType.PROJECT) {
    const pushable: BoundExpr[] = [];
    const remaining: BoundExpr[] = [];
    for (const pred of predicates) {
      if (canPushThroughProject(pred, target)) {
        pushable.push(pred);
      } else {
        remaining.push(pred);
      }
    }
    if (pushable.length > 0) {
      const newChild = pushPredicates(pushable, target.children[0]);
      const newProject = { ...target, children: [newChild] };
      if (remaining.length === 0) return newProject;
      return LogicalFilter(combineConjuncts(remaining), newProject);
    }
  }

  if (predicates.length === 0) return target;
  return LogicalFilter(combineConjuncts(predicates), target);
}

function canPushThroughProject(pred: BoundExpr, projectNode: LogicalProjectNode): boolean {
  const predRefs = new Set<ExprRef>();
  walkExpr(pred, (e) => {
    if (e.kind === BoundExprKind.COLUMN_REF) {
      predRefs.add({
        tableAlias: (e.tableAlias || '').toUpperCase(),
        columnName: (e.columnName || '').toUpperCase(),
      });
    }
  });

  const childRefs = collectPlanRefs(projectNode.children[0]);
  for (const ref of predRefs) {
    if (!refBelongsToPlan(ref, childRefs)) return false;
  }
  return true;
}

function pushIntoJoin(predicates: BoundExpr[], joinNode: LogicalJoinNode): LogicalPlanNode {
  const leftRefs = collectPlanRefs(joinNode.children[0]);
  const rightRefs = collectPlanRefs(joinNode.children[1]);

  const leftPreds: BoundExpr[] = [];
  const rightPreds: BoundExpr[] = [];
  const joinPreds: BoundExpr[] = [];
  const remaining: BoundExpr[] = [];

  for (const pred of predicates) {
    const refs = collectTableRefs(pred);
    const leftOnly = refs.every((r) => refBelongsToPlan(r, leftRefs));
    const rightOnly = refs.every((r) => refBelongsToPlan(r, rightRefs));

    if (joinNode.joinType === JoinType.INNER || joinNode.joinType === JoinType.CROSS) {
      if (leftOnly) leftPreds.push(pred);
      else if (rightOnly) rightPreds.push(pred);
      else joinPreds.push(pred);
    } else if (joinNode.joinType === JoinType.LEFT) {
      if (leftOnly) leftPreds.push(pred);
      else if (rightOnly && rejectsNulls(pred)) {
        rightPreds.push(pred);
        joinNode = { ...joinNode, joinType: JoinType.INNER };
      } else {
        remaining.push(pred);
      }
    } else if (joinNode.joinType === JoinType.SEMI || joinNode.joinType === JoinType.ANTI || joinNode.joinType === JoinType.MARK) {
      if (leftOnly) leftPreds.push(pred);
      else if (rightOnly) rightPreds.push(pred);
      else remaining.push(pred);
    } else {
      remaining.push(pred);
    }
  }

  let left = joinNode.children[0];
  let right = joinNode.children[1];

  if (leftPreds.length > 0) left = pushPredicates(leftPreds, left);
  if (rightPreds.length > 0) right = pushPredicates(rightPreds, right);

  let joinCondition = joinNode.condition;
  if (joinPreds.length > 0) {
    const allJoinPreds = joinCondition ? [joinCondition, ...joinPreds] : joinPreds;
    joinCondition = combineConjuncts(allJoinPreds);
  }

  let result: LogicalPlanNode = LogicalJoin(
    joinNode.joinType === JoinType.CROSS && joinCondition ? JoinType.INNER : joinNode.joinType,
    joinCondition,
    left,
    right,
  );
  const srcMark = (joinNode as JoinWithMark).markColumn;
  if (srcMark) (result as JoinWithMark).markColumn = srcMark;

  if (remaining.length > 0) {
    result = LogicalFilter(combineConjuncts(remaining), result);
  }

  return result;
}

function rejectsNulls(pred: BoundExpr): boolean {
  if (pred.kind === BoundExprKind.BINARY) {
    return ['=', '<>', '<', '>', '<=', '>='].includes(pred.op);
  }
  if (pred.kind === BoundExprKind.IS_NULL && !pred.negated) {
    return false;
  }
  return true;
}

export function splitConjuncts(expr: BoundExpr | null): BoundExpr[] {
  if (!expr) return [];
  if (expr.kind === BoundExprKind.BINARY && expr.op?.toUpperCase() === 'AND') {
    return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
  }
  return [expr];
}

export function combineConjuncts(preds: BoundExpr[]): BoundExpr | null {
  if (preds.length === 0) return null;
  if (preds.length === 1) return preds[0];
  return preds.reduce((acc, p): BoundBinaryNode => ({
    kind: BoundExprKind.BINARY,
    op: 'AND',
    left: acc,
    right: p,
    resultType: 'BOOLEAN',
  }));
}

function collectTableRefs(expr: BoundExpr): ExprRef[] {
  const keys = new Set<string>();
  walkExpr(expr, (e) => {
    if (e.kind === BoundExprKind.COLUMN_REF) {
      keys.add(`${(e.tableAlias || '').toUpperCase()}.${(e.columnName || '').toUpperCase()}`);
    }
  });
  return [...keys].map(key => {
    const [tableAlias, columnName] = key.split('.');
    return { tableAlias, columnName };
  });
}

