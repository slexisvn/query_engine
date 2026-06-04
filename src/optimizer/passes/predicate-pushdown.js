import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, LogicalFilter, LogicalJoin, getChildren, setChildren } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class PredicatePushdown extends OptimizationPass {
  get name() { return 'PredicatePushdown'; }

  apply(plan) {
    const rewriter = new PushdownRewriter();
    return rewriter.rewrite(plan);
  }
}

class PushdownRewriter extends PlanRewriter {
  rewriteJoin(node) {
    const rewritten = this.rewriteChildren(node);
    return pushJoinConditionPredicates(rewritten);
  }

  rewriteFilter(node) {
    const child = this.rewrite(node.children[0]);
    const predicates = splitConjuncts(node.condition);
    return pushPredicates(predicates, child);
  }

  rewriteDefault(node) {
    return this.rewriteChildren(node);
  }
}

function pushJoinConditionPredicates(joinNode) {
  if (!joinNode.condition) return joinNode;

  const rightRefs = collectPlanRefs(joinNode.children[1]);
  const rightPreds = [];
  const joinPreds = [];

  for (const pred of splitConjuncts(joinNode.condition)) {
    const refs = collectTableRefs(pred);
    const rightOnly = refs.length > 0 && refs.every(r => refBelongsToPlan(r, rightRefs));

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

function copyJoinProperties(joinNode) {
  const props = {};
  if (joinNode.markColumn) props.markColumn = joinNode.markColumn;
  for (const key of Object.keys(joinNode)) {
    if (key.startsWith('_')) props[key] = joinNode[key];
  }
  return props;
}

function pushPredicates(predicates, target) {
  if (target.type === PlanNodeType.JOIN) {
    return pushIntoJoin(predicates, target);
  }

  if (target.type === PlanNodeType.FILTER) {
    const innerPreds = splitConjuncts(target.condition);
    const allPreds = [...innerPreds, ...predicates];
    const child = target.children[0];
    return pushPredicates(allPreds, child);
  }

  if (target.type === PlanNodeType.PROJECT) {
    const pushable = [];
    const remaining = [];
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

function canPushThroughProject(pred, projectNode) {
  const predRefs = new Set();
  _walkExpr(pred, e => {
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

function pushIntoJoin(predicates, joinNode) {
  const leftRefs = collectPlanRefs(joinNode.children[0]);
  const rightRefs = collectPlanRefs(joinNode.children[1]);

  const leftPreds = [];
  const rightPreds = [];
  const joinPreds = [];
  const remaining = [];

  for (const pred of predicates) {
    const refs = collectTableRefs(pred);
    const leftOnly = refs.every(r => refBelongsToPlan(r, leftRefs));
    const rightOnly = refs.every(r => refBelongsToPlan(r, rightRefs));

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

  let result = LogicalJoin(
    joinNode.joinType === JoinType.CROSS && joinCondition ? JoinType.INNER : joinNode.joinType,
    joinCondition,
    left,
    right,
  );
  if (joinNode.markColumn) result.markColumn = joinNode.markColumn;

  if (remaining.length > 0) {
    result = LogicalFilter(combineConjuncts(remaining), result);
  }

  return result;
}

function rejectsNulls(pred) {
  if (pred.kind === BoundExprKind.BINARY) {
    return ['=', '<>', '<', '>', '<=', '>='].includes(pred.op);
  }
  if (pred.kind === BoundExprKind.IS_NULL && !pred.negated) {
    return false;
  }
  return true;
}

export function splitConjuncts(expr) {
  if (!expr) return [];
  if (expr.kind === BoundExprKind.BINARY && expr.op === 'AND') {
    return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
  }
  return [expr];
}

export function combineConjuncts(preds) {
  if (preds.length === 0) return null;
  if (preds.length === 1) return preds[0];
  return preds.reduce((acc, p) => ({
    kind: BoundExprKind.BINARY,
    op: 'AND',
    left: acc,
    right: p,
    resultType: 'BOOLEAN',
  }));
}

function collectPlanRefs(node) {
  const refs = { aliases: new Set(), columns: new Set() };
  addOutputRefs(node, refs);
  refs.aliases.delete('');
  refs.columns.delete('');
  return refs;
}

function addOutputRefs(node, refs) {
  if (!node) return;
  if (node.type === PlanNodeType.SCAN) {
    refs.aliases.add(node.alias?.toUpperCase() || node.table?.toUpperCase());
    for (const col of node.columns || []) {
      refs.columns.add((col.name || col.columnName || '').toUpperCase());
    }
    return;
  }
  if (node.type === PlanNodeType.CTE_SCAN) {
    refs.aliases.add((node.alias || node.cteName || '').toUpperCase());
    return;
  }
  if (node.type === PlanNodeType.PROJECT) {
    for (const expr of node.expressions || []) {
      refs.columns.add((expr.outputName || expr.alias || expr.name || expr.columnName || '').toUpperCase());
    }
    return;
  }
  if (node.type === PlanNodeType.AGGREGATE) {
    for (const expr of node.groupBy || []) {
      refs.columns.add((expr.outputName || expr.alias || expr.name || expr.columnName || '').toUpperCase());
    }
    for (const agg of node.aggregates || []) {
      refs.columns.add((agg.outputName || agg.alias || agg.name || '').toUpperCase());
    }
    return;
  }
  if (node.type === PlanNodeType.JOIN || node.type === PlanNodeType.UNION) {
    for (const child of getChildren(node)) addOutputRefs(child, refs);
    return;
  }
  if (node.children?.[0]) addOutputRefs(node.children[0], refs);
}

function refBelongsToPlan(ref, planRefs) {
  if (ref.tableAlias) return planRefs.aliases.has(ref.tableAlias);
  return planRefs.columns.has(ref.columnName);
}

function collectTableRefs(expr) {
  const keys = new Set();
  _walkExpr(expr, e => {
    if (e.kind === BoundExprKind.COLUMN_REF) {
      keys.add(`${(e.tableAlias || '').toUpperCase()}.${(e.columnName || '').toUpperCase()}`);
    }
  });
  return [...keys].map(key => {
    const [tableAlias, columnName] = key.split('.');
    return { tableAlias, columnName };
  });
}

function _walkExpr(expr, fn) {
  if (!expr || typeof expr !== 'object') return;
  fn(expr);
  if (expr.left) _walkExpr(expr.left, fn);
  if (expr.right) _walkExpr(expr.right, fn);
  if (expr.operand) _walkExpr(expr.operand, fn);
  if (expr.expr) _walkExpr(expr.expr, fn);
  if (expr.low) _walkExpr(expr.low, fn);
  if (expr.high) _walkExpr(expr.high, fn);
  if (expr.args) for (const a of expr.args) _walkExpr(a, fn);
  if (expr.whenClauses) for (const wc of expr.whenClauses) { _walkExpr(wc.condition, fn); _walkExpr(wc.result, fn); }
  if (expr.elseExpr) _walkExpr(expr.elseExpr, fn);
  if (expr.list && Array.isArray(expr.list)) for (const item of expr.list) _walkExpr(item, fn);
  if (expr.pattern) _walkExpr(expr.pattern, fn);
  if (expr.source) _walkExpr(expr.source, fn);
}
