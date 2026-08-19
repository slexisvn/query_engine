import { PlanNodeType, type LogicalPlanNode, type ProjectedExpr } from '../planner/logical-plan.js';
import { BoundExprKind, type BoundExpr, type BoundColumnRefNode } from '../binder/expression-binder.js';

export interface UniqueKeyTable { primaryKey: string[]; }

export interface UniqueKeyCatalog { getTable(name: string): UniqueKeyTable | null; }

export type ColumnKeySet = ReadonlySet<string>;

export function columnKey(tableAlias: string | null | undefined, columnName: string): string {
  return `${(tableAlias || '').toUpperCase()}.${columnName.toUpperCase()}`;
}

function outputNameOf(expr: ProjectedExpr): string {
  const named = expr as { outputName?: string; columnName?: string; name?: string };
  return (named.outputName || named.columnName || named.name || '').toUpperCase();
}

function translateThroughProject(node: LogicalPlanNode & { type: PlanNodeType.PROJECT }, keys: ColumnKeySet): Set<string> | null {
  const alias = (node.outputAlias || '').toUpperCase();
  const translated = new Set<string>();

  for (const key of keys) {
    const dot = key.indexOf('.');
    const keyAlias = key.slice(0, dot);
    const keyName = key.slice(dot + 1);
    if (alias && keyAlias !== alias) return null;

    const source = node.expressions.find((expr) => outputNameOf(expr) === keyName);
    if (!source || source.kind !== BoundExprKind.COLUMN_REF) return null;
    translated.add(columnKey(source.tableAlias, source.columnName));
  }

  return translated;
}

function projectOutputKeys(node: LogicalPlanNode): Set<string> | null {
  if (node.type !== PlanNodeType.PROJECT) return null;
  const alias = (node.outputAlias || '').toUpperCase();
  const keys = new Set<string>();
  for (const expr of node.expressions) {
    const name = outputNameOf(expr);
    if (!name) return null;
    const owner = alias || (expr.kind === BoundExprKind.COLUMN_REF ? expr.tableAlias : '');
    keys.add(columnKey(owner, name));
  }
  return keys;
}

const PASS_THROUGH_TYPES: ReadonlySet<PlanNodeType> = new Set([
  PlanNodeType.FILTER,
  PlanNodeType.SORT,
  PlanNodeType.TOP_N,
  PlanNodeType.LIMIT,
  PlanNodeType.MATERIALIZE,
]);

export function isUniqueOnKeys(node: LogicalPlanNode, keys: ColumnKeySet, catalog: UniqueKeyCatalog | null): boolean {
  if (keys.size === 0) return false;

  if (node.type === PlanNodeType.SCAN) {
    const primaryKey = catalog?.getTable(node.table)?.primaryKey ?? [];
    if (primaryKey.length === 0) return false;
    return primaryKey.every((column) => keys.has(columnKey(node.alias, column)));
  }

  if (node.type === PlanNodeType.AGGREGATE) {
    if (node.groupBy.length === 0) return true;
    return node.groupBy.every((expr: BoundExpr) =>
      expr.kind === BoundExprKind.COLUMN_REF
      && keys.has(columnKey((expr as BoundColumnRefNode).tableAlias, (expr as BoundColumnRefNode).columnName)));
  }

  if (node.type === PlanNodeType.DISTINCT) {
    const outputs = projectOutputKeys(node.children[0]);
    if (!outputs) return false;
    for (const output of outputs) {
      if (!keys.has(output)) return false;
    }
    return true;
  }

  if (node.type === PlanNodeType.PROJECT) {
    const translated = translateThroughProject(node, keys);
    return translated !== null && isUniqueOnKeys(node.children[0], translated, catalog);
  }

  if (PASS_THROUGH_TYPES.has(node.type) && node.children?.[0]) {
    return isUniqueOnKeys(node.children[0], keys, catalog);
  }

  return false;
}
