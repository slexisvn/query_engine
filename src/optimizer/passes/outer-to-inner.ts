import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType, JoinType, getChildren, type LogicalPlanNode } from '../../planner/logical-plan.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class OuterToInnerJoin extends OptimizationPass {
  get name() { return 'OuterToInnerJoin'; }

  apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new OuterToInnerRewriter();
    return rewriter.rewrite(plan);
  }
}

class OuterToInnerRewriter extends PlanRewriter {
  rewriteFilter(node: any): any {
    let child: any = this.rewrite(node.children[0]);

        if (child.type === PlanNodeType.JOIN && (child.joinType === JoinType.LEFT || child.joinType === JoinType.FULL || child.joinType === JoinType.RIGHT || child.joinType === JoinType.SINGLE)) {
      const leftRefs = getPlanRefs(child.children[0]);
      const rightRefs = getPlanRefs(child.children[1]);

            const predicates = splitConjuncts(node.condition);

            let rejectRightNulls = false;
      let rejectLeftNulls = false;

            for (const pred of predicates) {
        if (isNullRejecting(pred, rightRefs)) {
          rejectRightNulls = true;
        }
        if (isNullRejecting(pred, leftRefs)) {
          rejectLeftNulls = true;
        }
      }

            let newJoinType = child.joinType;

            if (child.joinType === JoinType.LEFT && rejectRightNulls) {
        newJoinType = JoinType.INNER;
      } else if (child.joinType === JoinType.SINGLE && rejectRightNulls) {
        newJoinType = JoinType.INNER;
      } else if (child.joinType === JoinType.RIGHT && rejectLeftNulls) {
        newJoinType = JoinType.INNER;
      } else if (child.joinType === JoinType.FULL) {
        if (rejectLeftNulls && rejectRightNulls) newJoinType = JoinType.INNER;
        else if (rejectLeftNulls) newJoinType = JoinType.LEFT;
        else if (rejectRightNulls) newJoinType = JoinType.RIGHT;
      }

            if (newJoinType !== child.joinType) {
        child = { ...child, joinType: newJoinType };
      }
    }

        if (child !== node.children[0]) {
      return { ...node, children: [child] };
    }
    return node;
  }
}

function getPlanRefs(planNode: any): any {
  const refs = { aliases: new Set<string>(), columns: new Set<string>() };
  addOutputRefs(planNode, refs);
  refs.aliases.delete('');
  refs.columns.delete('');
  return refs;
}

function addOutputRefs(node: any, refs: any): void {
  if (!node) return;
  if (node.type === PlanNodeType.SCAN) {
    refs.aliases.add((node.alias || node.table || '').toUpperCase());
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

function splitConjuncts(expr: any): any[] {
  if (!expr) return [];
  if (expr.kind === BoundExprKind.BINARY && expr.op.toUpperCase() === 'AND') {
    return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
  }
  return [expr];
}

function isNullRejecting(expr: any, nullSupplyingRefs: any): boolean {
  const result = evaluateWithNulls(expr, nullSupplyingRefs);
  return result === false || result === null;
}

function evaluateWithNulls(expr: any, nullRefs: any): any {
  if (!expr) return undefined;

    switch (expr.kind) {
    case BoundExprKind.LITERAL:
      return expr.value;

          case BoundExprKind.COLUMN_REF:
      if (expr.tableAlias && nullRefs.aliases.has(expr.tableAlias.toUpperCase())) {
        return null;
      }
      if (!expr.tableAlias && nullRefs.columns.has((expr.columnName || '').toUpperCase())) {
        return null;
      }
      return 'UNKNOWN';

          case BoundExprKind.BINARY: {
      const left = evaluateWithNulls(expr.left, nullRefs);
      const right = evaluateWithNulls(expr.right, nullRefs);
      const op = expr.op.toUpperCase();

            if (op === 'AND') {
        if (left === false || right === false) return false;
        if (left === null || right === null) return null;
        if (left === 'UNKNOWN' || right === 'UNKNOWN') return 'UNKNOWN';
        return true;
      }
      if (op === 'OR') {
        if (left === true || right === true) return true;
        if (left === 'UNKNOWN' || right === 'UNKNOWN') return 'UNKNOWN';
        if (left === null && right === null) return null;
        return false;
      }

            if (left === null || right === null) return null;

            return 'UNKNOWN';
    }

          case BoundExprKind.UNARY: {
      const operand = evaluateWithNulls(expr.operand, nullRefs);
      if (operand === null) return null;
      return 'UNKNOWN';
    }

          case BoundExprKind.FUNCTION:
    case BoundExprKind.EXTRACT:
    case BoundExprKind.CAST:
    case BoundExprKind.INTERVAL:
    case BoundExprKind.CASE:
    case BoundExprKind.AGGREGATE:
      return 'UNKNOWN';

          case BoundExprKind.IS_NULL: {
      const operand = evaluateWithNulls(expr.operand, nullRefs);
      if (operand === null) {
        return true;
      }
      return 'UNKNOWN';
    }
  }

    return 'UNKNOWN';
}
