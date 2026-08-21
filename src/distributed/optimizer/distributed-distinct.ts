import { LogicalDistinct, type LogicalPlanNode, type LogicalDistinctNode } from '../../planner/logical-plan.js';
import { PartitionAwareRewritePass, PartitionAwareRewriter } from './distributed-pass.js';
import { partitionedScanTables, hashShuffleExchange } from './repartition.js';

export class DistributedDistinctPass extends PartitionAwareRewritePass {
  override get name(): string {
    return 'DistributedDistinct';
  }

  override _createRewriter(): DistributedDistinctRewriter {
    return new DistributedDistinctRewriter(this._partitionMap);
  }
}

class DistributedDistinctRewriter extends PartitionAwareRewriter {
  override rewriteDistinct(node: LogicalDistinctNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);
    const child = newNode.children[0];
    if (partitionedScanTables(child, this._partitionMap).size === 0) return newNode;

    const localDistinct = LogicalDistinct(child);
    localDistinct._cardinality = newNode._cardinality;

    const finalDistinct = LogicalDistinct(hashShuffleExchange(child, localDistinct, newNode._cardinality));
    finalDistinct._cardinality = newNode._cardinality;

    return finalDistinct;
  }
}
