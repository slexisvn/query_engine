import {
  PlanNodeType,
  JoinType,
  type LogicalPlanNode,
  type LogicalJoinNode,
  type LogicalAggregateNode,
} from '../planner/logical-plan.js';
import {
  PhysicalNodeType,
  physicalJoin,
  physicalOperator,
  type JoinBuildSide,
  type PhysicalOperatorNode,
  type PhysicalPlanNode,
  type SortRequirement,
} from './physical-plan.js';
import { DefaultCostModel } from '../optimizer/join-order/cost-model.js';
import { Config } from '../config.js';
import { chooseJoinBuildSide, isEquiJoinDedupable } from '../optimizer/join-build-side.js';
import { extractEquiJoinKeys, columnKeyOf, isSortedBy, isSortedByPrefix } from '../optimizer/sort-properties.js';
import { canUsePerfectHashAggregate, type AggregateStatsProvider } from '../optimizer/aggregate-strategy.js';
import type { BoundExpr } from '../binder/expression-binder.js';
import type { TableStats } from '../catalog/statistics.js';

const DEFAULT_CARDINALITY = 1000;

const PASS_THROUGH_TYPES: Partial<Record<PlanNodeType, PhysicalOperatorNode['type']>> = {
  [PlanNodeType.SCAN]: PhysicalNodeType.TABLE_SCAN,
  [PlanNodeType.INDEX_SCAN]: PhysicalNodeType.INDEX_SCAN,
  [PlanNodeType.SINGLE_ROW]: PhysicalNodeType.SINGLE_ROW,
  [PlanNodeType.EMPTY]: PhysicalNodeType.EMPTY,
  [PlanNodeType.FILTER]: PhysicalNodeType.FILTER,
  [PlanNodeType.PROJECT]: PhysicalNodeType.PROJECT,
  [PlanNodeType.SORT]: PhysicalNodeType.SORT,
  [PlanNodeType.TOP_N]: PhysicalNodeType.TOP_N,
  [PlanNodeType.LIMIT]: PhysicalNodeType.LIMIT,
  [PlanNodeType.DISTINCT]: PhysicalNodeType.DISTINCT,
  [PlanNodeType.UNION]: PhysicalNodeType.UNION,
  [PlanNodeType.WINDOW]: PhysicalNodeType.WINDOW,
  [PlanNodeType.MATERIALIZE]: PhysicalNodeType.MATERIALIZE,
  [PlanNodeType.CTE_ANCHOR]: PhysicalNodeType.CTE_ANCHOR,
  [PlanNodeType.CTE_SCAN]: PhysicalNodeType.CTE_SCAN,
  [PlanNodeType.DEPENDENT_JOIN]: PhysicalNodeType.DEPENDENT_JOIN,
  [PlanNodeType.EXCHANGE]: PhysicalNodeType.EXCHANGE,
  [PlanNodeType.MERGE_EXCHANGE]: PhysicalNodeType.MERGE_EXCHANGE,
  [PlanNodeType.EXCHANGE_RECEIVE]: PhysicalNodeType.EXCHANGE_RECEIVE,
  [PlanNodeType.PARTIAL_AGGREGATE]: PhysicalNodeType.PARTIAL_AGGREGATE,
  [PlanNodeType.FINAL_AGGREGATE]: PhysicalNodeType.FINAL_AGGREGATE,
};

const NO_SORT_REQUIRED: SortRequirement = { left: false, right: false };

export class PhysicalPlanner {
  costModel: DefaultCostModel;
  statistics: AggregateStatsProvider;

  constructor(statistics: Map<string, TableStats> = new Map(), costModel: DefaultCostModel | null = null) {
    this.statistics = statistics;
    this.costModel = costModel ?? new DefaultCostModel();
  }

  plan(node: LogicalPlanNode): PhysicalPlanNode {
    const children = (node.children ?? []).map((child) => this.plan(child));

    if (node.type === PlanNodeType.JOIN) return this.planJoin(node, children);
    if (node.type === PlanNodeType.AGGREGATE) return this.planAggregate(node, children);

    const physicalType = PASS_THROUGH_TYPES[node.type];
    if (!physicalType) throw new Error(`No physical operator for plan node: ${node.type}`);

    return physicalOperator(physicalType, node, children, cardinalityOf(node), this.operatorCost(node, children));
  }

  operatorCost(node: LogicalPlanNode, children: PhysicalPlanNode[]): number {
    const inputCard = children[0]?.cardinality ?? cardinalityOf(node);
    switch (node.type) {
      case PlanNodeType.SCAN:
      case PlanNodeType.INDEX_SCAN:
        return this.costModel.scanCost(cardinalityOf(node));
      case PlanNodeType.FILTER:
        return this.costModel.filterCost(inputCard);
      case PlanNodeType.SORT:
        return this.costModel.sortCost(inputCard);
      case PlanNodeType.TOP_N:
        return this.costModel.topNSortCost(inputCard, node.count);
      case PlanNodeType.DISTINCT:
        return this.costModel.hashAggregateCost(inputCard);
      default:
        return this.costModel.scanCost(cardinalityOf(node));
    }
  }

