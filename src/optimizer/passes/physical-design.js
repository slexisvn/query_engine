import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, PhysicalStrategy, getChildren, setChildren } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { DefaultCostModel } from '../dphyp/cost-model.js';
import { DefaultCardinalityEstimator } from '../dphyp/cardinality.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

const DEFAULT_CARDINALITY = 1000;

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
    this.parentMap = null;
  }

  rewrite(plan) {
    this.parentMap = buildParentMap(plan);
    return super.rewrite(plan);
  }

  rewriteDefault(node) {
    const newNode = this.rewriteChildren(node);
    newNode._cardinality = this.estimateNodeCardinality(newNode);
    newNode._sortedBy = this.inferSortOrder(newNode);

    return newNode;
  }

  rewriteJoin(node) {
    const originalNode = node;
    const newNode = this.rewriteChildren(node);
    newNode._cardinality = this.estimateNodeCardinality(newNode);

    const left = newNode.children[0];
    const right = newNode.children[1];
    const leftCard = left._cardinality || DEFAULT_CARDINALITY;
    const rightCard = right._cardinality || DEFAULT_CARDINALITY;

    if (newNode.joinType !== JoinType.CROSS && newNode.condition) {
      const joinKeys = this.extractEquiJoinKeys(newNode.condition);
      if (joinKeys.leftKeys.length > 0 && joinKeys.rightKeys.length > 0) {
        const leftSorted = this.isSortedBy(left._sortedBy, joinKeys.leftKeys);
        const rightSorted = this.isSortedBy(right._sortedBy, joinKeys.rightKeys);

        const downstreamSortSaving = this.estimateDownstreamSortSaving(
          originalNode, joinKeys.leftKeys, joinKeys.rightKeys, newNode._cardinality
        );

        const comparison = this.costModel.cheaperJoinCost(
          leftCard, rightCard, leftSorted, rightSorted, newNode._cardinality, downstreamSortSaving
        );

        if (comparison.preferMerge) {
          newNode.physicalStrategy = PhysicalStrategy.MERGE;
          newNode._sortedBy = [...joinKeys.leftKeys, ...joinKeys.rightKeys];
          newNode._requiresSort = { left: !leftSorted, right: !rightSorted };
          this.assignBuildSide(newNode, leftCard, rightCard);
          return newNode;
        }
      }
    }

    this.assignBuildSide(newNode, leftCard, rightCard);
    const outerCard = newNode._buildSide === 'left' ? leftCard : rightCard;
    const innerCard = newNode._buildSide === 'left' ? rightCard : leftCard;
    const nlCost = this.costModel.nestedLoopJoinCost(outerCard, innerCard);
    const hashCost = this.costModel.hashJoinCost(outerCard, innerCard, newNode._cardinality);
    if (nlCost < hashCost) {
      newNode.physicalStrategy = PhysicalStrategy.NESTED_LOOP;
      newNode._sortedBy = [];
      return newNode;
    }

    if (this.isSpecialJoinType(newNode.joinType) && this.isPureEquiJoin(newNode.condition)) {
      newNode._dedupeBuild = true;
    }

    this.assignBuildSide(newNode, leftCard, rightCard);
    newNode.physicalStrategy = PhysicalStrategy.HASH;
    newNode._sortedBy = [];
    return newNode;
  }

  assignBuildSide(node, leftCard, rightCard) {
    switch (node.joinType) {
      case JoinType.LEFT:
      case JoinType.SEMI:
      case JoinType.ANTI:
      case JoinType.MARK:
        node._buildSide = 'right';
        break;
      case JoinType.RIGHT:
        node._buildSide = 'left';
        break;
      case JoinType.INNER:
        node._buildSide = rightCard < leftCard ? 'right' : 'left';
        break;
    }
  }

  isSpecialJoinType(joinType) {
    return joinType === JoinType.SEMI
      || joinType === JoinType.ANTI
      || joinType === JoinType.MARK;
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
    const childCard = newNode.children[0]._cardinality || DEFAULT_CARDINALITY;

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

    if (node.type === PlanNodeType.INDEX_SCAN) {
      const key = `${(node.alias || node.table || '').toUpperCase()}.${(node.columnName || '').toUpperCase()}`;
      return [key];
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
    if (node.type === PlanNodeType.SCAN || node.type === PlanNodeType.INDEX_SCAN) {
      return this.cardEstimator.estimateScan(node.table);
    }
    if (node.type === PlanNodeType.FILTER) {
      const childCard = node.children[0]._cardinality || DEFAULT_CARDINALITY;
      return this.cardEstimator.estimateFilter(childCard, node.condition);
    }
    if (node.type === PlanNodeType.JOIN) {
      const leftCard = node.children[0]._cardinality || DEFAULT_CARDINALITY;
      const rightCard = node.children[1]._cardinality || DEFAULT_CARDINALITY;
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
      const childCard = node.children[0]._cardinality || DEFAULT_CARDINALITY;
      return this.cardEstimator.estimateAggregate(childCard, node.groupBy?.length || 0, node.groupBy || []);
    }
    if (node.type === PlanNodeType.LIMIT) {
      const childCard = node.children[0]._cardinality || DEFAULT_CARDINALITY;
      return Math.min(node.count || childCard, childCard);
    }
    if (node.type === PlanNodeType.DISTINCT) {
      const childCard = node.children[0]._cardinality || DEFAULT_CARDINALITY;
      return Math.max(1, Math.round(Math.sqrt(childCard)));
    }
    if (node.children && node.children.length > 0) {
      return node.children[0]._cardinality || DEFAULT_CARDINALITY;
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

  estimateDownstreamSortSaving(originalNode, leftKeys, rightKeys, cardinality) {
    const parent = this.parentMap?.get(originalNode);
    if (!parent) return 0;

    const sortNode = this.findDownstreamSort(parent, originalNode);
    if (!sortNode || !sortNode.orderKeys) return 0;

    const sortKeys = sortNode.orderKeys.map(o => this.getColumnKey(o.expr)).filter(Boolean);
    if (sortKeys.length === 0) return 0;

    const mergeOutputKeys = [...leftKeys, ...rightKeys];
    if (!this.isSortedByPrefix(mergeOutputKeys, sortKeys)) return 0;

    const card = cardinality || DEFAULT_CARDINALITY;
    return sortNode.limit
      ? this.costModel.topNSortCost(card, sortNode.limit)
      : this.costModel.sortCost(card);
  }

  findDownstreamSort(node, from) {
    if (!node) return null;
    if (node.type === PlanNodeType.SORT) return node;
    if (node.type === PlanNodeType.PROJECT || node.type === PlanNodeType.FILTER
      || node.type === PlanNodeType.LIMIT) {
      const parent = this.parentMap?.get(node);
      return parent ? this.findDownstreamSort(parent, node) : null;
    }
    return null;
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

function buildParentMap(root) {
  const map = new Map();
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node.children) {
      for (const child of node.children) {
        map.set(child, node);
        queue.push(child);
      }
    }
  }
  return map;
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return null;
}
