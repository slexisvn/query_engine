import { ExchangeType } from './fragment.js';
import { DistributionStrategy } from '../optimizer/distribution-aware-join.js';
import { Config } from '../../config.js';

export class ExchangePlacement {
  constructor(partitionMap, statisticsMap) {
    this._partitionMap = partitionMap;
    this._statisticsMap = statisticsMap || new Map();
  }

  determineJoinExchange(joinNode) {
    const strategy = joinNode._distributionStrategy || DistributionStrategy.SHUFFLE;

    switch (strategy) {
      case DistributionStrategy.COLOCATED:
        return {
          left: { type: ExchangeType.PASSTHROUGH },
          right: { type: ExchangeType.PASSTHROUGH },
        };

      case DistributionStrategy.BROADCAST_LEFT:
        return {
          left: { type: ExchangeType.BROADCAST },
          right: { type: ExchangeType.PASSTHROUGH },
        };

      case DistributionStrategy.BROADCAST_RIGHT:
        return {
          left: { type: ExchangeType.PASSTHROUGH },
          right: { type: ExchangeType.BROADCAST },
        };

      case DistributionStrategy.SHUFFLE:
      default: {
        const keys = this._extractShuffleKeys(joinNode);
        return {
          left: {
            type: ExchangeType.HASH_SHUFFLE,
            keys: keys.leftKeys,
            partitionCount: Config.defaultPartitionCount,
          },
          right: {
            type: ExchangeType.HASH_SHUFFLE,
            keys: keys.rightKeys,
            partitionCount: Config.defaultPartitionCount,
          },
        };
      }
    }
  }

  determineAggregateExchange(aggNode) {
    const groupBy = aggNode.groupBy || [];
    if (groupBy.length === 0) {
      return { type: ExchangeType.GATHER };
    }

    return {
      type: ExchangeType.HASH_SHUFFLE,
      keys: groupBy,
      partitionCount: Config.defaultPartitionCount,
    };
  }

  determineSortExchange(sortNode) {
    return {
      type: ExchangeType.GATHER,
      ordered: true,
      orderKeys: sortNode.orderKeys,
    };
  }

  _extractShuffleKeys(joinNode) {
    const leftKeys = [];
    const rightKeys = [];
    const condition = joinNode.condition;
    if (!condition) return { leftKeys, rightKeys };

    const preds = this._splitAnd(condition);
    for (const pred of preds) {
      if (pred.op === '=' && pred.left?.kind === 'ColumnRef' && pred.right?.kind === 'ColumnRef') {
        leftKeys.push(pred.left);
        rightKeys.push(pred.right);
      }
    }

    return { leftKeys, rightKeys };
  }

  _splitAnd(expr) {
    if (!expr) return [];
    if (expr.op === 'AND') {
      return [...this._splitAnd(expr.left), ...this._splitAnd(expr.right)];
    }
    return [expr];
  }
}
