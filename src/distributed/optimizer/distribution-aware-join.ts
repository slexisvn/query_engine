import { OptimizationPass } from '../../optimizer/pass.js';
import { PlanNodeType, JoinType, getChildren, setChildren } from '../../planner/logical-plan.js';
import type { LogicalPlanNode, LogicalJoinNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import type { BoundExpr, BoundColumnRefNode } from '../../binder/expression-binder.js';
import { Config } from '../../config.js';
import { splitConjuncts } from '../../binder/conjuncts.js';

interface TableStatisticsLike {
  rowCount: number;
  avgRowWidth: number;
}

interface PartitionTableInfoLike {
  partitionKey: string | null;
}

interface PartitionMapLike {
  getTableInfo(tableName: string): PartitionTableInfoLike | null;
  isColocated(tableA: string, tableB: string): boolean;
  isReplicated(tableName: string): boolean;
}

type StringJoinKeys = { leftKeys: string[]; rightKeys: string[] };

const REPLICATED_SIDE_ALLOWED_BY_JOIN_TYPE: Partial<Record<string, 'left' | 'right' | 'any'>> = {
  [JoinType.INNER]: 'any',
  [JoinType.LEFT]: 'right',
  [JoinType.RIGHT]: 'left',
  [JoinType.SEMI]: 'right',
  [JoinType.ANTI]: 'right',
};

export const DistributionStrategy = {
  COLOCATED: 'colocated',
  BROADCAST_LEFT: 'broadcast_left',
  BROADCAST_RIGHT: 'broadcast_right',
  SHUFFLE: 'shuffle',
};

export class DistributionAwareJoin extends OptimizationPass {
  _partitionMap: PartitionMapLike | null;
  _statisticsMap: Map<string, TableStatisticsLike>;
  _costPerByte: number;

  constructor(partitionMap: PartitionMapLike | null, statisticsMap: Map<string, TableStatisticsLike> = new Map()) {
    super();
    this._partitionMap = partitionMap;
    this._statisticsMap = statisticsMap;
    this._costPerByte = Config.networkCostPerByte;
  }

  override get name(): string {
    return 'DistributionAwareJoin';
  }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new DistributionAwareJoinRewriter(
      this._partitionMap,
      this._statisticsMap,
      this._costPerByte
    );
    return rewriter.rewrite(plan);
  }
}

class DistributionAwareJoinRewriter extends PlanRewriter {
  _partitionMap: PartitionMapLike | null;
  _statisticsMap: Map<string, TableStatisticsLike>;
  _costPerByte: number;

  constructor(partitionMap: PartitionMapLike | null, statisticsMap: Map<string, TableStatisticsLike>, costPerByte: number) {
    super();
    this._partitionMap = partitionMap;
    this._statisticsMap = statisticsMap;
    this._costPerByte = costPerByte;
  }

  override rewriteJoin(node: LogicalJoinNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);

    const joinKeys = this._extractJoinKeys(newNode.condition);
    if (joinKeys.leftKeys.length === 0) {
      (newNode as LogicalJoinNode & { _distributionStrategy: string })._distributionStrategy = DistributionStrategy.SHUFFLE;
      return newNode;
    }

    const leftTable = this._findScanTable(newNode.children[0]);
    const rightTable = this._findScanTable(newNode.children[1]);

    if (this._joinsAgainstReplicatedTable(newNode)) {
      (newNode as LogicalJoinNode & { _distributionStrategy: string })._distributionStrategy = DistributionStrategy.COLOCATED;
      return newNode;
    }

    if (leftTable && rightTable && this._areColocated(leftTable, rightTable, joinKeys)) {
      (newNode as LogicalJoinNode & { _distributionStrategy: string })._distributionStrategy = DistributionStrategy.COLOCATED;
      return newNode;
    }

    const leftCard = newNode.children[0]._cardinality || this._estimateCardinality(newNode.children[0]);
    const rightCard = newNode.children[1]._cardinality || this._estimateCardinality(newNode.children[1]);
    const leftRowWidth = this._estimateRowWidth(newNode.children[0]);
    const rightRowWidth = this._estimateRowWidth(newNode.children[1]);
    const nodeCount = this._estimateNodeCount();

    const shuffleCost = (leftCard * leftRowWidth + rightCard * rightRowWidth) * this._costPerByte;
    const broadcastLeftCost = leftCard * leftRowWidth * this._costPerByte * nodeCount;
    const broadcastRightCost = rightCard * rightRowWidth * this._costPerByte * nodeCount;

    const strategies: { strategy: string; cost: number }[] = [
      { strategy: DistributionStrategy.SHUFFLE, cost: shuffleCost },
      { strategy: DistributionStrategy.BROADCAST_LEFT, cost: broadcastLeftCost },
      { strategy: DistributionStrategy.BROADCAST_RIGHT, cost: broadcastRightCost },
    ];

    if (leftCard > Config.broadcastThreshold) {
      strategies[1].cost = Infinity;
    }
    if (rightCard > Config.broadcastThreshold) {
      strategies[2].cost = Infinity;
    }

    if (this._isRestrictedJoinType(newNode.joinType)) {
      strategies[1].cost = Infinity;
    }

