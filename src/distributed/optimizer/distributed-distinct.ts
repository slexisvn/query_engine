import { OptimizationPass } from '../../optimizer/pass.js';
import { LogicalDistinct, LogicalExchange, type LogicalPlanNode, type LogicalDistinctNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { ExchangeType } from '../planner/fragment.js';
import { partitionedScanTables, shuffleKeysOf, type PartitionMapLike } from './repartition.js';

interface DistributedFlag {
  _distributed?: boolean;
}

export class DistributedDistinctPass extends OptimizationPass {
  _partitionMap: PartitionMapLike | null;

  constructor(partitionMap: PartitionMapLike | null) {
    super();
    this._partitionMap = partitionMap;
  }

  override get name(): string {
    return 'DistributedDistinct';
  }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    if (!(plan as LogicalPlanNode & DistributedFlag)._distributed) return plan;
    const rewriter = new DistributedDistinctRewriter(this._partitionMap);
    return rewriter.rewrite(plan);
  }
}

class DistributedDistinctRewriter extends PlanRewriter {
  _partitionMap: PartitionMapLike | null;

  constructor(partitionMap: PartitionMapLike | null) {
    super();
    this._partitionMap = partitionMap;
  }

  override rewriteDistinct(node: LogicalDistinctNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);
    const child = newNode.children[0];
    if (partitionedScanTables(child, this._partitionMap).size === 0) return newNode;

    const localDistinct = LogicalDistinct(child);
    localDistinct._cardinality = newNode._cardinality;

    const exchangeNode = LogicalExchange(
      ExchangeType.HASH_SHUFFLE,
      shuffleKeysOf(child),
      0,
      localDistinct
    );
    exchangeNode._cardinality = newNode._cardinality;

    const finalDistinct = LogicalDistinct(exchangeNode);
    finalDistinct._cardinality = newNode._cardinality;

    return finalDistinct;
  }
}
