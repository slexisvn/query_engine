import { NodeKind } from '../parser/ast.js';
import { DataType } from '../storage/data-type.js';
import type { BoundQuery } from './binder.js';

export type LiteralValue = string | number | boolean | bigint | null;

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
  dataType: DataType | null;
  depth: number;
  isCorrelated: boolean;
}

export interface BoundLiteralNode { kind: BoundExprKind.LITERAL; value: LiteralValue; dataType: DataType | null; }

export interface BoundBinaryNode { kind: BoundExprKind.BINARY; op: string; left: BoundExpr; right: BoundExpr; resultType: DataType; }

export interface BoundUnaryNode { kind: BoundExprKind.UNARY; op: string; operand: BoundExpr; resultType: DataType | null; }

export interface BoundFunctionNode { kind: BoundExprKind.FUNCTION; name: string; args: BoundExpr[]; resultType: DataType | null; }

export interface BoundAggregateNode { kind: BoundExprKind.AGGREGATE; name: string; args: BoundExpr[]; distinct: boolean; resultType: DataType; }

export interface BoundCaseNode {
  kind: BoundExprKind.CASE;
  operand: BoundExpr | null;
  whenClauses: BoundWhenClause[];
  elseExpr: BoundExpr | null;
  resultType: DataType;
}

export interface BoundCastNode { kind: BoundExprKind.CAST; expr: BoundExpr; targetType: DataType; dataType: DataType; }

export interface BoundBetweenNode { kind: BoundExprKind.BETWEEN; expr: BoundExpr; low: BoundExpr; high: BoundExpr; negated: boolean; resultType: DataType; }

export interface BoundInListNode { kind: BoundExprKind.IN_LIST; expr: BoundExpr; list: BoundExpr | BoundExpr[]; negated: boolean; resultType: DataType; }

export interface BoundLikeNode { kind: BoundExprKind.LIKE; expr: BoundExpr; pattern: BoundExpr; negated: boolean; resultType: DataType; }

export interface BoundIsNullNode { kind: BoundExprKind.IS_NULL; expr: BoundExpr; negated: boolean; resultType: DataType; }

export interface BoundSubqueryNode { kind: BoundExprKind.SUBQUERY; plan: BoundQuery; subqueryType: string; }

export interface BoundExistsNode { kind: BoundExprKind.EXISTS; plan: BoundQuery; negated: boolean; resultType: DataType; }

export interface BoundExtractNode { kind: BoundExprKind.EXTRACT; field: string; source: BoundExpr; resultType: DataType; }

export interface BoundIntervalNode { kind: BoundExprKind.INTERVAL; value: number; unit: string; resultType: DataType; }

export interface BoundWindowNode {
  kind: BoundExprKind.WINDOW;
  name: string;
  args: BoundExpr[];
  partitionBy: BoundExpr[];
  orderBy: BoundWindowOrderKey[];
  resultType: DataType | null;
}

export function BoundColumnRef(tableAlias: string, columnName: string, columnIndex: number, dataType: DataType | null, depth: number = 0): BoundColumnRefNode {
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

export function BoundLiteral(value: LiteralValue, dataType: DataType | null): BoundLiteralNode {
  return { kind: BoundExprKind.LITERAL, value, dataType };
}

export function BoundBinary(op: string, left: BoundExpr, right: BoundExpr, resultType: DataType): BoundBinaryNode {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType };
}

export function BoundUnary(op: string, operand: BoundExpr, resultType: DataType | null): BoundUnaryNode {
  return { kind: BoundExprKind.UNARY, op, operand, resultType };
}

export function BoundFunction(name: string, args: BoundExpr[], resultType: DataType | null): BoundFunctionNode {
  return { kind: BoundExprKind.FUNCTION, name, args, resultType };
}

export function BoundAggregate(name: string, args: BoundExpr[], distinct: boolean, resultType: DataType): BoundAggregateNode {
  return { kind: BoundExprKind.AGGREGATE, name, args, distinct, resultType };
}

export function BoundCase(operand: BoundExpr | null, whenClauses: BoundWhenClause[], elseExpr: BoundExpr | null, resultType: DataType): BoundCaseNode {
  return { kind: BoundExprKind.CASE, operand, whenClauses, elseExpr, resultType };
}

