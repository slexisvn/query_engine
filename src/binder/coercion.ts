import { BoundExprKind, BoundLiteral, getExprType, type BoundExpr, type BoundLiteralNode } from './expression-binder.js';
import { DataType, castToType, isNumeric, isTemporal, type ColumnValue } from '../storage/data-type.js';

export const COMPARISON_OPS: ReadonlySet<string> = new Set(['=', '<>', '!=', '<', '>', '<=', '>=']);

export const ARITHMETIC_OPS: ReadonlySet<string> = new Set(['+', '-', '*', '/', '%']);

function isLiteral(expr: BoundExpr): expr is BoundLiteralNode {
  return expr.kind === BoundExprKind.LITERAL;
}

function isTextLiteral(expr: BoundExpr): boolean {
  return isLiteral(expr) && expr.dataType === DataType.VARCHAR;
}

function carriesOwnTyping(expr: BoundExpr): boolean {
  return expr.kind === BoundExprKind.INTERVAL;
}

function foldLiteral(expr: BoundLiteralNode, target: DataType, op: string): BoundExpr {
  const value = expr.value as ColumnValue;
  const converted = castToType(value, target);
  if (converted === null && value !== null) {
    throw new Error(`Cannot interpret '${String(value)}' as ${target} in operator '${op}'`);
  }
  return BoundLiteral(converted as ColumnValue, target);
}

function compatible(op: string, left: DataType, right: DataType): boolean {
  if (left === right) return true;
  if (isNumeric(left) && isNumeric(right)) return true;
  if (isTemporal(left) && isTemporal(right)) return true;
  if (!ARITHMETIC_OPS.has(op)) return false;
  return (isTemporal(left) && isNumeric(right)) || (isNumeric(left) && isTemporal(right));
}

function prefersFold(candidate: BoundExpr, other: BoundExpr): candidate is BoundLiteralNode {
  if (!isLiteral(candidate)) return false;
  if (!isLiteral(other)) return true;
  return isTextLiteral(candidate) && !isTextLiteral(other);
}

export function coerceOperands(op: string, left: BoundExpr, right: BoundExpr): [BoundExpr, BoundExpr] {
  if (carriesOwnTyping(left) || carriesOwnTyping(right)) return [left, right];

  const leftType = getExprType(left);
  const rightType = getExprType(right);
  if (leftType === null || rightType === null) return [left, right];
  if (compatible(op, leftType, rightType)) return [left, right];

  if (prefersFold(left, right)) return [foldLiteral(left, rightType, op), right];
  if (prefersFold(right, left)) return [left, foldLiteral(right, leftType, op)];

  throw new Error(`Operator '${op}' is not defined for ${leftType} and ${rightType}: add an explicit CAST`);
}

export interface CoercedGroup {
  anchor: BoundExpr;
  operands: BoundExpr[];
}

export function coerceGroup(op: string, anchor: BoundExpr, operands: readonly BoundExpr[]): CoercedGroup {
  let current = anchor;
  for (const operand of operands) {
    current = coerceOperands(op, current, operand)[0];
  }
  return { anchor: current, operands: operands.map(operand => coerceOperands(op, current, operand)[1]) };
}
