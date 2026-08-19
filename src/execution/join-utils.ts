import { BoundExprKind } from '../binder/expression-binder.js';
import type { BoundExpr, BoundColumnRefNode } from '../binder/expression-binder.js';
import type { ColumnMapping } from './execution-types.js';
import { DataType } from '../storage/data-type.js';

export interface JoinKeyPair {
  buildKey: BoundColumnRefNode;
  probeKey: BoundColumnRefNode;
}

export interface ExtractedJoinKeys {
  buildKeys: BoundExpr[];
  probeKeys: BoundExpr[];
  residualCondition: BoundExpr | null;
}

export function splitAnd(expr: BoundExpr | null): BoundExpr[] {
  if (!expr) return [];
  if (expr.kind === BoundExprKind.BINARY && expr.op === 'AND') {
    return [...splitAnd(expr.left), ...splitAnd(expr.right)];
  }
  return [expr];
}

function hasQualifiedColumn(mapping: ColumnMapping, colRef: BoundColumnRefNode): boolean {
  return mapping.has(`${colRef.tableAlias || ''}.${colRef.columnName}`.toUpperCase());
}

function hasColumn(mapping: ColumnMapping, colRef: BoundColumnRefNode): boolean {
  if (hasQualifiedColumn(mapping, colRef)) return true;
  return mapping.has(colRef.columnName.toUpperCase());
}

function splitSides(
  left: BoundColumnRefNode,
  right: BoundColumnRefNode,
  leftMapping: ColumnMapping,
  rightMapping: ColumnMapping,
): JoinKeyPair | null {
  const qualified = orientedPair(left, right, leftMapping, rightMapping, hasQualifiedColumn);
  if (qualified) return qualified;
  return orientedPair(left, right, leftMapping, rightMapping, hasColumn);
}

function orientedPair(
  left: BoundColumnRefNode,
  right: BoundColumnRefNode,
  leftMapping: ColumnMapping,
  rightMapping: ColumnMapping,
  has: (mapping: ColumnMapping, colRef: BoundColumnRefNode) => boolean,
): JoinKeyPair | null {
  if (has(leftMapping, left) && has(rightMapping, right)) return { buildKey: left, probeKey: right };
  if (has(leftMapping, right) && has(rightMapping, left)) return { buildKey: right, probeKey: left };
  return null;
}

export function findCommonEquiJoinKeys(expr: BoundExpr | null, leftMapping: ColumnMapping, rightMapping: ColumnMapping): JoinKeyPair | null {
  if (!expr) return null;

    if (expr.kind === BoundExprKind.BINARY && expr.op === 'OR') {
    const leftKeys = findCommonEquiJoinKeys(expr.left, leftMapping, rightMapping);
    const rightKeys = findCommonEquiJoinKeys(expr.right, leftMapping, rightMapping);

        if (!leftKeys || !rightKeys) return null;

        if (leftKeys.buildKey.tableAlias === rightKeys.buildKey.tableAlias &&
        leftKeys.buildKey.columnName === rightKeys.buildKey.columnName &&
        leftKeys.probeKey.tableAlias === rightKeys.probeKey.tableAlias &&
        leftKeys.probeKey.columnName === rightKeys.probeKey.columnName) {
      return leftKeys;
    }
    return null;
  }

    if (expr.kind === BoundExprKind.BINARY && expr.op === 'AND') {
    const leftKeys = findCommonEquiJoinKeys(expr.left, leftMapping, rightMapping);
    if (leftKeys) return leftKeys;
    return findCommonEquiJoinKeys(expr.right, leftMapping, rightMapping);
  }

    if (expr.kind === BoundExprKind.BINARY && expr.op === '=') {
    if (expr.left?.kind === BoundExprKind.COLUMN_REF && expr.right?.kind === BoundExprKind.COLUMN_REF) {
      return splitSides(expr.left, expr.right, leftMapping, rightMapping);
    }
  }

    return null;
}

export function extractJoinKeys(condition: BoundExpr | null, leftMapping: ColumnMapping, rightMapping: ColumnMapping): ExtractedJoinKeys {
  if (!condition) {
    return { buildKeys: [], probeKeys: [], residualCondition: null };
  }

  const buildKeys: BoundExpr[] = [];
  const probeKeys: BoundExpr[] = [];
  const residualPreds: BoundExpr[] = [];
  const preds = splitAnd(condition);

  for (const pred of preds) {
    const pair = pred.kind === BoundExprKind.BINARY && pred.op === '='
        && pred.left?.kind === BoundExprKind.COLUMN_REF
        && pred.right?.kind === BoundExprKind.COLUMN_REF
      ? splitSides(pred.left, pred.right, leftMapping, rightMapping)
      : null;

    if (pair) {
      buildKeys.push(pair.buildKey);
      probeKeys.push(pair.probeKey);
    } else {
      residualPreds.push(pred);
    }
  }

  if (buildKeys.length === 0) {
    const commonKeys = findCommonEquiJoinKeys(condition, leftMapping, rightMapping);
    if (commonKeys && commonKeys.buildKey) {
      buildKeys.push(commonKeys.buildKey);
      probeKeys.push(commonKeys.probeKey);
      residualPreds.length = 0;
      residualPreds.push(condition);
    } else {
      buildKeys.push({ kind: BoundExprKind.LITERAL, value: 1, dataType: null });
      probeKeys.push({ kind: BoundExprKind.LITERAL, value: 1, dataType: null });
    }
  }

  let residualCondition: BoundExpr | null = null;
  if (residualPreds.length > 0) {
    residualCondition = residualPreds.reduce((acc, p) => ({
      kind: BoundExprKind.BINARY,
      op: 'AND',
      left: acc,
      right: p,
      resultType: DataType.BOOLEAN,
    }));
  }

  return { buildKeys, probeKeys, residualCondition };
}
