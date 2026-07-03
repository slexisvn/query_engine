import type { BoundColumnRefNode } from '../binder/expression-binder.js';
import type { ColumnMapping } from './execution-types.js';

interface ResolveColumnIndexOpts {
  clampNegative?: boolean;
}

export function resolveColumnIndex(expr: BoundColumnRefNode, columnMapping: ColumnMapping | null, opts?: ResolveColumnIndexOpts): number {
  if (columnMapping) {
    const key = `${expr.tableAlias}.${expr.columnName}`.toUpperCase();
    if (columnMapping.has(key)) return columnMapping.get(key)!;
    const byName = `${expr.columnName}`.toUpperCase();
    if (columnMapping.has(byName)) return columnMapping.get(byName)!;
  }
  if (opts?.clampNegative) return expr.columnIndex >= 0 ? expr.columnIndex : -1;
  return expr.columnIndex;
}
