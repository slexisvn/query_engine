import { OptimizationPass } from '../../optimizer/pass.js';
import { PlanNodeType, LogicalPartialAggregate, LogicalFinalAggregate, LogicalExchange, getChildren, setChildren, type LogicalPlanNode, type LogicalAggregateNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { ExchangeType } from '../planner/fragment.js';
import type { BoundExpr } from '../../binder/expression-binder.js';
import type { AggregateDecomposition } from '../distributed-types.js';

interface DistributedFlag {
  _distributed?: boolean;
}

interface AggDescriptor {
  func?: string;
  name?: string;
  isCountStar?: boolean;
  _originalIndex?: number;
  _emitColumns?: string[];
  _inputColumns?: string[];
}

const DECOMPOSABLE_FUNCTIONS = new Map<string, AggregateDecomposition>([
  ['SUM', { partial: 'SUM', final: 'SUM' }],
  ['COUNT', { partial: 'COUNT', final: 'SUM' }],
  ['COUNT_STAR', { partial: 'COUNT_STAR', final: 'SUM' }],
  ['MIN', { partial: 'MIN', final: 'MIN' }],
  ['MAX', { partial: 'MAX', final: 'MAX' }],
  ['AVG', { partial: 'AVG_PARTIAL', final: 'AVG_FINAL' }],
]);

export class PartialAggregatePass extends OptimizationPass {
  override get name(): string {
    return 'PartialAggregate';
  }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    if (!(plan as LogicalPlanNode & DistributedFlag)._distributed) return plan;
    const rewriter = new PartialAggregateRewriter();
    return rewriter.rewrite(plan);
  }
}

class PartialAggregateRewriter extends PlanRewriter {
  override rewriteAggregate(node: LogicalAggregateNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);

    if (!this._canDecompose(newNode.aggregates as AggDescriptor[])) return newNode;

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

  _canDecompose(aggregates: AggDescriptor[]): boolean {
    if (!aggregates || aggregates.length === 0) return false;
    return aggregates.every(agg => {
      const funcName = this._normalizeFuncName(agg);
      return DECOMPOSABLE_FUNCTIONS.has(funcName);
    });
  }

  _normalizeFuncName(agg: AggDescriptor): string {
    if (agg.isCountStar) return 'COUNT_STAR';
    return (agg.func || agg.name || '').toUpperCase();
  }

  _buildPartialAggregates(aggregates: AggDescriptor[]): AggDescriptor[] {
    return aggregates.map((agg, idx) => {
      const funcName = this._normalizeFuncName(agg);
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
      const funcName = this._normalizeFuncName(agg);
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
