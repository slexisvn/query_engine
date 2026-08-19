import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { PlanNodeType, setChildren, type LogicalPlanNode, type LogicalFilterNode, type LogicalProjectNode, type LogicalJoinNode, type LogicalEmptyNode, type ProjectedExpr } from '../../planner/logical-plan.js';
import { BoundExprKind, BoundLiteral, getExprType, type BoundExpr, type BoundBinaryNode, type LiteralValue } from '../../binder/expression-binder.js';
import { splitConjuncts, combineConjuncts } from './predicate-pushdown.js';
import { DataType } from '../../storage/data-type.js';

export class ExpressionSimplifier extends OptimizationPass {
  override get name() { return 'ExpressionSimplifier'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new SimplifierRewriter();
    return rewriter.rewrite(plan);
  }
}

class SimplifierRewriter extends PlanRewriter {
  override rewriteFilter(node: LogicalFilterNode): LogicalPlanNode {
    const child = this.rewrite(node.children[0]);
    const simplifiedCond = simplifyExpression(node.condition);

        if (simplifiedCond && simplifiedCond.kind === BoundExprKind.LITERAL && simplifiedCond.value === true) {
      return child;
    }

        if (simplifiedCond && simplifiedCond.kind === BoundExprKind.LITERAL && simplifiedCond.value === false) {
      const empty: LogicalEmptyNode = { type: PlanNodeType.EMPTY, children: [child] };
      return empty;
    }

        if (simplifiedCond !== node.condition || child !== node.children[0]) {
      return { ...node, condition: simplifiedCond, children: [child] };
    }
    return node;
  }

  override rewriteProject(node: LogicalProjectNode): LogicalPlanNode {
    const child = this.rewrite(node.children[0]);
    let changed = false;
    const newExprs = node.expressions.map((expr): ProjectedExpr => {
      const s = simplifyExpression(expr);
      if (s !== expr) changed = true;
      return s as ProjectedExpr;
    });

        if (changed || child !== node.children[0]) {
      return { ...node, expressions: newExprs, children: [child] };
    }
    return node;
  }

  override rewriteJoin(node: LogicalJoinNode): LogicalPlanNode {
    const newChildren = node.children.map((c) => this.rewrite(c));
    let changed = newChildren.some((c, i) => c !== node.children[i]);

        let newCond = node.condition;
    if (node.condition) {
      newCond = simplifyExpression(node.condition);
      if (newCond !== node.condition) changed = true;
    }

        if (changed) {
      return { ...node, condition: newCond, children: newChildren };
    }
    return node;
  }
}

