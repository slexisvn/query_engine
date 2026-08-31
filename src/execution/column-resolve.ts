import type { BoundColumnRefNode, BoundExpr } from '../binder/expression-binder.js';
import { exprKey } from '../binder/expr-key.js';
import type { ColumnMapping } from './execution-types.js';

export const UNRESOLVED_COLUMN = -1;
export const AMBIGUOUS_COLUMN = -2;

export class UnresolvedReferenceError extends Error {
  constructor(description: string, columnMapping: ColumnMapping | null) {
    const known = columnMapping ? [...columnMapping.keys()].join(', ') : '';
    super(`Unresolved reference ${description}: not present in the column mapping [${known}]`);
    this.name = 'UnresolvedReferenceError';
  }
}

export class AmbiguousReferenceError extends Error {
  constructor(description: string) {
    super(`Ambiguous reference ${description}: qualify it with a table alias`);
    this.name = 'AmbiguousReferenceError';
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
  if (index === AMBIGUOUS_COLUMN) throw new AmbiguousReferenceError(`column ${describeColumnRef(expr)}`);
  return index;
}

export function optionalColumnIndex(expr: BoundColumnRefNode, columnMapping: ColumnMapping | null): number {
  const index = lookupColumnIndex(expr, columnMapping);
  return index === null || index === AMBIGUOUS_COLUMN ? UNRESOLVED_COLUMN : index;
}

export function resolveMaterializedIndex(expr: BoundExpr, columnMapping: ColumnMapping | null, description: string): number {
  const index = columnMapping?.get(exprKey(expr));
  if (index === undefined) throw new UnresolvedReferenceError(description, columnMapping);
  return index;
}
