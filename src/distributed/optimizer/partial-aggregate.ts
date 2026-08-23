import { LogicalPartialAggregate, LogicalFinalAggregate, LogicalExchange, type LogicalPlanNode, type LogicalAggregateNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { ExchangeType } from '../planner/fragment.js';
import { DistributedRewritePass } from './distributed-pass.js';
import { DECOMPOSABLE_FUNCTIONS, aggregateFunctionName } from '../../planner/aggregate-decomposition.js';
import type { BoundExpr } from '../../binder/expression-binder.js';

interface AggDescriptor {
  func?: string;
  name?: string;
  distinct?: boolean;
  isCountStar?: boolean;
  _originalIndex?: number;
  _emitColumns?: string[];
  _inputColumns?: string[];
}

export class PartialAggregatePass extends DistributedRewritePass {
  override get name(): string {
    return 'PartialAggregate';
  }

  override _createRewriter(): PartialAggregateRewriter {
    return new PartialAggregateRewriter();
  }
}

class PartialAggregateRewriter extends PlanRewriter {
  override rewriteAggregate(node: LogicalAggregateNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);

    if (!this._canDecompose(newNode.aggregates as AggDescriptor[], newNode.groupBy)) return newNode;

    const partialAggs = this._buildPartialAggregates(newNode.aggregates as AggDescriptor[]);
    const finalAggs = this._buildFinalAggregates(newNode.aggregates as AggDescriptor[]);

    const partialNode = LogicalPartialAggregate(
      newNode.groupBy,
      partialAggs as BoundExpr[],
      newNode.children[0]
    );
    partialNode._cardinality = newNode._cardinality;

    const exchangeKeys = (newNode.groupBy || []).map(g => g);
    const exchangeNode = LogicalExchange(
      ExchangeType.HASH_SHUFFLE,
      exchangeKeys,
      0,
      partialNode
    );

    const finalNode = LogicalFinalAggregate(
      newNode.groupBy,
      finalAggs as BoundExpr[],
      partialAggs as BoundExpr[],
      exchangeNode
    );
    finalNode._cardinality = newNode._cardinality;

    return finalNode;
  }

  _canDecompose(aggregates: AggDescriptor[], groupBy: readonly BoundExpr[] | null): boolean {
    if (!aggregates || aggregates.length === 0) return (groupBy?.length ?? 0) > 0;
    return aggregates.every(agg => {
      if (agg.distinct) return false;
      const funcName = aggregateFunctionName(agg);
      return DECOMPOSABLE_FUNCTIONS.has(funcName);
    });
  }

  _buildPartialAggregates(aggregates: AggDescriptor[]): AggDescriptor[] {
    return aggregates.map((agg, idx) => {
      const funcName = aggregateFunctionName(agg);
      const decomp = DECOMPOSABLE_FUNCTIONS.get(funcName)!;

      if (funcName === 'AVG') {
        return {
          ...agg,
          func: decomp.partial,
          _originalIndex: idx,
          _emitColumns: ['_sum', '_count'],
        };
      }

      return {
        ...agg,
        func: decomp.partial,
        _originalIndex: idx,
      };
    });
  }

  _buildFinalAggregates(aggregates: AggDescriptor[]): AggDescriptor[] {
    return aggregates.map((agg, idx) => {
      const funcName = aggregateFunctionName(agg);
      const decomp = DECOMPOSABLE_FUNCTIONS.get(funcName)!;

      if (funcName === 'AVG') {
        return {
          ...agg,
          func: decomp.final,
          _originalIndex: idx,
          _inputColumns: ['_sum', '_count'],
        };
      }

      return {
        ...agg,
        func: decomp.final,
        _originalIndex: idx,
      };
    });
  }
}

export { DECOMPOSABLE_FUNCTIONS };
