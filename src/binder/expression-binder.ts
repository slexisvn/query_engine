import { NodeKind } from '../parser/ast.js';
import { DataType } from '../storage/data-type.js';

export enum BoundExprKind {
  COLUMN_REF = 'BoundColumnRef',
  LITERAL = 'BoundLiteral',
  BINARY = 'BoundBinary',
  UNARY = 'BoundUnary',
  FUNCTION = 'BoundFunction',
  AGGREGATE = 'BoundAggregate',
  CASE = 'BoundCase',
  CAST = 'BoundCast',
  BETWEEN = 'BoundBetween',
  IN_LIST = 'BoundInList',
  LIKE = 'BoundLike',
  IS_NULL = 'BoundIsNull',
  SUBQUERY = 'BoundSubquery',
  EXISTS = 'BoundExists',
  EXTRACT = 'BoundExtract',
  INTERVAL = 'BoundInterval',
  COMPARISON = 'BoundComparison',
  WINDOW = 'BoundWindow',
}

export type BoundExpr =
  | BoundColumnRefNode | BoundLiteralNode | BoundBinaryNode | BoundUnaryNode
  | BoundFunctionNode | BoundAggregateNode | BoundCaseNode | BoundCastNode
  | BoundBetweenNode | BoundInListNode | BoundLikeNode | BoundIsNullNode
  | BoundSubqueryNode | BoundExistsNode | BoundExtractNode | BoundIntervalNode
  | BoundWindowNode;

export interface BoundWhenClause { condition: BoundExpr; result: BoundExpr; }

export interface BoundWindowOrderKey { expr: BoundExpr; direction?: string; nullOrder?: string | null; }

export interface BoundColumnRefNode {
  kind: BoundExprKind.COLUMN_REF;
  tableAlias: string;
  columnName: string;
  columnIndex: number;
  dataType: string | null;
  depth: number;
  isCorrelated: boolean;
}

export interface BoundLiteralNode { kind: BoundExprKind.LITERAL; value: unknown; dataType: string | null; }

export interface BoundBinaryNode { kind: BoundExprKind.BINARY; op: string; left: BoundExpr; right: BoundExpr; resultType: string; }

export interface BoundUnaryNode { kind: BoundExprKind.UNARY; op: string; operand: BoundExpr; resultType: string | null; }

export interface BoundFunctionNode { kind: BoundExprKind.FUNCTION; name: string; args: BoundExpr[]; resultType: string | null; }

export interface BoundAggregateNode { kind: BoundExprKind.AGGREGATE; name: string; args: BoundExpr[]; distinct: boolean; resultType: string; }

export interface BoundCaseNode {
  kind: BoundExprKind.CASE;
  operand: BoundExpr | null;
  whenClauses: BoundWhenClause[];
  elseExpr: BoundExpr | null;
  resultType: string;
}

export interface BoundCastNode { kind: BoundExprKind.CAST; expr: BoundExpr; targetType: string; dataType: string; }

export interface BoundBetweenNode { kind: BoundExprKind.BETWEEN; expr: BoundExpr; low: BoundExpr; high: BoundExpr; negated: boolean; resultType: string; }

export interface BoundInListNode { kind: BoundExprKind.IN_LIST; expr: BoundExpr; list: BoundExpr | BoundExpr[]; negated: boolean; resultType: string; }

export interface BoundLikeNode { kind: BoundExprKind.LIKE; expr: BoundExpr; pattern: BoundExpr; negated: boolean; resultType: string; }

export interface BoundIsNullNode { kind: BoundExprKind.IS_NULL; expr: BoundExpr; negated: boolean; resultType: string; }

export interface BoundSubqueryNode { kind: BoundExprKind.SUBQUERY; plan: unknown; subqueryType: string; }

export interface BoundExistsNode { kind: BoundExprKind.EXISTS; plan: unknown; negated: boolean; resultType: string; }

export interface BoundExtractNode { kind: BoundExprKind.EXTRACT; field: string; source: BoundExpr; resultType: string; }

export interface BoundIntervalNode { kind: BoundExprKind.INTERVAL; value: unknown; unit: string; resultType: string; }

export interface BoundWindowNode {
  kind: BoundExprKind.WINDOW;
  name: string;
  args: BoundExpr[];
  partitionBy: BoundExpr[];
  orderBy: BoundWindowOrderKey[];
  resultType: string | null;
}

