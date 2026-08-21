import { BoundExprKind } from '../binder/expression-binder.js';
import type { ProjectedExpr } from './logical-plan.js';

interface NamedExpr {
  outputName?: string;
  alias?: string;
  name?: string;
  columnName?: string;
}

export function projectedColumnName(expr: ProjectedExpr, index: number): string {
  const named = expr as NamedExpr;
  return named?.outputName || named?.alias || named?.name || named?.columnName || `col${index}`;
}

export function projectedColumnAlias(expr: ProjectedExpr, name: string, outputAlias: string): string {
  if (outputAlias) return outputAlias;
  if (!expr || expr.kind !== BoundExprKind.COLUMN_REF) return '';
  if (expr.columnName.toUpperCase() !== name.toUpperCase()) return '';
  return expr.tableAlias || '';
}
