import { SetOpType, LogicalDistinct, setChildren, type LogicalPlanNode, type LogicalSetOpNode } from '../../planner/logical-plan.js';
import { PartitionAwareRewritePass, PartitionAwareRewriter } from './distributed-pass.js';
import { partitionedScanTables, localPartitionedScanTables, hashShuffleExchange } from './repartition.js';

export class DistributedSetOpPass extends PartitionAwareRewritePass {
  override get name(): string {
    return 'DistributedSetOp';
  }

  override _createRewriter(): DistributedSetOpRewriter {
    return new DistributedSetOpRewriter(this._partitionMap);
  }
}

class DistributedSetOpRewriter extends PartitionAwareRewriter {
  override rewriteSetOp(node: LogicalSetOpNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);
    const perInput = newNode.children.map(child => partitionedScanTables(child, this._partitionMap));
    if (perInput.every(tables => tables.size === 0)) return newNode;

    if (newNode.op === SetOpType.UNION && this._isPartitionWise(newNode)) {
      return newNode.all ? newNode : this._globalDedup(newNode);
    }

    return setChildren(newNode, newNode.children.map((child, index) =>
      perInput[index].size === 0 ? child : hashShuffleExchange(child, child, child._cardinality)));
  }

  _globalDedup(node: LogicalSetOpNode): LogicalPlanNode {
    const finalDistinct = LogicalDistinct(hashShuffleExchange(node.children[0], node, node._cardinality));
    finalDistinct._cardinality = node._cardinality;
    return finalDistinct;
  }

  _isPartitionWise(node: LogicalSetOpNode): boolean {
    const perInput = node.children.map(child => localPartitionedScanTables(child, this._partitionMap));
    if (perInput.some(tables => tables === null || tables.size === 0)) return false;

    const [first, ...rest] = perInput as Set<string>[];
    return rest.every(tables => tables.size === first.size && [...tables].every(table => first.has(table)));
  }
}
