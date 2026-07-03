import { ExchangeType } from './fragment.js';
import { DistributionStrategy } from '../optimizer/distribution-aware-join.js';
import { Config } from '../../config.js';
import { splitAnd } from './expr-utils.js';
import type {
  LogicalJoinNode,
  LogicalAggregateNode,
  LogicalSortNode,
} from '../../planner/logical-plan.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import type { BoundExpr } from '../../binder/expression-binder.js';
import type {
  JoinExchangePlacement,
  AggregateExchange,
  SortExchange,
  JoinShuffleKeys,
  PartitionTableInfo,
} from '../distributed-types.js';

interface PartitionMapLike {
  getTableInfo(table: string): PartitionTableInfo | null;
}

interface TableStatisticsLike {
  rowCount: number;
}

type StatisticsMapLike = Map<string, TableStatisticsLike>;

type DistributedJoinNode = LogicalJoinNode & { _distributionStrategy?: string };

type ShuffleSide = Omit<BoundExpr, 'kind'> & { kind: string };

interface ShuffleOperand {
  op: string;
  left: ShuffleSide;
  right: ShuffleSide;
}

export class ExchangePlacement {
  _partitionMap: PartitionMapLike;
  _statisticsMap: StatisticsMapLike;

  constructor(partitionMap: PartitionMapLike, statisticsMap?: StatisticsMapLike) {
    this._partitionMap = partitionMap;
    this._statisticsMap = statisticsMap || new Map();
  }

  determineJoinExchange(joinNode: LogicalJoinNode): JoinExchangePlacement {
    const strategy = (joinNode as DistributedJoinNode)._distributionStrategy || DistributionStrategy.SHUFFLE;

    switch (strategy) {
      case DistributionStrategy.COLOCATED:
        return {
          left: { type: ExchangeType.PASSTHROUGH },
          right: { type: ExchangeType.PASSTHROUGH },
        } as JoinExchangePlacement;

      case DistributionStrategy.BROADCAST_LEFT:
        return {
          left: { type: ExchangeType.BROADCAST },
          right: { type: ExchangeType.PASSTHROUGH },
        } as JoinExchangePlacement;

      case DistributionStrategy.BROADCAST_RIGHT:
        return {
          left: { type: ExchangeType.PASSTHROUGH },
          right: { type: ExchangeType.BROADCAST },
        } as JoinExchangePlacement;

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
        } as JoinExchangePlacement;
      }
    }
  }

  determineAggregateExchange(aggNode: LogicalAggregateNode): AggregateExchange {
    const groupBy = aggNode.groupBy || [];
    if (groupBy.length === 0) {
      return { type: ExchangeType.GATHER } as AggregateExchange;
    }

    return {
      type: ExchangeType.HASH_SHUFFLE,
      keys: groupBy,
      partitionCount: Config.defaultPartitionCount,
    } as AggregateExchange;
  }

  determineSortExchange(sortNode: LogicalSortNode): SortExchange {
    return {
      type: ExchangeType.GATHER,
      ordered: true,
      orderKeys: sortNode.orderKeys,
    } as SortExchange;
  }

  _extractShuffleKeys(joinNode: LogicalJoinNode): JoinShuffleKeys {
    const leftKeys: BoundExpr[] = [];
    const rightKeys: BoundExpr[] = [];
    const condition = joinNode.condition;
    if (!condition) return { leftKeys, rightKeys };

    const preds = splitAnd(condition);
    for (const pred of preds) {
      if (pred.kind === BoundExprKind.BINARY && (pred as ShuffleOperand).op === '=' && (pred as ShuffleOperand).left?.kind === BoundExprKind.COLUMN_REF && (pred as ShuffleOperand).right?.kind === BoundExprKind.COLUMN_REF) {
        leftKeys.push((pred as ShuffleOperand).left as BoundExpr);
        rightKeys.push((pred as ShuffleOperand).right as BoundExpr);
      }
    }

    return { leftKeys, rightKeys };
  }
}
