import {
  PlanNodeType,
  JoinType,
  type LogicalPlanNode,
  type LogicalJoinNode,
  type LogicalAggregateNode,
  type LogicalOrderKey,
  type SortedByEntry,
} from '../planner/logical-plan.js';
import {
  PhysicalNodeType,
  physicalJoin,
  physicalOperator,
  type JoinBuildSide,
  type PhysicalPlanNode,
  type SortRequirement,
} from './physical-plan.js';
import { descriptorOf } from '../planner/plan-node-descriptor.js';
import { DefaultCostModel, sortKeyClassOf } from '../planner/cost-model.js';
import { Config } from '../config.js';
import { chooseJoinBuildSide, isEquiJoinDedupable } from '../planner/join-build-side.js';
import { extractEquiJoinKeys, equiJoinKeyTypes, columnKeyOf, isSortedBy, isSortedByPrefix, satisfiesOrder, selectsRows } from '../planner/sort-properties.js';
import { canUsePerfectHashAggregate, type AggregateStatsProvider } from '../planner/aggregate-strategy.js';
import { PlanPropertyAnnotator } from '../planner/plan-properties.js';
import type { BoundExpr } from '../binder/expression-binder.js';
import type { TableStats } from '../catalog/statistics.js';

const DEFAULT_CARDINALITY = 1000;

const NO_SORT_REQUIRED: SortRequirement = { left: false, right: false };

const ORDER_PRESERVING_TYPES: ReadonlySet<PhysicalNodeType> = new Set([
  PhysicalNodeType.FILTER,
  PhysicalNodeType.PROJECT,
  PhysicalNodeType.LIMIT,
]);

function ascendingOrder(keys: readonly string[]): SortedByEntry[] {
  return keys.map(key => ({ key, direction: 'ASC' }));
}

function mergeJoinOutputOrders(logical: LogicalJoinNode): SortedByEntry[][] {
  if (logical.joinType !== JoinType.INNER) return [];

  const { leftKeys, rightKeys } = extractEquiJoinKeys(logical.condition);
  if (leftKeys.length === 0) return [];

  return [ascendingOrder(leftKeys), ascendingOrder(rightKeys)];
}

function providedSortOrders(node: PhysicalPlanNode): SortedByEntry[][] {
  if (node.type === PhysicalNodeType.MERGE_JOIN) return mergeJoinOutputOrders(node.logical);

  if (ORDER_PRESERVING_TYPES.has(node.type) && node.children.length > 0) {
    return providedSortOrders(node.children[0]);
  }

  const annotated = node.logical._sortedBy;
  return annotated && annotated.length > 0 ? [annotated] : [];
}

function orderAlreadyProvided(orderKeys: readonly LogicalOrderKey[], child: PhysicalPlanNode | undefined): boolean {
  if (!child) return false;
  return providedSortOrders(child).some(order => satisfiesOrder(order, orderKeys));
}

function groupOrderAlreadyProvided(groupKeys: (string | null)[], child: PhysicalPlanNode | undefined): boolean {
  if (!child) return false;
  return providedSortOrders(child).some(order => isSortedByPrefix(order, groupKeys));
}

export class PhysicalPlanner {
  costModel: DefaultCostModel;
  statistics: AggregateStatsProvider;
  planProperties: PlanPropertyAnnotator;

  constructor(statistics: Map<string, TableStats> = new Map(), costModel: DefaultCostModel | null = null) {
    this.statistics = statistics;
    this.costModel = costModel ?? new DefaultCostModel();
    this.planProperties = new PlanPropertyAnnotator(statistics);
  }

  plan(node: LogicalPlanNode): PhysicalPlanNode {
    return this.planNode(this.planProperties.annotate(node));
  }

  planNode(node: LogicalPlanNode): PhysicalPlanNode {
    const children = (node.children ?? []).map((child) => this.planNode(child));
    const physicalType = descriptorOf(node.type).physicalType;

    if (physicalType === null) return this.planCostBased(node, children);

    const satisfied = this.planSatisfiedOrder(node, children);
    if (satisfied) return satisfied;

    return physicalOperator(physicalType, node, children, cardinalityOf(node), this.operatorCost(node, children));
  }

  planCostBased(node: LogicalPlanNode, children: PhysicalPlanNode[]): PhysicalPlanNode {
    if (node.type === PlanNodeType.JOIN) return this.planJoin(node, children);
    if (node.type === PlanNodeType.AGGREGATE) return this.planAggregate(node, children);
    throw new Error(`No physical operator for plan node: ${node.type}`);
  }

  planSatisfiedOrder(node: LogicalPlanNode, children: PhysicalPlanNode[]): PhysicalPlanNode | null {
    if (node.type === PlanNodeType.SORT) {
      if (selectsRows(node) || !orderAlreadyProvided(node.orderKeys, children[0])) return null;
      return children[0];
    }

    if (node.type === PlanNodeType.TOP_N && orderAlreadyProvided(node.orderKeys, children[0])) {
      return physicalOperator(
        PhysicalNodeType.LIMIT,
        node,
        children,
        cardinalityOf(node),
        this.operatorCost(node, children, PlanNodeType.LIMIT),
      );
    }

    return null;
  }

  operatorCost(node: LogicalPlanNode, children: PhysicalPlanNode[], costType: PlanNodeType = node.type): number {
    const cardinality = cardinalityOf(node);
    const inputCardinality = children[0]?.cardinality ?? cardinality;
    return descriptorOf(costType).cost(this.costModel, node, inputCardinality, cardinality);
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

    const equiKeys = extractEquiJoinKeys(node.condition);
    const hasEquiKeys = equiKeys.leftKeys.length > 0 && equiKeys.rightKeys.length > 0;

    const candidates: PhysicalPlanNode[] = [
      physicalJoin(
        PhysicalNodeType.HASH_JOIN,
        node,
        children,
        cardinality,
        hasEquiKeys
          ? this.costModel.hashJoinCost(buildCardinality, probeCardinality, cardinality)
          : this.costModel.hashBuildCost(buildCardinality)
            + this.costModel.blockNestedLoopJoinCost(buildCardinality, probeCardinality, cardinality),
        buildSide,
        isEquiJoinDedupable(node.joinType, node.condition),
        NO_SORT_REQUIRED,
        runtimeFilterEntries(node.joinType, buildCardinality),
      ),
    ];

    if (leftCard + rightCard <= Config.nestedLoopMaxRows) {
      candidates.push(physicalJoin(
        PhysicalNodeType.NESTED_LOOP_JOIN,
        node,
        children,
        cardinality,
        this.costModel.blockNestedLoopJoinCost(buildCardinality, probeCardinality, cardinality),
        buildSide,
        false,
        NO_SORT_REQUIRED,
      ));
    }

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

    return physicalJoin(
      PhysicalNodeType.MERGE_JOIN,
      node,
      children,
      cardinality,
      this.costModel.mergeJoinCostWithSorts(
        leftCard,
        rightCard,
        leftSorted,
        rightSorted,
        cardinality,
        sortKeyClassOf(equiJoinKeyTypes(node.condition)),
      ),
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
    if (groupOrderAlreadyProvided(groupKeys, children[0])) {
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