export function simplifyExpression(expr: BoundExpr | null): BoundExpr | null {
  if (!expr) return expr;

    switch (expr.kind) {
    case BoundExprKind.BINARY: {
      const left = simplifyExpression(expr.left)!;
      const right = simplifyExpression(expr.right)!;
      const op = expr.op.toUpperCase();

            if (op === 'AND') {
        if (isLiteral(left, false) || isLiteral(right, false)) return BoundLiteral(false, DataType.BOOLEAN);
        if (isLiteral(left, true)) return right;
        if (isLiteral(right, true)) return left;
        if (exprEquals(left, right)) return left;
      } else if (op === 'OR') {
        if (isLiteral(left, true) || isLiteral(right, true)) return BoundLiteral(true, DataType.BOOLEAN);
        if (isLiteral(left, false)) return right;
        if (isLiteral(right, false)) return left;
        if (exprEquals(left, right)) return left;
        const factored = factorCommonConjuncts(left, right);
        if (factored) return simplifyExpression(factored);
      } else {
        if (op === '+' || op === '-') {
          if (isLiteral(right, 0)) return left;
          if (op === '+' && isLiteral(left, 0)) return right;
        }
        if (op === '*') {
          if (isLiteral(right, 1)) return left;
          if (isLiteral(left, 1)) return right;
        }
        if (op === '/') {
          if (isLiteral(right, 1)) return left;
        }

        if (left.kind === BoundExprKind.LITERAL && right.kind === BoundExprKind.LITERAL) {
          const lVal = left.value as number;
          const rVal = right.value as number;
          const exprType = getExprType(expr);
          if (lVal !== null && rVal !== null) {
            try {
              if (op === '+') return BoundLiteral(lVal + rVal, typeof (lVal + rVal) === 'number' ? DataType.FLOAT64 : exprType);
              if (op === '-') return BoundLiteral(lVal - rVal, typeof (lVal - rVal) === 'number' ? DataType.FLOAT64 : exprType);
              if (op === '*') return BoundLiteral(lVal * rVal, typeof (lVal * rVal) === 'number' ? DataType.FLOAT64 : exprType);
              if (op === '/') return BoundLiteral(lVal / rVal, DataType.FLOAT64);
              if (op === '=') return BoundLiteral(lVal === rVal, DataType.BOOLEAN);
              if (op === '!=') return BoundLiteral(lVal !== rVal, DataType.BOOLEAN);
              if (op === '>') return BoundLiteral(lVal > rVal, DataType.BOOLEAN);
              if (op === '>=') return BoundLiteral(lVal >= rVal, DataType.BOOLEAN);
              if (op === '<') return BoundLiteral(lVal < rVal, DataType.BOOLEAN);
              if (op === '<=') return BoundLiteral(lVal <= rVal, DataType.BOOLEAN);
            } catch (e) {
            }
          }
        }
      }

            if (left !== expr.left || right !== expr.right) {
        return { ...expr, left, right };
      }
      return expr;
    }
    case BoundExprKind.UNARY: {
      const operand = simplifyExpression(expr.operand)!;
      const op = expr.op.toUpperCase();

            if (op === 'NOT') {
        if (isLiteral(operand, true)) return BoundLiteral(false, DataType.BOOLEAN);
        if (isLiteral(operand, false)) return BoundLiteral(true, DataType.BOOLEAN);
        if (operand.kind === BoundExprKind.UNARY && operand.op.toUpperCase() === 'NOT') {
          return operand.operand;
        }
      }

            if (operand !== expr.operand) {
        return { ...expr, operand };
      }
      return expr;
    }
    case BoundExprKind.FUNCTION: {
      const args = expr.args.map(a => simplifyExpression(a)!);
      const changed = args.some((a, i) => a !== expr.args[i]);
      if (changed) {
        return { ...expr, args };
      }
      return expr;
    }
    case BoundExprKind.CASE: {
      const whenClauses: { condition: BoundExpr; result: BoundExpr }[] = [];
      let changed = false;
      for (const wc of expr.whenClauses) {
        const cond = simplifyExpression(wc.condition)!;
        const result = simplifyExpression(wc.result)!;
        if (cond !== wc.condition || result !== wc.result) changed = true;
        if (isLiteral(cond, false)) { changed = true; continue; }
        if (isLiteral(cond, true)) {
          return result;
        }
        whenClauses.push({ condition: cond, result });
      }
      const elseExpr = expr.elseExpr ? simplifyExpression(expr.elseExpr) : null;
      if (elseExpr !== expr.elseExpr) changed = true;
      if (whenClauses.length === 0 && elseExpr) return elseExpr;
      if (whenClauses.length === 0 && !elseExpr) return BoundLiteral(null, expr.resultType);
      if (changed) {
        return { ...expr, whenClauses, elseExpr };
      }
      return expr;
    }
    case BoundExprKind.CAST: {
      const inner = simplifyExpression(expr.expr)!;
      if (inner.kind === BoundExprKind.LITERAL && inner.value !== null) {
        const folded = foldCast(inner.value, expr.targetType);
        if (folded !== undefined) return BoundLiteral(folded, expr.targetType);
      }
      if (inner !== expr.expr) return { ...expr, expr: inner };
      return expr;
    }
    case BoundExprKind.EXTRACT: {
      const source = simplifyExpression(expr.source)!;
      const sourceVal = source.kind === BoundExprKind.LITERAL ? (source.value as LiteralValue | Date) : null;
      if (sourceVal instanceof Date) {
        const extracted = extractFromDate(sourceVal, expr.field);
        if (extracted !== null) return BoundLiteral(extracted, DataType.INT32);
      }
      if (source !== expr.source) return { ...expr, source };
      return expr;
    }
  }

  return expr;
}

function isLiteral(expr: BoundExpr | null, val: LiteralValue): boolean {
  return !!expr && expr.kind === BoundExprKind.LITERAL && expr.value === val;
}

