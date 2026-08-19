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

function hasColumn(mapping: ColumnMapping, colRef: BoundColumnRefNode): boolean {
  const fullKey = `${colRef.tableAlias || ''}.${colRef.columnName}`.toUpperCase();
  if (mapping.has(fullKey)) return true;
  const shortKey = colRef.columnName.toUpperCase();
  return mapping.has(shortKey);
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
      if (hasColumn(leftMapping, expr.left) && hasColumn(rightMapping, expr.right)) {
        return { buildKey: expr.left, probeKey: expr.right };
      } else if (hasColumn(leftMapping, expr.right) && hasColumn(rightMapping, expr.left)) {
        return { buildKey: expr.right, probeKey: expr.left };
      }
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
    let isEquiJoin = false;
    if (pred.kind === BoundExprKind.BINARY && pred.op === '='
        && pred.left?.kind === BoundExprKind.COLUMN_REF
        && pred.right?.kind === BoundExprKind.COLUMN_REF) {

      if (hasColumn(leftMapping, pred.left) && hasColumn(rightMapping, pred.right)) {
        buildKeys.push(pred.left);
        probeKeys.push(pred.right);
        isEquiJoin = true;
      } else if (hasColumn(leftMapping, pred.right) && hasColumn(rightMapping, pred.left)) {
        buildKeys.push(pred.right);
        probeKeys.push(pred.left);
        isEquiJoin = true;
      }
    }
    if (!isEquiJoin) {
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
