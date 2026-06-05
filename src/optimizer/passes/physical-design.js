import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, PhysicalStrategy, getChildren, setChildren } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { DefaultCostModel } from '../dphyp/cost-model.js';
import { DefaultCardinalityEstimator } from '../dphyp/cardinality.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class PhysicalDesign extends OptimizationPass {
  constructor(statisticsMap = new Map(), costModel = null, cardEstimator = null) {
    super();
    this.statisticsMap = statisticsMap;
    this.costModel = costModel || new DefaultCostModel();
    this.cardEstimator = cardEstimator || new DefaultCardinalityEstimator(this.statisticsMap);
  }

  get name() { return 'PhysicalDesign'; }

  apply(plan) {
    const rewriter = new PhysicalDesignRewriter(this.costModel, this.cardEstimator);
    return rewriter.rewrite(plan);
  }
}

class PhysicalDesignRewriter extends PlanRewriter {
  constructor(costModel, cardEstimator) {
    super();
    this.costModel = costModel;
    this.cardEstimator = cardEstimator;
  }

  rewriteDefault(node) {
    const newNode = this.rewriteChildren(node);
    newNode._cardinality = this.estimateNodeCardinality(newNode);
    newNode._sortedBy = this.inferSortOrder(newNode);

    return newNode;
  }

  rewriteJoin(node) {
    const newNode = this.rewriteChildren(node);
    newNode._cardinality = this.estimateNodeCardinality(newNode);

        const left = newNode.children[0];
    const right = newNode.children[1];

        if (newNode.joinType !== JoinType.CROSS && newNode.condition) {
      const joinKeys = this.extractEquiJoinKeys(newNode.condition);
      if (joinKeys.leftKeys.length > 0 && joinKeys.rightKeys.length > 0) {
        const leftSorted = this.isSortedBy(left._sortedBy, joinKeys.leftKeys);
        const rightSorted = this.isSortedBy(right._sortedBy, joinKeys.rightKeys);

        if (leftSorted && rightSorted) {
          const hashCost = this.costModel.hashJoinCost(left._cardinality, right._cardinality);
          const mergeCost = this.costModel.mergeJoinCost(left._cardinality, right._cardinality);

                    if (mergeCost <= hashCost) {
            newNode.physicalStrategy = PhysicalStrategy.MERGE;
            newNode._sortedBy = [...joinKeys.leftKeys, ...joinKeys.rightKeys];
            return newNode;
          }
        }
      }
    }

    if (newNode.joinType === JoinType.INNER) {
      const leftCard = left._cardinality || 1000;
      const rightCard = right._cardinality || 1000;
      newNode._buildSide = rightCard < leftCard ? 'right' : 'left';
    }

    if ((newNode.joinType === JoinType.SEMI || newNode.joinType === JoinType.ANTI || newNode.joinType === JoinType.MARK) && this.isPureEquiJoin(newNode.condition)) {
      newNode._dedupeBuild = true;
    }

    newNode.physicalStrategy = PhysicalStrategy.HASH;
    newNode._sortedBy = [];
    return newNode;
  }

  rewriteAggregate(node) {
    const newNode = this.rewriteChildren(node);
    newNode._cardinality = this.estimateNodeCardinality(newNode);

        const child = newNode.children[0];

        if (newNode.groupBy && newNode.groupBy.length > 0) {
      const groupKeys = newNode.groupBy.map(g => this.getColumnKey(g));
      const isSorted = this.isSortedByPrefix(child._sortedBy, groupKeys);

      if (isSorted) {
        const hashCost = this.costModel.hashAggregateCost(child._cardinality);
        const streamCost = this.costModel.streamAggregateCost(child._cardinality);

                if (streamCost <= hashCost) {
          newNode.physicalStrategy = PhysicalStrategy.STREAM;
          newNode._sortedBy = [...child._sortedBy];
          return newNode;
        }
      }
    }

    if (!newNode.groupBy || newNode.groupBy.length === 0) {
      newNode.physicalStrategy = PhysicalStrategy.UNGROUPED;
      newNode._sortedBy = [];
      return newNode;
    }

    if (this.canUsePerfectHashAggregate(newNode, child)) {
      newNode.physicalStrategy = PhysicalStrategy.PERFECT_HASH;
      newNode._sortedBy = [];
      return newNode;
    }

    newNode.physicalStrategy = PhysicalStrategy.HASH;
    newNode._sortedBy = [];
    return newNode;
  }

  rewriteSort(node) {
    const newNode = this.rewriteChildren(node);
    const childCard = newNode.children[0]._cardinality || 1000;

    if (newNode.limit) {
      newNode._cardinality = Math.min(newNode.limit, childCard);
      newNode._cost = this.costModel.topNSortCost(childCard, newNode.limit);
    } else {
      newNode._cardinality = childCard;
      newNode._cost = this.costModel.sortCost(childCard);
    }

    newNode._sortedBy = newNode.orderKeys.map(o => this.getColumnKey(o.expr)).filter(Boolean);
    return newNode;
  }

  inferSortOrder(node) {
    if (node.type === PlanNodeType.SORT) {
      return node.orderKeys.map(o => this.getColumnKey(o.expr)).filter(Boolean);
    }

        if (node.type === PlanNodeType.FILTER || node.type === PlanNodeType.PROJECT || node.type === PlanNodeType.LIMIT) {
      if (node.children && node.children.length > 0) {
        return node.children[0]._sortedBy || [];
      }
    }

        return [];
  }

  getColumnKey(expr) {
    if (!expr) return null;
    if (expr.kind === BoundExprKind.COLUMN_REF) {
      return `${expr.tableAlias || ''}.${expr.columnName}`.toUpperCase();
    }
    return null;
  }