export function BoundCast(expr: BoundExpr, targetType: DataType): BoundCastNode {
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

export function BoundSubquery(plan: BoundQuery, subqueryType: string): BoundSubqueryNode {
  return { kind: BoundExprKind.SUBQUERY, plan, subqueryType };
}

export function BoundExists(plan: BoundQuery, negated: boolean): BoundExistsNode {
  return { kind: BoundExprKind.EXISTS, plan, negated, resultType: DataType.BOOLEAN };
}

export function BoundExtract(field: string, source: BoundExpr): BoundExtractNode {
  return { kind: BoundExprKind.EXTRACT, field, source, resultType: DataType.INT32 };
}

export function BoundInterval(value: number, unit: string): BoundIntervalNode {
  return { kind: BoundExprKind.INTERVAL, value, unit, resultType: DataType.INT32 };
}

export function BoundWindow(name: string, args: BoundExpr[], partitionBy: BoundExpr[], orderBy: BoundWindowOrderKey[], resultType: DataType | null): BoundWindowNode {
  return { kind: BoundExprKind.WINDOW, name, args, partitionBy, orderBy, resultType };
}

export function getExprType(expr?: BoundExpr | null): DataType | null {
  if (!expr) return null;
  if ('resultType' in expr && expr.resultType) return expr.resultType;
  if ('dataType' in expr && expr.dataType) return expr.dataType;
  return null;
}

export function collectCorrelatedColumns(expr: BoundExpr): BoundColumnRefNode[] {
  const refs: BoundColumnRefNode[] = [];
  walkExpr(expr, node => {
    if (node.kind === BoundExprKind.COLUMN_REF && node.isCorrelated) {
      refs.push(node);
    }
  });
  return refs;
}

export function walkExpr(expr: BoundExpr | null | undefined, fn: (node: BoundExpr) => void): void {
  if (!expr) return;
  fn(expr);
  switch (expr.kind) {
    case BoundExprKind.BINARY:
      walkExpr(expr.left, fn);
      walkExpr(expr.right, fn);
      break;
    case BoundExprKind.UNARY:
      walkExpr(expr.operand, fn);
      break;
    case BoundExprKind.FUNCTION:
    case BoundExprKind.AGGREGATE:
      for (const arg of expr.args) walkExpr(arg, fn);
      break;
    case BoundExprKind.CASE:
      if (expr.operand) walkExpr(expr.operand, fn);
      for (const wc of expr.whenClauses) {
        walkExpr(wc.condition, fn);
        walkExpr(wc.result, fn);
      }
      if (expr.elseExpr) walkExpr(expr.elseExpr, fn);
      break;
    case BoundExprKind.CAST:
      walkExpr(expr.expr, fn);
      break;
    case BoundExprKind.BETWEEN:
      walkExpr(expr.expr, fn);
      walkExpr(expr.low, fn);
      walkExpr(expr.high, fn);
      break;
    case BoundExprKind.IN_LIST:
      walkExpr(expr.expr, fn);
      if (Array.isArray(expr.list)) {
        for (const item of expr.list) walkExpr(item, fn);
      }
      break;
    case BoundExprKind.LIKE:
      walkExpr(expr.expr, fn);
      walkExpr(expr.pattern, fn);
      break;
    case BoundExprKind.IS_NULL:
      walkExpr(expr.expr, fn);
      break;
    case BoundExprKind.EXTRACT:
      walkExpr(expr.source, fn);
      break;
    case BoundExprKind.WINDOW:
      for (const arg of expr.args) walkExpr(arg, fn);
      for (const p of expr.partitionBy) walkExpr(p, fn);
      for (const o of expr.orderBy) walkExpr(o.expr, fn);
      break;
    case BoundExprKind.COLUMN_REF:
    case BoundExprKind.LITERAL:
    case BoundExprKind.INTERVAL:
    case BoundExprKind.SUBQUERY:
    case BoundExprKind.EXISTS:
      break;
    default:
      assertAllKindsWalked(expr);
  }
}

function assertAllKindsWalked(expr: never): never {
  throw new Error(`walkExpr has no case for expression kind: ${(expr as BoundExpr).kind}`);
}