function exprEquals(e1: BoundExpr | null, e2: BoundExpr | null): boolean {
  if (e1 === e2) return true;
  if (!e1 || !e2) return false;
  if (e1.kind !== e2.kind) return false;

    if (e1.kind === BoundExprKind.COLUMN_REF && e2.kind === BoundExprKind.COLUMN_REF) {
    return e1.tableAlias === e2.tableAlias && e1.columnName === e2.columnName;
  }
  if (e1.kind === BoundExprKind.LITERAL && e2.kind === BoundExprKind.LITERAL) {
    return e1.value === e2.value;
  }
  return exprKey(e1) === exprKey(e2);
}

function factorCommonConjuncts(left: BoundExpr, right: BoundExpr): BoundExpr | null {
  const leftConjuncts = splitConjuncts(left);
  const rightConjuncts = splitConjuncts(right);
  const rightByKey = new Map(rightConjuncts.map(expr => [exprKey(expr), expr]));
  const common: BoundExpr[] = [];
  const leftRest: BoundExpr[] = [];
  const commonKeys = new Set<string>();

  for (const expr of leftConjuncts) {
    const key = exprKey(expr);
    if (rightByKey.has(key)) {
      common.push(expr);
      commonKeys.add(key);
    } else {
      leftRest.push(expr);
    }
  }

  if (common.length === 0) return null;

  const rightRest = rightConjuncts.filter(expr => !commonKeys.has(exprKey(expr)));
  const leftRemainder = combineConjuncts(leftRest) || BoundLiteral(true, DataType.BOOLEAN);
  const rightRemainder = combineConjuncts(rightRest) || BoundLiteral(true, DataType.BOOLEAN);
  const residualOr: BoundBinaryNode = {
    kind: BoundExprKind.BINARY,
    op: 'OR',
    left: leftRemainder,
    right: rightRemainder,
    resultType: DataType.BOOLEAN,
  };

  return combineConjuncts([...common, residualOr]);
}

function foldCast(value: LiteralValue, targetType: string | null): LiteralValue | undefined {
  const type = (targetType || '').toUpperCase();
  try {
    if (type.includes('INT')) return Math.trunc(Number(value));
    if (type.includes('FLOAT') || type.includes('DOUBLE') || type.includes('DECIMAL') || type.includes('NUMERIC')) return Number(value);
    if (type.includes('VARCHAR') || type.includes('TEXT') || type.includes('CHAR')) return String(value);
    if (type.includes('BOOL')) return Boolean(value);
  } catch (_) {}
  return undefined;
}

function extractFromDate(date: Date, field: string): number | null {
  const f = (field || '').toUpperCase();
  if (f === 'YEAR') return date.getFullYear();
  if (f === 'MONTH') return date.getMonth() + 1;
  if (f === 'DAY') return date.getDate();
  if (f === 'HOUR') return date.getHours();
  if (f === 'MINUTE') return date.getMinutes();
  if (f === 'SECOND') return date.getSeconds();
  return null;
}

function exprKey(expr: BoundExpr | null): string {
  if (!expr || typeof expr !== 'object') return String(expr);
  switch (expr.kind) {
    case BoundExprKind.COLUMN_REF:
      return `COL:${expr.tableAlias || ''}.${expr.columnName}`;
    case BoundExprKind.LITERAL:
      return `LIT:${String(expr.value)}`;
    case BoundExprKind.BINARY:
      return `BIN:${expr.op}:${exprKey(expr.left)}:${exprKey(expr.right)}`;
    case BoundExprKind.LIKE:
      return `LIKE:${expr.negated}:${exprKey(expr.expr)}:${exprKey(expr.pattern)}`;
    case BoundExprKind.IN_LIST:
      return `IN:${expr.negated}:${exprKey(expr.expr)}:${Array.isArray(expr.list) ? expr.list.map(exprKey).join(',') : exprKey(expr.list)}`;
    case BoundExprKind.BETWEEN:
      return `BETWEEN:${expr.negated}:${exprKey(expr.expr)}:${exprKey(expr.low)}:${exprKey(expr.high)}`;
    default:
      return JSON.stringify(expr);
  }
}
