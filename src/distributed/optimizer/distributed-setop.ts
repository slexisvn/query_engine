import { OptimizationPass } from '../../optimizer/pass.js';
import { SetOpType, LogicalDistinct, LogicalExchange, setChildren, type LogicalPlanNode, type LogicalSetOpNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { ExchangeType } from '../planner/fragment.js';
import { partitionedScanTables, localPartitionedScanTables, shuffleKeysOf, type PartitionMapLike } from './repartition.js';

interface DistributedFlag {
  _distributed?: boolean;
}

export class DistributedSetOpPass extends OptimizationPass {
  _partitionMap: PartitionMapLike | null;

  constructor(partitionMap: PartitionMapLike | null) {
    super();
    this._partitionMap = partitionMap;
  }

  override get name(): string {
    return 'DistributedSetOp';
  }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    if (!(plan as LogicalPlanNode & DistributedFlag)._distributed) return plan;
    const rewriter = new DistributedSetOpRewriter(this._partitionMap);
    return rewriter.rewrite(plan);
  }
}

class DistributedSetOpRewriter extends PlanRewriter {
  _partitionMap: PartitionMapLike | null;

  constructor(partitionMap: PartitionMapLike | null) {
    super();
    this._partitionMap = partitionMap;
  }

  override rewriteSetOp(node: LogicalSetOpNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);
    const perInput = newNode.children.map(child => partitionedScanTables(child, this._partitionMap));
    if (perInput.every(tables => tables.size === 0)) return newNode;

    if (newNode.op === SetOpType.UNION && this._isPartitionWise(newNode)) {
      return newNode.all ? newNode : this._globalDedup(newNode);
    }

    return setChildren(newNode, newNode.children.map((child, index) =>
      perInput[index].size === 0 ? child : this._repartition(child)));
  }

  _globalDedup(node: LogicalSetOpNode): LogicalPlanNode {
    const exchangeNode = LogicalExchange(
      ExchangeType.HASH_SHUFFLE,
      shuffleKeysOf(node.children[0]),
      0,
      node
    );
    exchangeNode._cardinality = node._cardinality;

    const finalDistinct = LogicalDistinct(exchangeNode);
    finalDistinct._cardinality = node._cardinality;

    return finalDistinct;
  }

  _repartition(child: LogicalPlanNode): LogicalPlanNode {
    const exchangeNode = LogicalExchange(ExchangeType.HASH_SHUFFLE, shuffleKeysOf(child), 0, child);
    exchangeNode._cardinality = child._cardinality;
    return exchangeNode;
  }

  _isPartitionWise(node: LogicalSetOpNode): boolean {
    const perInput = node.children.map(child => localPartitionedScanTables(child, this._partitionMap));
    if (perInput.some(tables => tables === null || tables.size === 0)) return false;

    const [first, ...rest] = perInput as Set<string>[];
    return rest.every(tables => tables.size === first.size && [...tables].every(table => first.has(table)));
  }
}
