
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
  QUANTIFIED = 'BoundQuantified',
}

export type BoundExpr =
  | BoundColumnRefNode | BoundLiteralNode | BoundBinaryNode | BoundUnaryNode
  | BoundFunctionNode | BoundAggregateNode | BoundCaseNode | BoundCastNode
  | BoundBetweenNode | BoundInListNode | BoundLikeNode | BoundIsNullNode
  | BoundSubqueryNode | BoundExistsNode | BoundExtractNode | BoundIntervalNode
  | BoundWindowNode | BoundQuantifiedNode;

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

export type Quantifier = 'ANY' | 'ALL';

export interface BoundQuantifiedNode {
  kind: BoundExprKind.QUANTIFIED;
  op: string;
  quantifier: Quantifier;
  expr: BoundExpr;
  plan: BoundQuery;
  resultType: DataType;
}

export interface BoundIntervalNode { kind: BoundExprKind.INTERVAL; value: number; unit: string; resultType: DataType; }

export type FrameMode = 'ROWS' | 'RANGE';

export type FrameBoundType = 'UNBOUNDED_PRECEDING' | 'PRECEDING' | 'CURRENT_ROW' | 'FOLLOWING' | 'UNBOUNDED_FOLLOWING';

export interface BoundFrameBound { type: FrameBoundType; offset: number | null; }

export interface BoundWindowFrame { mode: FrameMode; start: BoundFrameBound; end: BoundFrameBound; }

