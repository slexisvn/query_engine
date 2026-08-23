import { BoundExprKind, getExprType, type BoundExpr } from '../binder/expression-binder.js';
import { PlanNodeType, type LogicalOrderKey, type LogicalPlanNode, type LogicalSortNode, type SortedByEntry } from './logical-plan.js';
import { splitConjuncts } from '../binder/conjuncts.js';
import type { DataType } from '../storage/data-type.js';

export interface EquiJoinKeys {
  leftKeys: string[];
  rightKeys: string[];
}

export function columnKeyOf(expr: BoundExpr | null): string | null {
  if (!expr) return null;
  if (expr.kind !== BoundExprKind.COLUMN_REF) return null;
  return `${expr.tableAlias || ''}.${expr.columnName}`.toUpperCase();
}

export function extractEquiJoinKeys(condition: BoundExpr | null): EquiJoinKeys {
  const leftKeys: string[] = [];
  const rightKeys: string[] = [];

  for (const pred of splitConjuncts(condition)) {
    if (pred.kind !== BoundExprKind.BINARY || pred.op !== '=') continue;
    const left = columnKeyOf(pred.left);
    const right = columnKeyOf(pred.right);
    if (left === null || right === null) continue;
    leftKeys.push(left);
    rightKeys.push(right);
  }

  return { leftKeys, rightKeys };
}

export function equiJoinKeyTypes(condition: BoundExpr | null): (DataType | null)[] {
  const types: (DataType | null)[] = [];

  for (const pred of splitConjuncts(condition)) {
    if (pred.kind !== BoundExprKind.BINARY || pred.op !== '=') continue;
    if (columnKeyOf(pred.left) === null || columnKeyOf(pred.right) === null) continue;
    types.push(getExprType(pred.left) ?? getExprType(pred.right) ?? null);
  }

  return types;
}

export function orderKeyTypes(orderKeys: readonly LogicalOrderKey[] | undefined): (DataType | null)[] {
  if (!orderKeys) return [];
  return orderKeys.map(key => getExprType(key.expr) ?? null);
}

export function isPureEquiJoin(condition: BoundExpr | null): boolean {
  const preds = splitConjuncts(condition);
  return preds.length > 0 && preds.every(pred =>
    pred.kind === BoundExprKind.BINARY
      && pred.op === '='
      && columnKeyOf(pred.left) !== null
      && columnKeyOf(pred.right) !== null
  );
}

function keyText(entry?: SortedByEntry | null): string | null {
  if (!entry) return null;
  return typeof entry === 'object' ? entry.key : entry;
}

function keyParts(key: string): { alias: string; column: string } {
  const dot = key.lastIndexOf('.');
  if (dot < 0) return { alias: '', column: key };
  return { alias: key.slice(0, dot), column: key.slice(dot + 1) };
}

export function sortKeyMatches(sortedKey?: SortedByEntry | null, requiredKey?: SortedByEntry | null): boolean {
  const sorted = keyText(sortedKey);
  const required = keyText(requiredKey);
  if (!sorted || !required) return false;
  if (sorted === required) return true;

  const sortedParts = keyParts(sorted);
  const requiredParts = keyParts(required);
  if (sortedParts.column !== requiredParts.column) return false;
  return sortedParts.alias === '' || requiredParts.alias === '';
}

export function sortDirectionOf(entry?: SortedByEntry | null): string {
  if (!entry) return 'ASC';
  return (typeof entry === 'object' ? entry.direction || 'ASC' : 'ASC').toUpperCase();
}

export function isSortedBy(actualKeys: SortedByEntry[] | undefined, requiredKeys: (SortedByEntry | null)[]): boolean {
  if (!actualKeys || actualKeys.length === 0) return false;
  if (requiredKeys.length === 0) return false;

  for (let i = 0; i < requiredKeys.length; i++) {
    if (!sortKeyMatches(actualKeys[i], requiredKeys[i])) return false;
  }
  return true;
}

export function selectsRows(node: LogicalSortNode): boolean {
  return node.limit !== undefined || !!node.offset;
}

export function satisfiesOrder(provided: SortedByEntry[] | undefined, required: readonly LogicalOrderKey[]): boolean {
  if (!provided || required.length === 0) return false;
  if (provided.length < required.length) return false;

  for (let i = 0; i < required.length; i++) {
    const key = columnKeyOf(required[i].expr);
    if (key === null) return false;
    if (!sortKeyMatches(provided[i], key)) return false;
    if (sortDirectionOf(provided[i]) !== (required[i].direction || 'ASC').toUpperCase()) return false;
  }

  return true;
}

export function isSortedByPrefix(actualKeys: SortedByEntry[] | undefined, requiredKeys: (SortedByEntry | null)[]): boolean {
  if (!actualKeys || actualKeys.length < requiredKeys.length) return false;
  if (requiredKeys.length === 0) return false;

  const prefix = actualKeys.slice(0, requiredKeys.length);
  return requiredKeys.every(required => prefix.some(actual => sortKeyMatches(actual, required)));
}

export function inferSortOrder(node: LogicalPlanNode): SortedByEntry[] {
  if (node.type === PlanNodeType.SORT || node.type === PlanNodeType.TOP_N) {
    return node.orderKeys
      .map(key => ({ key: columnKeyOf(key.expr), direction: (key.direction || 'ASC').toUpperCase() }))
      .filter((entry): entry is { key: string; direction: string } => !!entry.key);
  }

  if (node.type === PlanNodeType.INDEX_SCAN) {
    return [`${(node.alias || node.table || '').toUpperCase()}.${(node.columnName || '').toUpperCase()}`];
  }

  if (node.type === PlanNodeType.FILTER || node.type === PlanNodeType.PROJECT || node.type === PlanNodeType.LIMIT) {
    return node.children?.[0]?._sortedBy ?? [];
  }

  return [];
}