  columnMatches(sortedKey, reqKey) {
    if (!sortedKey || !reqKey) return false;
    if (sortedKey === reqKey) return true;
    const sortedCol = sortedKey.split('.').pop();
    const reqCol = reqKey.split('.').pop();
    return sortedCol === reqCol;
  }

  isSortedBy(actualSortedKeys, requiredKeys) {
    if (!actualSortedKeys || actualSortedKeys.length === 0) return false;
    if (requiredKeys.length === 0) return false;

        for (let i = 0; i < requiredKeys.length; i++) {
      if (!this.columnMatches(actualSortedKeys[i], requiredKeys[i])) {
        return false;
      }
    }
    return true;
  }

  isSortedByPrefix(actualSortedKeys, requiredSet) {
    if (!actualSortedKeys || actualSortedKeys.length < requiredSet.length) return false;
    if (requiredSet.length === 0) return false;

    const prefix = actualSortedKeys.slice(0, requiredSet.length);
    for (const req of requiredSet) {
      if (!prefix.some(s => this.columnMatches(s, req))) return false;
    }
    return true;
  }

  estimateNodeCardinality(node) {
    if (node.type === PlanNodeType.SCAN) {
      return this.cardEstimator.estimateScan(node.table);
    }
    if (node.type === PlanNodeType.FILTER) {
      const childCard = node.children[0]._cardinality || 1000;
      return this.cardEstimator.estimateFilter(childCard, node.condition);
    }
    if (node.type === PlanNodeType.JOIN) {
      const leftCard = node.children[0]._cardinality || 1000;
      const rightCard = node.children[1]._cardinality || 1000;
      if (node.joinType === JoinType.SEMI) return this.cardEstimator.estimateSemiJoin(leftCard, rightCard, node.condition);
      if (node.joinType === JoinType.ANTI) return this.cardEstimator.estimateAntiJoin(leftCard, rightCard, node.condition);
      if (node.joinType === JoinType.MARK) return leftCard;
      if (node.joinType === JoinType.LEFT) {
        return this.cardEstimator.estimateLeftJoin
          ? this.cardEstimator.estimateLeftJoin(leftCard, rightCard, node.condition)
          : Math.max(leftCard, this.cardEstimator.estimateJoin(leftCard, rightCard, node.condition));
      }
      if (node.joinType === JoinType.CROSS) return leftCard * rightCard;
      return this.cardEstimator.estimateJoin(leftCard, rightCard, node.condition);
    }
    if (node.type === PlanNodeType.AGGREGATE) {
      const childCard = node.children[0]._cardinality || 1000;
      return this.cardEstimator.estimateAggregate(childCard, node.groupBy?.length || 0, node.groupBy || []);
    }
    if (node.type === PlanNodeType.LIMIT) {
      const childCard = node.children[0]._cardinality || 1000;
      return Math.min(node.count || childCard, childCard);
    }
    if (node.type === PlanNodeType.DISTINCT) {
      const childCard = node.children[0]._cardinality || 1000;
      return Math.max(1, Math.round(Math.sqrt(childCard)));
    }
    if (node.children && node.children.length > 0) {
      return node.children[0]._cardinality || 1000;
    }
    return 1000;
  }

  extractEquiJoinKeys(condition) {
    const leftKeys = [];
    const rightKeys = [];

        const preds = this.splitAnd(condition);
    for (const pred of preds) {
      if (pred.kind === BoundExprKind.BINARY && pred.op === '='
          && pred.left?.kind === BoundExprKind.COLUMN_REF
          && pred.right?.kind === BoundExprKind.COLUMN_REF) {

                leftKeys.push(this.getColumnKey(pred.left));
        rightKeys.push(this.getColumnKey(pred.right));
      }
    }

        return { leftKeys, rightKeys };
  }

  splitAnd(expr) {
    if (!expr) return [];
    if (expr.kind === BoundExprKind.BINARY && expr.op === 'AND') {
      return [...this.splitAnd(expr.left), ...this.splitAnd(expr.right)];
    }
    return [expr];
  }

  canUsePerfectHashAggregate(node, child) {
    if (!node.groupBy || node.groupBy.length === 0) return false;
    if (!node.groupBy.every(expr => expr.kind === BoundExprKind.COLUMN_REF)) return false;
    const keyStats = node.groupBy.map(expr => this.cardEstimator.getColumnStats?.(expr) || null);
    if (!keyStats.every(Boolean)) return false;
    let totalGroups = 1;
    for (const s of keyStats) {
      if (!s.ndv || s.ndv <= 0) return false;
      totalGroups *= s.ndv;
    }
    if (totalGroups > 256) return false;
    return keyStats.every(s => this.hasCompactDomain(s));
  }

  hasCompactDomain(stats) {
    const ndv = stats.ndv || 0;
    if (ndv <= 0 || ndv > 256) return false;
    const min = toNumber(stats.min);
    const max = toNumber(stats.max);
    if (min !== null && max !== null && Number.isInteger(min) && Number.isInteger(max)) {
      const domainSize = max - min + 1;
      return domainSize > 0 && domainSize <= 4096;
    }
    return ndv <= 4;
  }

  isPureEquiJoin(condition) {
    if (!condition) return false;
    const preds = this.splitAnd(condition);
    return preds.length > 0 && preds.every(pred =>
      pred.kind === BoundExprKind.BINARY
        && pred.op === '='
        && pred.left?.kind === BoundExprKind.COLUMN_REF
        && pred.right?.kind === BoundExprKind.COLUMN_REF
    );
  }
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return null;
}
