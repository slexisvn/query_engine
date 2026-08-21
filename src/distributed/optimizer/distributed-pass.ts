import { OptimizationPass } from '../../optimizer/pass.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { isDistributed } from '../distributed-types.js';
import type { LogicalPlanNode } from '../../planner/logical-plan.js';
import type { PartitionMapLike } from './repartition.js';

export abstract class DistributedRewritePass extends OptimizationPass {
  abstract _createRewriter(): PlanRewriter;

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    if (!isDistributed(plan)) return plan;
    return this._createRewriter().rewrite(plan);
  }
}

export abstract class PartitionAwareRewritePass extends DistributedRewritePass {
  _partitionMap: PartitionMapLike | null;

  constructor(partitionMap: PartitionMapLike | null) {
    super();
    this._partitionMap = partitionMap;
  }
}

export abstract class PartitionAwareRewriter extends PlanRewriter {
  _partitionMap: PartitionMapLike | null;

  constructor(partitionMap: PartitionMapLike | null) {
    super();
    this._partitionMap = partitionMap;
  }
}
