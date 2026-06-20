import { BoundExprKind } from '../../binder/expression-binder.js';
import type { BoundExpr, LiteralValue } from '../../binder/expression-binder.js';
import { StrategyType } from './partition-strategy.js';
import type { ColumnValue } from '../../storage/data-type.js';
import type { PartitionId, PartitionKeyRef, PrunedPartitionSet } from '../distributed-types.js';

interface PartitionStrategyLike {
  type: string;
  partitionFor(key: LiteralValue, partitionCount?: number): PartitionId;
  boundaries: ColumnValue[];
}

interface PartitionTableInfoLike {
  strategy: PartitionStrategyLike;
  partitionCount: number;
  partitionKey: string | null;
}

interface PartitionMapLike {
  getTableInfo(tableName: string): PartitionTableInfoLike | null;
}

export class PartitionPruner {
  prune(tableName: string, predicate: BoundExpr | null | undefined, partitionMap: PartitionMapLike): PrunedPartitionSet {
    const info = partitionMap.getTableInfo(tableName);
    if (!info) return this._allPartitions(0);

    const allIds = this._allPartitions(info.partitionCount);

    if (!predicate || !info.partitionKey) return allIds;

    const pruned = this._prunePredicate(predicate, info);
    return pruned || allIds;
  }

  _prunePredicate(expr: BoundExpr | null | undefined, info: PartitionTableInfoLike): PrunedPartitionSet | null {
    if (!expr) return null;

    if (expr.kind === BoundExprKind.BINARY && expr.op === 'AND') {
      const left = this._prunePredicate(expr.left, info);
      const right = this._prunePredicate(expr.right, info);
      if (left && right) return this._intersect(left, right);
      return left || right;
    }

    if (expr.kind === BoundExprKind.BINARY && expr.op === 'OR') {
      const left = this._prunePredicate(expr.left, info);
      const right = this._prunePredicate(expr.right, info);
      if (left && right) return this._union(left, right);
      return null;
    }

    if (expr.kind === BoundExprKind.BINARY && expr.op === '=') {
      return this._pruneEquality(expr, info);
    }

    if (expr.kind === BoundExprKind.BINARY && (expr.op === '<' || expr.op === '<=' || expr.op === '>' || expr.op === '>=')) {
      return this._pruneRange(expr, info);
    }

    if (expr.kind === BoundExprKind.BETWEEN) {
      return this._pruneBetween(expr, info);
    }

    if (expr.kind === BoundExprKind.IN_LIST) {
      return this._pruneInList(expr, info);
    }

    return null;
  }

  _pruneEquality(expr: BoundExpr, info: PartitionTableInfoLike): PrunedPartitionSet | null {
    const colRef = this._extractPartitionColumn(expr, info);
    if (!colRef) return null;

    const literal = colRef.side === 'left' ? (expr as { right: BoundExpr }).right : (expr as { left: BoundExpr }).left;
    if (literal.kind !== BoundExprKind.LITERAL) return null;

    if (info.strategy.type === StrategyType.HASH) {
      const pid = info.strategy.partitionFor(literal.value, info.partitionCount);
      return new Set([pid]);
    }

    if (info.strategy.type === StrategyType.RANGE) {
      const pid = info.strategy.partitionFor(literal.value);
      return new Set([pid]);
    }

    return null;
  }

  _pruneRange(expr: BoundExpr, info: PartitionTableInfoLike): PrunedPartitionSet | null {
    if (info.strategy.type !== StrategyType.RANGE) return null;

    const colRef = this._extractPartitionColumn(expr, info);
    if (!colRef) return null;

    const literal = colRef.side === 'left' ? (expr as { right: BoundExpr }).right : (expr as { left: BoundExpr }).left;
    if (literal.kind !== BoundExprKind.LITERAL) return null;

    const boundaries = info.strategy.boundaries;
    const partCount = boundaries.length + 1;
    const value = literal.value;
    const result: PrunedPartitionSet = new Set();

    const isColOnLeft = colRef.side === 'left';
    const op = isColOnLeft ? (expr as { op: string }).op : this._flipOp((expr as { op: string }).op);

    if (op === '<' || op === '<=') {
      const upperBound = info.strategy.partitionFor(value);
      for (let p = 0; p <= Math.min(upperBound, partCount - 1); p++) {
        result.add(p);
      }
    } else {
      const lowerBound = info.strategy.partitionFor(value);
      for (let p = lowerBound; p < partCount; p++) {
        result.add(p);
      }
    }

    return result;
  }

