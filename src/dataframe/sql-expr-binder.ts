import { parseExpression } from '../parser/parser.js';
import { Binder } from '../binder/binder.js';
import type { CatalogLike } from '../binder/binder.js';
import { BinderScope } from '../binder/scope.js';
import type { ColumnInfo } from '../binder/scope.js';
import { BoundExprKind, getExprType } from '../binder/expression-binder.js';
import type { BoundExpr } from '../binder/expression-binder.js';

interface SchemaFieldLike {
  name: string;
  dataType: string | null;
  tableAlias?: string | null;
}

interface SchemaLike {
  fields: SchemaFieldLike[];
}

interface ScalarBindResult {
  expr: BoundExpr;
  dataType: string | null;
  outputName: string | null;
}

function groupByAlias(schema: SchemaLike): Map<string, ColumnInfo[]> {
  const groups = new Map<string, ColumnInfo[]>();
  for (const field of schema.fields) {
    const key = field.tableAlias || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ name: field.name, dataType: field.dataType });
  }
  return groups;
}

function deriveOutputName(expr: BoundExpr | null): string | null {
  if (!expr) return null;
  if (expr.kind === BoundExprKind.COLUMN_REF) return expr.columnName;
  if (expr.kind === BoundExprKind.AGGREGATE) return expr.name.toLowerCase();
  if (expr.kind === BoundExprKind.FUNCTION) return expr.name.toLowerCase();
  return null;
}

export function bindScalarSql(sqlString: string, schema: SchemaLike, catalog: CatalogLike, functionRegistry: object): ScalarBindResult {
  const ast = parseExpression(sqlString);
  const scope = new BinderScope();
  for (const [alias, columns] of groupByAlias(schema)) {
    scope.addTable(alias, { originalName: alias, columns });
  }
  const binder = new Binder(catalog, functionRegistry);
  const expr = binder.bindExpression(ast, scope);
  return { expr, dataType: getExprType(expr), outputName: deriveOutputName(expr) };
}
