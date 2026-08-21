import { OptimizationPass } from '../../optimizer/pass.js';
import { LogicalExchange, setChildren, type LogicalPlanNode, type LogicalLimitNode, type LogicalTopNNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { ExchangeType } from '../planner/fragment.js';
import { localPartitionedScanTables, shuffleKeysOf, type PartitionMapLike } from './repartition.js';

interface DistributedFlag {
  _distributed?: boolean;
}

type RowLimitNode = LogicalLimitNode | LogicalTopNNode;

export class DistributedLimitPass extends OptimizationPass {
  _partitionMap: PartitionMapLike | null;

  constructor(partitionMap: PartitionMapLike | null) {
    super();
    this._partitionMap = partitionMap;
  }

  override get name(): string {
    return 'DistributedLimit';
  }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    if (!(plan as LogicalPlanNode & DistributedFlag)._distributed) return plan;
    const rewriter = new DistributedLimitRewriter(this._partitionMap);
    return rewriter.rewrite(plan);
  }
}

class DistributedLimitRewriter extends PlanRewriter {
  _partitionMap: PartitionMapLike | null;

  constructor(partitionMap: PartitionMapLike | null) {
    super();
    this._partitionMap = partitionMap;
  }

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

    const exchangeNode = LogicalExchange(ExchangeType.HASH_SHUFFLE, shuffleKeysOf(input), 0, localNode);
    exchangeNode._cardinality = node._cardinality;

    return setChildren(node, [exchangeNode]);
  }
}
