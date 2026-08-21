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
  type PhysicalPlanNode,
  type SortRequirement,
} from './physical-plan.js';
import { descriptorOf } from '../planner/plan-node-descriptor.js';
import { DefaultCostModel } from '../planner/cost-model.js';
import { Config } from '../config.js';
import { chooseJoinBuildSide, isEquiJoinDedupable } from '../planner/join-build-side.js';
import { extractEquiJoinKeys, columnKeyOf, isSortedBy, isSortedByPrefix } from '../planner/sort-properties.js';
import { canUsePerfectHashAggregate, type AggregateStatsProvider } from '../planner/aggregate-strategy.js';
import { PlanPropertyAnnotator } from '../planner/plan-properties.js';
import type { BoundExpr } from '../binder/expression-binder.js';
import type { TableStats } from '../catalog/statistics.js';

const DEFAULT_CARDINALITY = 1000;

const NO_SORT_REQUIRED: SortRequirement = { left: false, right: false };

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

    return physicalOperator(physicalType, node, children, cardinalityOf(node), this.operatorCost(node, children));
  }

  planCostBased(node: LogicalPlanNode, children: PhysicalPlanNode[]): PhysicalPlanNode {
    if (node.type === PlanNodeType.JOIN) return this.planJoin(node, children);
    if (node.type === PlanNodeType.AGGREGATE) return this.planAggregate(node, children);
    throw new Error(`No physical operator for plan node: ${node.type}`);
  }

  operatorCost(node: LogicalPlanNode, children: PhysicalPlanNode[]): number {
    const cardinality = cardinalityOf(node);
    const inputCardinality = children[0]?.cardinality ?? cardinality;
    return descriptorOf(node.type).cost(this.costModel, node, inputCardinality, cardinality);
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
          : this.costModel.blockNestedLoopJoinCost(buildCardinality, probeCardinality, cardinality),
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
        this.costModel.nestedLoopJoinCost(buildCardinality, probeCardinality),
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
      this.costModel.mergeJoinCostWithSorts(leftCard, rightCard, leftSorted, rightSorted, cardinality),
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
