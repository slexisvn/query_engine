import { NodeKind } from '../parser/ast.js';
import { DataType } from '../storage/data-type.js';

export const BoundExprKind = {
  COLUMN_REF: 'BoundColumnRef',
  LITERAL: 'BoundLiteral',
  BINARY: 'BoundBinary',
  UNARY: 'BoundUnary',
  FUNCTION: 'BoundFunction',
  AGGREGATE: 'BoundAggregate',
  CASE: 'BoundCase',
  CAST: 'BoundCast',
  BETWEEN: 'BoundBetween',
  IN_LIST: 'BoundInList',
  LIKE: 'BoundLike',
  IS_NULL: 'BoundIsNull',
  SUBQUERY: 'BoundSubquery',
  EXISTS: 'BoundExists',
  EXTRACT: 'BoundExtract',
  INTERVAL: 'BoundInterval',
  COMPARISON: 'BoundComparison',
  WINDOW: 'BoundWindow',
};

export function BoundColumnRef(tableAlias, columnName, columnIndex, dataType, depth = 0) {
  return {
    kind: BoundExprKind.COLUMN_REF,
    tableAlias,
    columnName,
    columnIndex,
    dataType,
    depth,
    isCorrelated: depth > 0,
  };
}

export function BoundLiteral(value, dataType) {
  return { kind: BoundExprKind.LITERAL, value, dataType };
}

export function BoundBinary(op, left, right, resultType) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType };
}

export function BoundUnary(op, operand, resultType) {
  return { kind: BoundExprKind.UNARY, op, operand, resultType };
}

export function BoundFunction(name, args, resultType) {
  return { kind: BoundExprKind.FUNCTION, name, args, resultType };
}

export function BoundAggregate(name, args, distinct, resultType) {
  return { kind: BoundExprKind.AGGREGATE, name, args, distinct, resultType };
}

export function BoundCase(operand, whenClauses, elseExpr, resultType) {
  return { kind: BoundExprKind.CASE, operand, whenClauses, elseExpr, resultType };
}

export function BoundCast(expr, targetType) {
  return { kind: BoundExprKind.CAST, expr, targetType };
}

export function BoundBetween(expr, low, high, negated) {
  return { kind: BoundExprKind.BETWEEN, expr, low, high, negated, resultType: DataType.BOOLEAN };
}

export function BoundInList(expr, list, negated) {
  return { kind: BoundExprKind.IN_LIST, expr, list, negated, resultType: DataType.BOOLEAN };
}

export function BoundLike(expr, pattern, negated) {
  return { kind: BoundExprKind.LIKE, expr, pattern, negated, resultType: DataType.BOOLEAN };
}

export function BoundIsNull(expr, negated) {
  return { kind: BoundExprKind.IS_NULL, expr, negated, resultType: DataType.BOOLEAN };
}

export function BoundSubquery(plan, subqueryType) {
  return { kind: BoundExprKind.SUBQUERY, plan, subqueryType };
}

export function BoundExists(plan, negated) {
  return { kind: BoundExprKind.EXISTS, plan, negated, resultType: DataType.BOOLEAN };
}

export function BoundExtract(field, source) {
  return { kind: BoundExprKind.EXTRACT, field, source, resultType: DataType.INT32 };
}

export function BoundInterval(value, unit) {
  return { kind: BoundExprKind.INTERVAL, value, unit, resultType: DataType.INT32 };
}

export function BoundWindow(name, args, partitionBy, orderBy, resultType) {
  return { kind: BoundExprKind.WINDOW, name, args, partitionBy, orderBy, resultType };
}

export function getExprType(expr) {
  if (!expr) return null;
  return expr.resultType || expr.dataType || null;
}

export function collectCorrelatedColumns(expr) {
  const refs = [];
  _walkExpr(expr, node => {
    if (node.kind === BoundExprKind.COLUMN_REF && node.isCorrelated) {
      refs.push(node);
    }
  });
  return refs;
}

function _walkExpr(expr, fn) {
  if (!expr) return;
  fn(expr);
  switch (expr.kind) {
    case BoundExprKind.BINARY:
      _walkExpr(expr.left, fn);
      _walkExpr(expr.right, fn);
      break;
    case BoundExprKind.UNARY:
      _walkExpr(expr.operand, fn);
      break;
    case BoundExprKind.FUNCTION:
    case BoundExprKind.AGGREGATE:
      for (const arg of expr.args) _walkExpr(arg, fn);
      break;
    case BoundExprKind.CASE:
      if (expr.operand) _walkExpr(expr.operand, fn);
      for (const wc of expr.whenClauses) {
        _walkExpr(wc.condition, fn);
        _walkExpr(wc.result, fn);
      }
      if (expr.elseExpr) _walkExpr(expr.elseExpr, fn);
      break;
    case BoundExprKind.CAST:
      _walkExpr(expr.expr, fn);
      break;
    case BoundExprKind.BETWEEN:
      _walkExpr(expr.expr, fn);
      _walkExpr(expr.low, fn);
      _walkExpr(expr.high, fn);
      break;
    case BoundExprKind.IN_LIST:
      _walkExpr(expr.expr, fn);
      if (Array.isArray(expr.list)) {
        for (const item of expr.list) _walkExpr(item, fn);
      }
      break;
    case BoundExprKind.LIKE:
      _walkExpr(expr.expr, fn);
      _walkExpr(expr.pattern, fn);
      break;
    case BoundExprKind.IS_NULL:
      _walkExpr(expr.expr, fn);
      break;
    case BoundExprKind.EXTRACT:
      _walkExpr(expr.source, fn);
      break;
    case BoundExprKind.WINDOW:
      for (const arg of expr.args) _walkExpr(arg, fn);
      for (const p of expr.partitionBy) _walkExpr(p, fn);
      for (const o of expr.orderBy) _walkExpr(o.expr, fn);
      break;
  }
}
