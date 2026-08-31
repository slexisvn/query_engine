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
import { DefaultCostModel, sortKeyClassOf, type SortKeyClass } from '../planner/cost-model.js';
import { Config } from '../config.js';
import { chooseJoinBuildSide, isEquiJoinDedupable } from '../planner/join-build-side.js';
import { extractEquiJoinKeys, equiJoinKeyTypes, columnKeyOf, isSortedBy, isSortedByPrefix, satisfiesOrder, selectsRows } from '../planner/sort-properties.js';
import { canUsePerfectHashAggregate, type AggregateStatsProvider } from '../planner/aggregate-strategy.js';
import { PlanPropertyAnnotator } from '../planner/plan-properties.js';
import { getExprType, type BoundExpr } from '../binder/expression-binder.js';
import type { TableStats } from '../catalog/statistics.js';

const DEFAULT_CARDINALITY = 1000;

const NO_SORT_REQUIRED: SortRequirement = { left: false, right: false };

type RequiredOrder = readonly LogicalOrderKey[] | null;

const ORDER_PRESERVING_TYPES: ReadonlySet<PhysicalNodeType> = new Set([
  PhysicalNodeType.FILTER,
  PhysicalNodeType.PROJECT,
  PhysicalNodeType.LIMIT,
]);

const ORDER_PRESERVING_LOGICAL_TYPES: ReadonlySet<PlanNodeType> = new Set([
  PlanNodeType.FILTER,
  PlanNodeType.PROJECT,
  PlanNodeType.LIMIT,
]);

function requiredOrderFor(node: LogicalPlanNode, inherited: RequiredOrder): RequiredOrder {
  if (node.type === PlanNodeType.SORT || node.type === PlanNodeType.TOP_N) return node.orderKeys;
  return ORDER_PRESERVING_LOGICAL_TYPES.has(node.type) ? inherited : null;
}

function orderKeyClassOf(required: readonly LogicalOrderKey[]): SortKeyClass {
  return sortKeyClassOf(required.map(key => getExprType(key.expr)));
}

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
    return this.planNode(this.planProperties.annotate(node), null);
  }

  planNode(node: LogicalPlanNode, required: RequiredOrder = null): PhysicalPlanNode {
    const childRequired = requiredOrderFor(node, required);
    const children = (node.children ?? []).map((child) => this.planNode(child, childRequired));
    const physicalType = descriptorOf(node.type).physicalType;

    if (physicalType === null) return this.planCostBased(node, children, required);

    const satisfied = this.planSatisfiedOrder(node, children);
    if (satisfied) return satisfied;

    return physicalOperator(physicalType, node, children, cardinalityOf(node), this.operatorCost(node, children));
  }

  planCostBased(node: LogicalPlanNode, children: PhysicalPlanNode[], required: RequiredOrder): PhysicalPlanNode {
    if (node.type === PlanNodeType.JOIN) return this.planJoin(node, children, required);
    if (node.type === PlanNodeType.AGGREGATE) return this.planAggregate(node, children, required);
    throw new Error(`No physical operator for plan node: ${node.type}`);
  }

  residualSortCost(candidate: PhysicalPlanNode, required: RequiredOrder): number {
    if (!required || required.length === 0) return 0;
    if (providedSortOrders(candidate).some(order => satisfiesOrder(order, required))) return 0;
    return this.costModel.sortCost(candidate.cardinality, orderKeyClassOf(required));
  }

  cheapestFor(candidates: PhysicalPlanNode[], required: RequiredOrder): PhysicalPlanNode {
    let best = candidates[0];
    let bestCost = best.cost + this.residualSortCost(best, required);
    for (const candidate of candidates) {
      const effective = candidate.cost + this.residualSortCost(candidate, required);
      if (effective < bestCost) {
        best = candidate;
        bestCost = effective;
      }
    }
    return best;
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
    const cost = descriptorOf(costType).cost;
    if (cost === null) throw new Error(`No cost rule for plan node: ${costType}`);
    const cardinality = cardinalityOf(node);
    const inputCardinalities = children.length > 0 ? children.map(child => child.cardinality) : [cardinality];
    return cost(this.costModel, node, inputCardinalities, cardinality);
  }

  planJoin(node: LogicalJoinNode, children: PhysicalPlanNode[], required: RequiredOrder = null): PhysicalPlanNode {
    return this.cheapestFor(this.joinCandidates(node, children), required);
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

  planAggregate(node: LogicalAggregateNode, children: PhysicalPlanNode[], required: RequiredOrder = null): PhysicalPlanNode {
    return this.cheapestFor(this.aggregateCandidates(node, children), required);
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
        this.costModel.perfectHashAggregateCost(childCard, cardinality),
      ));
    }

    return candidates;
  }
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
