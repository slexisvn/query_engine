import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType, JoinType, getChildren, type LogicalPlanNode, type LogicalFilterNode } from '../../planner/logical-plan.js';
import { BoundExprKind, type BoundExpr, type LiteralValue } from '../../binder/expression-binder.js';

interface PlanRefs { aliases: Set<string>; columns: Set<string>; }

interface NamedExpr { outputName?: string; alias?: string; name?: string; columnName?: string; }

type EvalResult = LiteralValue | undefined;

export class OuterToInnerJoin extends OptimizationPass {
  override get name() { return 'OuterToInnerJoin'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new OuterToInnerRewriter();
    return rewriter.rewrite(plan);
  }
}

class OuterToInnerRewriter extends PlanRewriter {
  override rewriteFilter(node: LogicalFilterNode): LogicalPlanNode {
    let child: LogicalPlanNode = this.rewrite(node.children[0]);

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

            let newJoinType: JoinType = child.joinType;

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

function getPlanRefs(planNode: LogicalPlanNode): PlanRefs {
  const refs: PlanRefs = { aliases: new Set<string>(), columns: new Set<string>() };
  addOutputRefs(planNode, refs);
  refs.aliases.delete('');
  refs.columns.delete('');
  return refs;
}

function addOutputRefs(node: LogicalPlanNode, refs: PlanRefs): void {
  if (!node) return;
  if (node.type === PlanNodeType.SCAN) {
    refs.aliases.add((node.alias || node.table || '').toUpperCase());
    for (const col of node.columns || []) {
      refs.columns.add((col.name || (col as { columnName?: string }).columnName || '').toUpperCase());
    }
    return;
  }
  if (node.type === PlanNodeType.CTE_SCAN) {
    refs.aliases.add(((node as { alias?: string }).alias || node.cteName || '').toUpperCase());
    return;
  }
  if (node.type === PlanNodeType.PROJECT) {
    for (const expr of node.expressions || []) {
      const e = expr as NamedExpr;
      refs.columns.add((e.outputName || e.alias || e.name || e.columnName || '').toUpperCase());
    }
    return;
  }
  if (node.type === PlanNodeType.AGGREGATE) {
    for (const expr of node.groupBy || []) {
      const e = expr as NamedExpr;
      refs.columns.add((e.outputName || e.alias || e.name || e.columnName || '').toUpperCase());
    }
    for (const agg of node.aggregates || []) {
      const a = agg as NamedExpr;
      refs.columns.add((a.outputName || a.alias || a.name || '').toUpperCase());
    }
    return;
  }
  if (node.type === PlanNodeType.JOIN || node.type === PlanNodeType.UNION) {
    for (const child of getChildren(node)) addOutputRefs(child, refs);
    return;
  }
  if (node.children?.[0]) addOutputRefs(node.children[0], refs);
}

function splitConjuncts(expr: BoundExpr | null): BoundExpr[] {
  if (!expr) return [];
  if (expr.kind === BoundExprKind.BINARY && expr.op.toUpperCase() === 'AND') {
    return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
  }
  return [expr];
}

function isNullRejecting(expr: BoundExpr, nullSupplyingRefs: PlanRefs): boolean {
  const result = evaluateWithNulls(expr, nullSupplyingRefs);
  return result === false || result === null;
}

function evaluateWithNulls(expr: BoundExpr | null | undefined, nullRefs: PlanRefs): EvalResult {
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
      const operand = evaluateWithNulls((expr as { operand?: BoundExpr }).operand, nullRefs);
      if (operand === null) {
        return true;
      }
      return 'UNKNOWN';
    }
  }

    return 'UNKNOWN';
}