  planJoin(node: LogicalJoinNode, children: PhysicalPlanNode[]): PhysicalPlanNode {
    return cheapest(this.joinCandidates(node, children));
  }

  joinCandidates(node: LogicalJoinNode, children: PhysicalPlanNode[]): PhysicalPlanNode[] {
    const leftCard = cardinalityOf(node.children[0]);
    const rightCard = cardinalityOf(node.children[1]);
    const cardinality = cardinalityOf(node);
    const buildSide = chooseJoinBuildSide(node.joinType, leftCard, rightCard);
    const buildCardinality = buildSide === 'left' ? leftCard : rightCard;
    const probeCardinality = buildSide === 'left' ? rightCard : leftCard;

    const candidates: PhysicalPlanNode[] = [
      physicalJoin(
        PhysicalNodeType.HASH_JOIN,
        node,
        children,
        cardinality,
        this.costModel.hashJoinCost(buildCardinality, probeCardinality, cardinality),
        buildSide,
        isEquiJoinDedupable(node.joinType, node.condition),
        NO_SORT_REQUIRED,
        runtimeFilterEntries(node.joinType, buildCardinality),
      ),
      physicalJoin(
        PhysicalNodeType.NESTED_LOOP_JOIN,
        node,
        children,
        cardinality,
        this.costModel.nestedLoopJoinCost(buildCardinality, probeCardinality),
        buildSide,
        false,
        NO_SORT_REQUIRED,
      ),
    ];

    const merge = this.mergeJoinCandidate(node, children, leftCard, rightCard, cardinality, buildSide);
    if (merge) candidates.push(merge);

    return candidates;
  }

  mergeJoinCandidate(
    node: LogicalJoinNode,
    children: PhysicalPlanNode[],
    leftCard: number,
    rightCard: number,
    cardinality: number,
    buildSide: JoinBuildSide,
  ): PhysicalPlanNode | null {
    if (node.joinType === JoinType.CROSS || !node.condition) return null;

    const joinKeys = extractEquiJoinKeys(node.condition);
    if (joinKeys.leftKeys.length === 0 || joinKeys.rightKeys.length === 0) return null;

    const leftSorted = isSortedBy(node.children[0]._sortedBy, joinKeys.leftKeys);
    const rightSorted = isSortedBy(node.children[1]._sortedBy, joinKeys.rightKeys);
    const comparison = this.costModel.cheaperJoinCost(leftCard, rightCard, leftSorted, rightSorted, cardinality, 0);

    return physicalJoin(
      PhysicalNodeType.MERGE_JOIN,
      node,
      children,
      cardinality,
      comparison.mergeCost,
      buildSide,
      false,
      { left: !leftSorted, right: !rightSorted },
    );
  }

  planAggregate(node: LogicalAggregateNode, children: PhysicalPlanNode[]): PhysicalPlanNode {
    return cheapest(this.aggregateCandidates(node, children));
  }

  aggregateCandidates(node: LogicalAggregateNode, children: PhysicalPlanNode[]): PhysicalPlanNode[] {
    const child = node.children[0];
    const childCard = cardinalityOf(child);
    const cardinality = cardinalityOf(node);

    if (!node.groupBy || node.groupBy.length === 0) {
      return [physicalOperator(PhysicalNodeType.UNGROUPED_AGGREGATE, node, children, cardinality, this.costModel.streamAggregateCost(childCard))];
    }

    const hashCost = this.costModel.hashAggregateCost(childCard, cardinality);
    const candidates: PhysicalPlanNode[] = [
      physicalOperator(PhysicalNodeType.HASH_AGGREGATE, node, children, cardinality, hashCost),
    ];

    const groupKeys = node.groupBy.map((expr: BoundExpr) => columnKeyOf(expr));
    if (isSortedByPrefix(child._sortedBy, groupKeys)) {
      candidates.push(physicalOperator(
        PhysicalNodeType.STREAM_AGGREGATE,
        node,
        children,
        cardinality,
        this.costModel.streamAggregateCost(childCard),
      ));
    }

    if (canUsePerfectHashAggregate(node, child, this.statistics)) {
      candidates.push(physicalOperator(
        PhysicalNodeType.PERFECT_HASH_AGGREGATE,
        node,
        children,
        cardinality,
        hashCost * Config.perfectHashAggregateCostFactor,
      ));
    }

    return candidates;
  }
}

export function cheapest(candidates: PhysicalPlanNode[]): PhysicalPlanNode {
  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.cost < best.cost) best = candidate;
  }
  return best;
}

const RUNTIME_FILTER_JOINS: ReadonlySet<JoinType> = new Set([JoinType.INNER, JoinType.SEMI]);

function runtimeFilterEntries(joinType: JoinType, buildCardinality: number): number {
  if (!RUNTIME_FILTER_JOINS.has(joinType)) return 0;
  if (buildCardinality < Config.joinRuntimeFilterMinRows) return 0;
  return Math.min(buildCardinality, Config.joinRuntimeFilterCapacity);
}

function cardinalityOf(node: LogicalPlanNode): number {
  return node._cardinality ?? DEFAULT_CARDINALITY;
}
