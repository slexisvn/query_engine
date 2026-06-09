import { OptimizationPass } from '../../optimizer/pass.js';
import { PlanNodeType, LogicalPartialAggregate, LogicalFinalAggregate, LogicalExchange, getChildren, setChildren } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { ExchangeType } from '../planner/fragment.js';

const DECOMPOSABLE_FUNCTIONS = new Map([
  ['SUM', { partial: 'SUM', final: 'SUM' }],
  ['COUNT', { partial: 'COUNT', final: 'SUM' }],
  ['COUNT_STAR', { partial: 'COUNT_STAR', final: 'SUM' }],
  ['MIN', { partial: 'MIN', final: 'MIN' }],
  ['MAX', { partial: 'MAX', final: 'MAX' }],
  ['AVG', { partial: 'AVG_PARTIAL', final: 'AVG_FINAL' }],
]);

export class PartialAggregatePass extends OptimizationPass {
  get name() {
    return 'PartialAggregate';
  }

  apply(plan) {
    if (!plan._distributed) return plan;
    const rewriter = new PartialAggregateRewriter();
    return rewriter.rewrite(plan);
  }
}

class PartialAggregateRewriter extends PlanRewriter {
  rewriteAggregate(node) {
    const newNode = this.rewriteChildren(node);

    if (!this._canDecompose(newNode.aggregates)) return newNode;

    const partialAggs = this._buildPartialAggregates(newNode.aggregates);
    const finalAggs = this._buildFinalAggregates(newNode.aggregates);

    const partialNode = LogicalPartialAggregate(
      newNode.groupBy,
      partialAggs,
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
      finalAggs,
      partialAggs,
      exchangeNode
    );
    finalNode._cardinality = newNode._cardinality;

    return finalNode;
  }

  _canDecompose(aggregates) {
    if (!aggregates || aggregates.length === 0) return false;
    return aggregates.every(agg => {
      const funcName = this._normalizeFuncName(agg);
      return DECOMPOSABLE_FUNCTIONS.has(funcName);
    });
  }

  _normalizeFuncName(agg) {
    if (agg.isCountStar) return 'COUNT_STAR';
    return (agg.func || agg.name || '').toUpperCase();
  }

  _buildPartialAggregates(aggregates) {
    return aggregates.map((agg, idx) => {
      const funcName = this._normalizeFuncName(agg);
      const decomp = DECOMPOSABLE_FUNCTIONS.get(funcName);

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

  _buildFinalAggregates(aggregates) {
    return aggregates.map((agg, idx) => {
      const funcName = this._normalizeFuncName(agg);
      const decomp = DECOMPOSABLE_FUNCTIONS.get(funcName);

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
