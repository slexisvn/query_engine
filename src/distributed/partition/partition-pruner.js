import { BoundExprKind } from '../../binder/expression-binder.js';
import { StrategyType } from './partition-strategy.js';

export class PartitionPruner {
  prune(tableName, predicate, partitionMap) {
    const info = partitionMap.getTableInfo(tableName);
    if (!info) return this._allPartitions(0);

    const allIds = this._allPartitions(info.partitionCount);

    if (!predicate || !info.partitionKey) return allIds;

    const pruned = this._prunePredicate(predicate, info);
    return pruned || allIds;
  }

  _prunePredicate(expr, info) {
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

  _pruneEquality(expr, info) {
    const colRef = this._extractPartitionColumn(expr, info);
    if (!colRef) return null;

    const literal = colRef.side === 'left' ? expr.right : expr.left;
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

  _pruneRange(expr, info) {
    if (info.strategy.type !== StrategyType.RANGE) return null;

    const colRef = this._extractPartitionColumn(expr, info);
    if (!colRef) return null;

    const literal = colRef.side === 'left' ? expr.right : expr.left;
    if (literal.kind !== BoundExprKind.LITERAL) return null;

    const boundaries = info.strategy.boundaries;
    const partCount = boundaries.length + 1;
    const value = literal.value;
    const result = new Set();

    const isColOnLeft = colRef.side === 'left';
    const op = isColOnLeft ? expr.op : this._flipOp(expr.op);

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

  _pruneBetween(expr, info) {
    if (info.strategy.type !== StrategyType.RANGE) return null;
    if (!expr.expr || expr.expr.kind !== BoundExprKind.COLUMN_REF) return null;
    if (!this._isPartitionKey(expr.expr, info)) return null;

    if (!expr.low || !expr.high) return null;
    if (expr.low.kind !== BoundExprKind.LITERAL || expr.high.kind !== BoundExprKind.LITERAL) return null;

    const lowPid = info.strategy.partitionFor(expr.low.value);
    const highPid = info.strategy.partitionFor(expr.high.value);

    const result = new Set();
    for (let p = lowPid; p <= highPid; p++) {
      result.add(p);
    }
    return result;
  }

  _pruneInList(expr, info) {
    if (!expr.expr || expr.expr.kind !== BoundExprKind.COLUMN_REF) return null;
    if (!this._isPartitionKey(expr.expr, info)) return null;
    if (!expr.values || !expr.values.every(v => v.kind === BoundExprKind.LITERAL)) return null;

    const result = new Set();
    for (const v of expr.values) {
      if (info.strategy.type === StrategyType.HASH) {
        result.add(info.strategy.partitionFor(v.value, info.partitionCount));
      } else if (info.strategy.type === StrategyType.RANGE) {
        result.add(info.strategy.partitionFor(v.value));
      }
    }
    return result;
  }

  _extractPartitionColumn(expr, info) {
    if (expr.left && expr.left.kind === BoundExprKind.COLUMN_REF && this._isPartitionKey(expr.left, info)) {
      return { col: expr.left, side: 'left' };
    }
    if (expr.right && expr.right.kind === BoundExprKind.COLUMN_REF && this._isPartitionKey(expr.right, info)) {
      return { col: expr.right, side: 'right' };
    }
    return null;
  }

  _isPartitionKey(colRef, info) {
    return colRef.columnName.toUpperCase() === info.partitionKey.toUpperCase();
  }

  _flipOp(op) {
    switch (op) {
      case '<': return '>';
      case '<=': return '>=';
      case '>': return '<';
      case '>=': return '<=';
      default: return op;
    }
  }

  _intersect(setA, setB) {
    const result = new Set();
    for (const val of setA) {
      if (setB.has(val)) result.add(val);
    }
    return result;
  }

  _union(setA, setB) {
    const result = new Set(setA);
    for (const val of setB) {
      result.add(val);
    }
    return result;
  }

  _allPartitions(count) {
    const result = new Set();
    for (let i = 0; i < count; i++) {
      result.add(i);
    }
    return result;
  }
}
