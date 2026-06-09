import { OptimizationPass } from '../../optimizer/pass.js';
import { PlanNodeType, JoinType, getChildren, setChildren } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import { Config } from '../../config.js';

export const DistributionStrategy = {
  COLOCATED: 'colocated',
  BROADCAST_LEFT: 'broadcast_left',
  BROADCAST_RIGHT: 'broadcast_right',
  SHUFFLE: 'shuffle',
};

export class DistributionAwareJoin extends OptimizationPass {
  constructor(partitionMap, statisticsMap = new Map()) {
    super();
    this._partitionMap = partitionMap;
    this._statisticsMap = statisticsMap;
    this._costPerByte = Config.networkCostPerByte;
  }

  get name() {
    return 'DistributionAwareJoin';
  }

  apply(plan) {
    const rewriter = new DistributionAwareJoinRewriter(
      this._partitionMap,
      this._statisticsMap,
      this._costPerByte
    );
    return rewriter.rewrite(plan);
  }
}

class DistributionAwareJoinRewriter extends PlanRewriter {
  constructor(partitionMap, statisticsMap, costPerByte) {
    super();
    this._partitionMap = partitionMap;
    this._statisticsMap = statisticsMap;
    this._costPerByte = costPerByte;
  }

  rewriteJoin(node) {
    const newNode = this.rewriteChildren(node);

    const joinKeys = this._extractJoinKeys(newNode.condition);
    if (joinKeys.leftKeys.length === 0) {
      newNode._distributionStrategy = DistributionStrategy.SHUFFLE;
      return newNode;
    }

    const leftTable = this._findScanTable(newNode.children[0]);
    const rightTable = this._findScanTable(newNode.children[1]);

    if (leftTable && rightTable && this._areColocated(leftTable, rightTable, joinKeys)) {
      newNode._distributionStrategy = DistributionStrategy.COLOCATED;
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

    const strategies = [
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
    newNode._distributionStrategy = strategies[0].strategy;
    newNode._distributionCost = strategies[0].cost;

    return newNode;
  }

  _areColocated(leftTable, rightTable, joinKeys) {
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

  _extractJoinKeys(condition) {
    const leftKeys = [];
    const rightKeys = [];
    if (!condition) return { leftKeys, rightKeys };

    const preds = this._splitAnd(condition);
    for (const pred of preds) {
      if (pred.kind === BoundExprKind.BINARY && pred.op === '='
        && pred.left?.kind === BoundExprKind.COLUMN_REF
        && pred.right?.kind === BoundExprKind.COLUMN_REF) {
        leftKeys.push(`${pred.left.tableAlias || ''}.${pred.left.columnName}`.toUpperCase());
        rightKeys.push(`${pred.right.tableAlias || ''}.${pred.right.columnName}`.toUpperCase());
      }
    }

    return { leftKeys, rightKeys };
  }

  _splitAnd(expr) {
    if (!expr) return [];
    if (expr.kind === BoundExprKind.BINARY && expr.op === 'AND') {
      return [...this._splitAnd(expr.left), ...this._splitAnd(expr.right)];
    }
    return [expr];
  }

  _findScanTable(node) {
    if (node.type === PlanNodeType.SCAN) return node.table;
    if (node.type === PlanNodeType.INDEX_SCAN) return node.table;
    if (node.children && node.children.length > 0) {
      return this._findScanTable(node.children[0]);
    }
    return null;
  }

  _estimateCardinality(node) {
    if (node._cardinality) return node._cardinality;
    if (node.type === PlanNodeType.SCAN && this._statisticsMap.has(node.table)) {
      return this._statisticsMap.get(node.table).rowCount;
    }
    return 1000;
  }

  _estimateRowWidth(node) {
    const table = this._findScanTable(node);
    if (table && this._statisticsMap.has(table)) {
      return this._statisticsMap.get(table).avgRowWidth || 64;
    }
    return 64;
  }

  _estimateNodeCount() {
    return Math.max(2, Config.defaultPartitionCount);
  }

  _isRestrictedJoinType(joinType) {
    return joinType === JoinType.LEFT
      || joinType === JoinType.SEMI
      || joinType === JoinType.ANTI;
  }
}