    strategies.sort((a, b) => a.cost - b.cost);
    (newNode as LogicalJoinNode & { _distributionStrategy: string })._distributionStrategy = strategies[0].strategy;
    (newNode as LogicalJoinNode & { _distributionCost: number })._distributionCost = strategies[0].cost;

    return newNode;
  }

  _joinsAgainstReplicatedTable(node: LogicalJoinNode): boolean {
    if (!this._partitionMap) return false;

    const allowedSide = REPLICATED_SIDE_ALLOWED_BY_JOIN_TYPE[node.joinType];
    if (!allowedSide) return false;

    const leftTables = this._scanTables(node.children[0]);
    const rightTables = this._scanTables(node.children[1]);
    if (leftTables.length === 0 || rightTables.length === 0) return false;

    const allReplicated = (tables: string[]): boolean =>
      tables.every((table) => (this._partitionMap as PartitionMapLike).isReplicated(table));
    const anyPartitioned = (tables: string[]): boolean =>
      tables.some((table) => (this._partitionMap as PartitionMapLike).getTableInfo(table) !== null);

    const leftReplicated = allReplicated(leftTables);
    const rightReplicated = allReplicated(rightTables);
    if (leftReplicated === rightReplicated) return false;

    const replicatedSide = leftReplicated ? 'left' : 'right';
    if (allowedSide !== 'any' && allowedSide !== replicatedSide) return false;

    return anyPartitioned(leftReplicated ? rightTables : leftTables);
  }

  _scanTables(node: LogicalPlanNode, into: string[] = []): string[] {
    if (node.type === PlanNodeType.SCAN || node.type === PlanNodeType.INDEX_SCAN) {
      into.push((node as LogicalPlanNode & { table: string }).table);
      return into;
    }
    for (const child of getChildren(node)) this._scanTables(child, into);
    return into;
  }

  _areColocated(leftTable: string, rightTable: string, joinKeys: StringJoinKeys): boolean {
    if (!this._partitionMap) return false;

    const leftInfo = this._partitionMap.getTableInfo(leftTable);
    const rightInfo = this._partitionMap.getTableInfo(rightTable);
    if (!leftInfo || !rightInfo) return false;

    if (!this._partitionMap.isColocated(leftTable, rightTable)) return false;

    if (!leftInfo.partitionKey || !rightInfo.partitionKey) return false;

    const leftPartKey = leftInfo.partitionKey.toUpperCase();
    const rightPartKey = rightInfo.partitionKey.toUpperCase();

    for (let i = 0; i < joinKeys.leftKeys.length; i++) {
      const lk = joinKeys.leftKeys[i].toUpperCase();
      const rk = joinKeys.rightKeys[i].toUpperCase();
      if (lk.endsWith(leftPartKey) && rk.endsWith(rightPartKey)) return true;
      if (lk.endsWith(rightPartKey) && rk.endsWith(leftPartKey)) return true;
    }

    return false;
  }

  _extractJoinKeys(condition: BoundExpr | null): StringJoinKeys {
    const leftKeys: string[] = [];
    const rightKeys: string[] = [];
    if (!condition) return { leftKeys, rightKeys };

    const preds = splitConjuncts(condition);
    for (const pred of preds) {
      if (pred.kind === BoundExprKind.BINARY && pred.op === '='
        && pred.left?.kind === BoundExprKind.COLUMN_REF
        && pred.right?.kind === BoundExprKind.COLUMN_REF) {
        leftKeys.push(`${(pred.left as BoundColumnRefNode).tableAlias || ''}.${(pred.left as BoundColumnRefNode).columnName}`.toUpperCase());
        rightKeys.push(`${(pred.right as BoundColumnRefNode).tableAlias || ''}.${(pred.right as BoundColumnRefNode).columnName}`.toUpperCase());
      }
    }

    return { leftKeys, rightKeys };
  }

  _findScanTable(node: LogicalPlanNode): string | null {
    if (node.type === PlanNodeType.SCAN) return node.table;
    if (node.type === PlanNodeType.INDEX_SCAN) return node.table;
    if (node.children && node.children.length > 0) {
      return this._findScanTable(node.children[0]);
    }
    return null;
  }

  _estimateCardinality(node: LogicalPlanNode): number {
    if (node._cardinality) return node._cardinality;
    if (node.type === PlanNodeType.SCAN && this._statisticsMap.has(node.table)) {
      return (this._statisticsMap.get(node.table) as TableStatisticsLike).rowCount;
    }
    return 1000;
  }

  _estimateRowWidth(node: LogicalPlanNode): number {
    const table = this._findScanTable(node);
    if (table && this._statisticsMap.has(table)) {
      return (this._statisticsMap.get(table) as TableStatisticsLike).avgRowWidth || 64;
    }
    return 64;
  }

  _estimateNodeCount(): number {
    return Math.max(2, Config.defaultPartitionCount);
  }

  _isRestrictedJoinType(joinType: JoinType): boolean {
    return joinType === JoinType.LEFT
      || joinType === JoinType.SEMI
      || joinType === JoinType.ANTI;
  }
}
