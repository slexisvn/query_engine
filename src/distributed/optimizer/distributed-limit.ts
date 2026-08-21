import { setChildren, type LogicalPlanNode, type LogicalLimitNode, type LogicalTopNNode } from '../../planner/logical-plan.js';
import { PartitionAwareRewritePass, PartitionAwareRewriter } from './distributed-pass.js';
import { localPartitionedScanTables, hashShuffleExchange } from './repartition.js';

type RowLimitNode = LogicalLimitNode | LogicalTopNNode;

export class DistributedLimitPass extends PartitionAwareRewritePass {
  override get name(): string {
    return 'DistributedLimit';
  }

  override _createRewriter(): DistributedLimitRewriter {
    return new DistributedLimitRewriter(this._partitionMap);
  }
}

class DistributedLimitRewriter extends PartitionAwareRewriter {
  override rewriteLimit(node: LogicalLimitNode): LogicalPlanNode {
    return this._globalise(this.rewriteChildren(node));
  }

  override rewriteTopN(node: LogicalTopNNode): LogicalPlanNode {
    return this._globalise(this.rewriteChildren(node));
  }

  _globalise(node: RowLimitNode): LogicalPlanNode {
    const input = node.children[0];
    const tables = localPartitionedScanTables(input, this._partitionMap);
    if (tables === null || tables.size === 0) return node;

    const offset = node.offset || 0;
    const localNode = { ...node, count: node.count + offset, offset: 0 } as RowLimitNode;
    localNode._cardinality = node._cardinality;

    return setChildren(node, [hashShuffleExchange(input, localNode, node._cardinality)]);
  }
}
