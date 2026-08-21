import type { BoundColumnRefNode, BoundExpr } from '../binder/expression-binder.js';
import { exprKey } from '../binder/expr-key.js';
import type { ColumnMapping } from './execution-types.js';

export const UNRESOLVED_COLUMN = -1;

export class UnresolvedReferenceError extends Error {
  constructor(description: string, columnMapping: ColumnMapping | null) {
    const known = columnMapping ? [...columnMapping.keys()].join(', ') : '';
    super(`Unresolved reference ${description}: not present in the column mapping [${known}]`);
    this.name = 'UnresolvedReferenceError';
  }
}

export function describeColumnRef(expr: BoundColumnRefNode): string {
  return expr.tableAlias ? `${expr.tableAlias}.${expr.columnName}` : expr.columnName;
}

export function lookupColumnIndex(expr: BoundColumnRefNode, columnMapping: ColumnMapping | null): number | null {
  if (!columnMapping) return expr.columnIndex >= 0 ? expr.columnIndex : null;
  const qualified = `${expr.tableAlias}.${expr.columnName}`.toUpperCase();
  const qualifiedIndex = columnMapping.get(qualified);
  if (qualifiedIndex !== undefined) return qualifiedIndex;
  const unqualifiedIndex = columnMapping.get(expr.columnName.toUpperCase());
  return unqualifiedIndex === undefined ? null : unqualifiedIndex;
}

export function resolveColumnIndex(expr: BoundColumnRefNode, columnMapping: ColumnMapping | null): number {
  const index = lookupColumnIndex(expr, columnMapping);
  if (index === null) throw new UnresolvedReferenceError(`column ${describeColumnRef(expr)}`, columnMapping);
  return index;
}

export function optionalColumnIndex(expr: BoundColumnRefNode, columnMapping: ColumnMapping | null): number {
  return lookupColumnIndex(expr, columnMapping) ?? UNRESOLVED_COLUMN;
}

export function resolveMaterializedIndex(expr: BoundExpr, columnMapping: ColumnMapping | null, description: string): number {
  const index = columnMapping?.get(exprKey(expr));
  if (index === undefined) throw new UnresolvedReferenceError(description, columnMapping);
  return index;
}