  _pruneBetween(expr: BoundExpr, info: PartitionTableInfoLike): PrunedPartitionSet | null {
    if (info.strategy.type !== StrategyType.RANGE) return null;
    if (expr.kind !== BoundExprKind.BETWEEN) return null;
    if (!expr.expr || expr.expr.kind !== BoundExprKind.COLUMN_REF) return null;
    if (!this._isPartitionKey(expr.expr, info)) return null;

    if (!expr.low || !expr.high) return null;
    if (expr.low.kind !== BoundExprKind.LITERAL || expr.high.kind !== BoundExprKind.LITERAL) return null;

    const lowPid = info.strategy.partitionFor(expr.low.value);
    const highPid = info.strategy.partitionFor(expr.high.value);

    const result: PrunedPartitionSet = new Set();
    for (let p = lowPid; p <= highPid; p++) {
      result.add(p);
    }
    return result;
  }

  _pruneInList(expr: BoundExpr, info: PartitionTableInfoLike): PrunedPartitionSet | null {
    if (expr.kind !== BoundExprKind.IN_LIST) return null;
    if (!expr.expr || expr.expr.kind !== BoundExprKind.COLUMN_REF) return null;
    if (!this._isPartitionKey(expr.expr, info)) return null;
    const values = (expr as { values?: BoundExpr[] }).values;
    if (!values || !values.every((v: BoundExpr) => v.kind === BoundExprKind.LITERAL)) return null;

    const result: PrunedPartitionSet = new Set();
    for (const v of values) {
      if (info.strategy.type === StrategyType.HASH) {
        result.add(info.strategy.partitionFor((v as { value: LiteralValue }).value, info.partitionCount));
      } else if (info.strategy.type === StrategyType.RANGE) {
        result.add(info.strategy.partitionFor((v as { value: LiteralValue }).value));
      }
    }
    return result;
  }

  _extractPartitionColumn(expr: BoundExpr, info: PartitionTableInfoLike): PartitionKeyRef | null {
    const left = (expr as { left?: BoundExpr }).left;
    const right = (expr as { right?: BoundExpr }).right;
    if (left && left.kind === BoundExprKind.COLUMN_REF && this._isPartitionKey(left, info)) {
      return { col: left, side: 'left' };
    }
    if (right && right.kind === BoundExprKind.COLUMN_REF && this._isPartitionKey(right, info)) {
      return { col: right, side: 'right' };
    }
    return null;
  }

  _isPartitionKey(colRef: { columnName: string }, info: PartitionTableInfoLike): boolean {
    return colRef.columnName.toUpperCase() === (info.partitionKey as string).toUpperCase();
  }

  _flipOp(op: string): string {
    switch (op) {
      case '<': return '>';
      case '<=': return '>=';
      case '>': return '<';
      case '>=': return '<=';
      default: return op;
    }
  }

  _intersect(setA: PrunedPartitionSet, setB: PrunedPartitionSet): PrunedPartitionSet {
    const result: PrunedPartitionSet = new Set();
    for (const val of setA) {
      if (setB.has(val)) result.add(val);
    }
    return result;
  }

  _union(setA: PrunedPartitionSet, setB: PrunedPartitionSet): PrunedPartitionSet {
    const result: PrunedPartitionSet = new Set(setA);
    for (const val of setB) {
      result.add(val);
    }
    return result;
  }

  _allPartitions(count: number): PrunedPartitionSet {
    const result: PrunedPartitionSet = new Set();
    for (let i = 0; i < count; i++) {
      result.add(i);
    }
    return result;
  }
}