export interface BoundWindowNode {
  kind: BoundExprKind.WINDOW;
  name: string;
  args: BoundExpr[];
  partitionBy: BoundExpr[];
  orderBy: BoundWindowOrderKey[];
  frame: BoundWindowFrame | null;
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

export function BoundCase(whenClauses: BoundWhenClause[], elseExpr: BoundExpr | null, resultType: DataType): BoundCaseNode {
  return { kind: BoundExprKind.CASE, whenClauses, elseExpr, resultType };
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

export function BoundQuantified(op: string, quantifier: Quantifier, expr: BoundExpr, plan: BoundQuery): BoundQuantifiedNode {
  return { kind: BoundExprKind.QUANTIFIED, op, quantifier, expr, plan, resultType: DataType.BOOLEAN };
}

export function BoundExtract(field: string, source: BoundExpr): BoundExtractNode {
  return { kind: BoundExprKind.EXTRACT, field, source, resultType: DataType.INT32 };
}

export function BoundInterval(value: number, unit: string): BoundIntervalNode {
  return { kind: BoundExprKind.INTERVAL, value, unit, resultType: DataType.INT32 };
}

export function BoundWindow(name: string, args: BoundExpr[], partitionBy: BoundExpr[], orderBy: BoundWindowOrderKey[], frame: BoundWindowFrame | null, resultType: DataType | null): BoundWindowNode {
  return { kind: BoundExprKind.WINDOW, name, args, partitionBy, orderBy, frame, resultType };
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

export function walkExpr(expr: BoundExpr | null | undefined, fn: (node: BoundExpr) => boolean | void): void {
  if (!expr) return;
  if (fn(expr) === false) return;
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
    case BoundExprKind.QUANTIFIED:
      walkExpr(expr.expr, fn);
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

type ExprMapper = (node: BoundExpr) => BoundExpr | null;

function mapAll(exprs: readonly BoundExpr[], fn: ExprMapper): BoundExpr[] | null {
  let changed = false;
  const mapped = exprs.map((item) => {
    const next = mapExpr(item, fn);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? mapped : null;
}

function mapOrderKeys(keys: readonly BoundWindowOrderKey[], fn: ExprMapper): BoundWindowOrderKey[] | null {
  let changed = false;
  const mapped = keys.map((key) => {
    const next = mapExpr(key.expr, fn);
    if (next === key.expr) return key;
    changed = true;
    return { ...key, expr: next };
  });
  return changed ? mapped : null;
}

function mapWhenClauses(clauses: readonly BoundWhenClause[], fn: ExprMapper): BoundWhenClause[] | null {
  let changed = false;
  const mapped = clauses.map((clause) => {
    const condition = mapExpr(clause.condition, fn);
    const result = mapExpr(clause.result, fn);
    if (condition === clause.condition && result === clause.result) return clause;
    changed = true;
    return { condition, result };
  });
  return changed ? mapped : null;
}

function rebuild(expr: BoundExpr, fn: ExprMapper): BoundExpr {
  switch (expr.kind) {
    case BoundExprKind.BINARY: {
      const left = mapExpr(expr.left, fn);
      const right = mapExpr(expr.right, fn);
      return left === expr.left && right === expr.right ? expr : { ...expr, left, right };
    }
    case BoundExprKind.UNARY: {
      const operand = mapExpr(expr.operand, fn);
      return operand === expr.operand ? expr : { ...expr, operand };
    }
    case BoundExprKind.FUNCTION:
    case BoundExprKind.AGGREGATE: {
      const args = mapAll(expr.args, fn);
      return args ? { ...expr, args } : expr;
    }
    case BoundExprKind.CASE: {
      const whenClauses = mapWhenClauses(expr.whenClauses, fn);
      const elseExpr = expr.elseExpr ? mapExpr(expr.elseExpr, fn) : null;
      if (!whenClauses && elseExpr === expr.elseExpr) return expr;
      return { ...expr, whenClauses: whenClauses ?? expr.whenClauses, elseExpr };
    }
    case BoundExprKind.CAST: {
      const inner = mapExpr(expr.expr, fn);
      return inner === expr.expr ? expr : { ...expr, expr: inner };
    }
    case BoundExprKind.BETWEEN: {
      const inner = mapExpr(expr.expr, fn);
      const low = mapExpr(expr.low, fn);
      const high = mapExpr(expr.high, fn);
      if (inner === expr.expr && low === expr.low && high === expr.high) return expr;
      return { ...expr, expr: inner, low, high };
    }
    case BoundExprKind.IN_LIST: {
      const inner = mapExpr(expr.expr, fn);
      const list = Array.isArray(expr.list) ? mapAll(expr.list, fn) : mapExpr(expr.list, fn);
      const listChanged = Array.isArray(expr.list) ? list !== null : list !== expr.list;
      if (inner === expr.expr && !listChanged) return expr;
      return { ...expr, expr: inner, list: (list ?? expr.list) as BoundExpr | BoundExpr[] };
    }
    case BoundExprKind.LIKE: {
      const inner = mapExpr(expr.expr, fn);
      const pattern = mapExpr(expr.pattern, fn);
      if (inner === expr.expr && pattern === expr.pattern) return expr;
      return { ...expr, expr: inner, pattern };
    }
    case BoundExprKind.IS_NULL: {
      const inner = mapExpr(expr.expr, fn);
      return inner === expr.expr ? expr : { ...expr, expr: inner };
    }
    case BoundExprKind.EXTRACT: {
      const source = mapExpr(expr.source, fn);
      return source === expr.source ? expr : { ...expr, source };
    }
    case BoundExprKind.WINDOW: {
      const args = mapAll(expr.args, fn);
      const partitionBy = mapAll(expr.partitionBy, fn);
      const orderBy = mapOrderKeys(expr.orderBy, fn);
      if (!args && !partitionBy && !orderBy) return expr;
      return {
        ...expr,
        args: args ?? expr.args,
        partitionBy: partitionBy ?? expr.partitionBy,
        orderBy: orderBy ?? expr.orderBy,
      };
    }
    case BoundExprKind.QUANTIFIED: {
      const inner = mapExpr(expr.expr, fn);
      return inner === expr.expr ? expr : { ...expr, expr: inner };
    }
    case BoundExprKind.COLUMN_REF:
    case BoundExprKind.LITERAL:
    case BoundExprKind.INTERVAL:
    case BoundExprKind.SUBQUERY:
    case BoundExprKind.EXISTS:
      return expr;
    default:
      return assertAllKindsMapped(expr);
  }
}

export function mapExpr(expr: BoundExpr, fn: ExprMapper): BoundExpr {
  return fn(expr) ?? rebuild(expr, fn);
}

function assertAllKindsMapped(expr: never): never {
  throw new Error(`mapExpr has no case for expression kind: ${(expr as BoundExpr).kind}`);
}

function assertAllKindsWalked(expr: never): never {
  throw new Error(`walkExpr has no case for expression kind: ${(expr as BoundExpr).kind}`);
}
