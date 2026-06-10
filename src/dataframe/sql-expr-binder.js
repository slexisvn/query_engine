import { parseExpression } from '../parser/parser.js';
import { Binder } from '../binder/binder.js';
import { BinderScope } from '../binder/scope.js';
import { BoundExprKind, getExprType } from '../binder/expression-binder.js';

function groupByAlias(schema) {
  const groups = new Map();
  for (const field of schema.fields) {
    const key = field.tableAlias || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name: field.name, dataType: field.dataType });
  }
  return groups;
}

function deriveOutputName(expr) {
  if (!expr) return null;
  if (expr.kind === BoundExprKind.COLUMN_REF) return expr.columnName;
  if (expr.kind === BoundExprKind.AGGREGATE) return expr.name.toLowerCase();
  if (expr.kind === BoundExprKind.FUNCTION) return expr.name.toLowerCase();
  return null;
}

export function bindScalarSql(sqlString, schema, catalog, functionRegistry) {
  const ast = parseExpression(sqlString);
  const scope = new BinderScope();
  for (const [alias, columns] of groupByAlias(schema)) {
    scope.addTable(alias, { originalName: alias, columns });
  }
  const binder = new Binder(catalog, functionRegistry);
  const expr = binder.bindExpression(ast, scope);
  return { expr, dataType: getExprType(expr), outputName: deriveOutputName(expr) };
}