export function BoundColumnRef(tableAlias: string, columnName: string, columnIndex: number, dataType: string | null, depth: number = 0): BoundColumnRefNode {
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

export function BoundLiteral(value: unknown, dataType: string | null): BoundLiteralNode {
  return { kind: BoundExprKind.LITERAL, value, dataType };
}

export function BoundBinary(op: string, left: BoundExpr, right: BoundExpr, resultType: string): BoundBinaryNode {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType };
}

export function BoundUnary(op: string, operand: BoundExpr, resultType: string | null): BoundUnaryNode {
  return { kind: BoundExprKind.UNARY, op, operand, resultType };
}

export function BoundFunction(name: string, args: BoundExpr[], resultType: string | null): BoundFunctionNode {
  return { kind: BoundExprKind.FUNCTION, name, args, resultType };
}

export function BoundAggregate(name: string, args: BoundExpr[], distinct: boolean, resultType: string): BoundAggregateNode {
  return { kind: BoundExprKind.AGGREGATE, name, args, distinct, resultType };
}

export function BoundCase(operand: BoundExpr | null, whenClauses: BoundWhenClause[], elseExpr: BoundExpr | null, resultType: string): BoundCaseNode {
  return { kind: BoundExprKind.CASE, operand, whenClauses, elseExpr, resultType };
}

export function BoundCast(expr: BoundExpr, targetType: string): BoundCastNode {
  return { kind: BoundExprKind.CAST, expr, targetType, dataType: targetType };
}

export function BoundBetween(expr: BoundExpr, low: BoundExpr, high: BoundExpr, negated: boolean): BoundBetweenNode {
  return { kind: BoundExprKind.BETWEEN, expr, low, high, negated, resultType: DataType.BOOLEAN };
}

export function BoundInList(expr: BoundExpr, list: BoundExpr | BoundExpr[], negated: boolean): BoundInListNode {
  return { kind: BoundExprKind.IN_LIST, expr, list, negated, resultType: DataType.BOOLEAN };
}

export function BoundLike(expr: BoundExpr, pattern: BoundExpr, negated: boolean): BoundLikeNode {
  return { kind: BoundExprKind.LIKE, expr, pattern, negated, resultType: DataType.BOOLEAN };
}

export function BoundIsNull(expr: BoundExpr, negated: boolean): BoundIsNullNode {
  return { kind: BoundExprKind.IS_NULL, expr, negated, resultType: DataType.BOOLEAN };
}

export function BoundSubquery(plan: unknown, subqueryType: string): BoundSubqueryNode {
  return { kind: BoundExprKind.SUBQUERY, plan, subqueryType };
}

export function BoundExists(plan: unknown, negated: boolean): BoundExistsNode {
  return { kind: BoundExprKind.EXISTS, plan, negated, resultType: DataType.BOOLEAN };
}

export function BoundExtract(field: string, source: BoundExpr): BoundExtractNode {
  return { kind: BoundExprKind.EXTRACT, field, source, resultType: DataType.INT32 };
}

export function BoundInterval(value: unknown, unit: string): BoundIntervalNode {
  return { kind: BoundExprKind.INTERVAL, value, unit, resultType: DataType.INT32 };
}

export function BoundWindow(name: string, args: BoundExpr[], partitionBy: BoundExpr[], orderBy: BoundWindowOrderKey[], resultType: string | null): BoundWindowNode {
  return { kind: BoundExprKind.WINDOW, name, args, partitionBy, orderBy, resultType };
}

export function getExprType(expr: { kind?: unknown; resultType?: string | null; dataType?: string | null } | null | undefined): string | null {
  if (!expr) return null;
  return expr.resultType || expr.dataType || null;
}

export function collectCorrelatedColumns(expr: BoundExpr): BoundColumnRefNode[] {
  const refs: BoundColumnRefNode[] = [];
  _walkExpr(expr, node => {
    if (node.kind === BoundExprKind.COLUMN_REF && node.isCorrelated) {
      refs.push(node);
    }
  });
  return refs;
}

function _walkExpr(expr: BoundExpr | null | undefined, fn: (node: BoundExpr) => void): void {
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
