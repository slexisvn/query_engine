import { PlanNodeType, type LogicalPlanNode, type LogicalTopNNode } from './logical-plan.js';
import { PhysicalNodeType, type PhysicalOperatorNode } from '../execution/physical-plan.js';
import type { DefaultCostModel } from './cost-model.js';

export type RewriteMethod =
  | 'rewriteScan' | 'rewriteFilter' | 'rewriteProject' | 'rewriteJoin' | 'rewriteAggregate'
  | 'rewriteSort' | 'rewriteLimit' | 'rewriteDistinct' | 'rewriteSetOp' | 'rewriteCTEScan'
  | 'rewriteCTEAnchor' | 'rewriteDependentJoin' | 'rewriteMaterialize' | 'rewriteEmpty'
  | 'rewriteTopN' | 'rewriteIndexScan' | 'rewriteWindow' | 'rewriteExchange'
  | 'rewritePartialAggregate' | 'rewriteFinalAggregate' | 'rewriteMergeExchange'
  | 'rewriteExchangeReceive' | 'rewriteSingleRow';

export enum InputRequirement {
  ROW_LOCAL = 'ROW_LOCAL',
  PARTIAL_THEN_COMBINE = 'PARTIAL_THEN_COMBINE',
  COLOCATED_GROUPS = 'COLOCATED_GROUPS',
  GLOBAL = 'GLOBAL',
}

export enum PartitioningEffect {
  PRESERVES = 'PRESERVES',
  DESTROYS = 'DESTROYS',
}

export interface OperatorCapability {
  readonly input: InputRequirement;
  readonly output: PartitioningEffect;
}

export type OperatorCostRule = (
  costModel: DefaultCostModel,
  node: LogicalPlanNode,
  inputCardinality: number,
  cardinality: number,
) => number;

export interface PlanNodeDescriptor {
  readonly rewriteMethod: RewriteMethod | null;
  readonly physicalType: PhysicalOperatorNode['type'] | null;
  readonly cost: OperatorCostRule;
  readonly capability: OperatorCapability;
  readonly preservesSchema: boolean;
}

const LOCAL: OperatorCapability = { input: InputRequirement.ROW_LOCAL, output: PartitioningEffect.PRESERVES };
const COMBINED_ABOVE: OperatorCapability = { input: InputRequirement.PARTIAL_THEN_COMBINE, output: PartitioningEffect.DESTROYS };
const COLOCATED_GROUPS: OperatorCapability = { input: InputRequirement.COLOCATED_GROUPS, output: PartitioningEffect.DESTROYS };
const COORDINATOR_ONLY: OperatorCapability = { input: InputRequirement.GLOBAL, output: PartitioningEffect.DESTROYS };

const outputCardinalityCost: OperatorCostRule = (costModel, _node, _inputCardinality, cardinality) => costModel.scanCost(cardinality);
const inputFilterCost: OperatorCostRule = (costModel, _node, inputCardinality) => costModel.filterCost(inputCardinality);
const inputSortCost: OperatorCostRule = (costModel, _node, inputCardinality) => costModel.sortCost(inputCardinality);
const inputTopNCost: OperatorCostRule = (costModel, node, inputCardinality) => costModel.topNSortCost(inputCardinality, (node as LogicalTopNNode).count);
const inputHashAggregateCost: OperatorCostRule = (costModel, _node, inputCardinality) => costModel.hashAggregateCost(inputCardinality);

const PLAN_NODES: Record<PlanNodeType, PlanNodeDescriptor> = {
  [PlanNodeType.SCAN]: {
    rewriteMethod: 'rewriteScan',
    physicalType: PhysicalNodeType.TABLE_SCAN,
    cost: outputCardinalityCost,
    capability: LOCAL,
    preservesSchema: false,
  },
  [PlanNodeType.INDEX_SCAN]: {
    rewriteMethod: 'rewriteIndexScan',
    physicalType: PhysicalNodeType.INDEX_SCAN,
    cost: outputCardinalityCost,
    capability: LOCAL,
    preservesSchema: false,
  },
  [PlanNodeType.FILTER]: {
    rewriteMethod: 'rewriteFilter',
    physicalType: PhysicalNodeType.FILTER,
    cost: inputFilterCost,
    capability: LOCAL,
    preservesSchema: true,
  },
  [PlanNodeType.PROJECT]: {
    rewriteMethod: 'rewriteProject',
    physicalType: PhysicalNodeType.PROJECT,
    cost: outputCardinalityCost,
    capability: LOCAL,
    preservesSchema: false,
  },
  [PlanNodeType.EMPTY]: {
    rewriteMethod: 'rewriteEmpty',
    physicalType: PhysicalNodeType.EMPTY,
    cost: outputCardinalityCost,
    capability: LOCAL,
    preservesSchema: false,
  },
  [PlanNodeType.SINGLE_ROW]: {
    rewriteMethod: 'rewriteSingleRow',
    physicalType: PhysicalNodeType.SINGLE_ROW,
    cost: outputCardinalityCost,
    capability: LOCAL,
    preservesSchema: false,
  },
  [PlanNodeType.SORT]: {
    rewriteMethod: 'rewriteSort',
    physicalType: PhysicalNodeType.SORT,
    cost: inputSortCost,
    capability: COMBINED_ABOVE,
    preservesSchema: true,
  },
  [PlanNodeType.TOP_N]: {
    rewriteMethod: 'rewriteTopN',
    physicalType: PhysicalNodeType.TOP_N,
    cost: inputTopNCost,
    capability: COMBINED_ABOVE,
    preservesSchema: true,
  },
  [PlanNodeType.LIMIT]: {
    rewriteMethod: 'rewriteLimit',
    physicalType: PhysicalNodeType.LIMIT,
    cost: outputCardinalityCost,
    capability: COMBINED_ABOVE,
    preservesSchema: true,
  },
  [PlanNodeType.DISTINCT]: {
    rewriteMethod: 'rewriteDistinct',
    physicalType: PhysicalNodeType.DISTINCT,
    cost: inputHashAggregateCost,
    capability: COMBINED_ABOVE,
    preservesSchema: true,
  },
  [PlanNodeType.SET_OP]: {
    rewriteMethod: 'rewriteSetOp',
    physicalType: PhysicalNodeType.SET_OP,
    cost: outputCardinalityCost,
    capability: COMBINED_ABOVE,
    preservesSchema: true,
  },
  [PlanNodeType.AGGREGATE]: {
    rewriteMethod: 'rewriteAggregate',
    physicalType: null,
    cost: outputCardinalityCost,
    capability: COLOCATED_GROUPS,
    preservesSchema: false,
  },
  [PlanNodeType.JOIN]: {
    rewriteMethod: 'rewriteJoin',
    physicalType: null,
    cost: outputCardinalityCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.WINDOW]: {
    rewriteMethod: 'rewriteWindow',
    physicalType: PhysicalNodeType.WINDOW,
    cost: outputCardinalityCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.DEPENDENT_JOIN]: {
    rewriteMethod: 'rewriteDependentJoin',
    physicalType: PhysicalNodeType.DEPENDENT_JOIN,
    cost: outputCardinalityCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.CTE_ANCHOR]: {
    rewriteMethod: 'rewriteCTEAnchor',
    physicalType: PhysicalNodeType.CTE_ANCHOR,
    cost: outputCardinalityCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.CTE_SCAN]: {
    rewriteMethod: 'rewriteCTEScan',
    physicalType: PhysicalNodeType.CTE_SCAN,
    cost: outputCardinalityCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.MATERIALIZE]: {
    rewriteMethod: 'rewriteMaterialize',
    physicalType: PhysicalNodeType.MATERIALIZE,
    cost: outputCardinalityCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.EXCHANGE]: {
    rewriteMethod: 'rewriteExchange',
    physicalType: PhysicalNodeType.EXCHANGE,
    cost: outputCardinalityCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.MERGE_EXCHANGE]: {
    rewriteMethod: 'rewriteMergeExchange',
    physicalType: PhysicalNodeType.MERGE_EXCHANGE,
    cost: outputCardinalityCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.EXCHANGE_RECEIVE]: {
    rewriteMethod: 'rewriteExchangeReceive',
    physicalType: PhysicalNodeType.EXCHANGE_RECEIVE,
    cost: outputCardinalityCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.PARTIAL_AGGREGATE]: {
    rewriteMethod: 'rewritePartialAggregate',
    physicalType: PhysicalNodeType.PARTIAL_AGGREGATE,
    cost: outputCardinalityCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.FINAL_AGGREGATE]: {
    rewriteMethod: 'rewriteFinalAggregate',
    physicalType: PhysicalNodeType.FINAL_AGGREGATE,
    cost: outputCardinalityCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
};

const UNRECOGNIZED: PlanNodeDescriptor = {
  rewriteMethod: null,
  physicalType: null,
  cost: outputCardinalityCost,
  capability: COORDINATOR_ONLY,
  preservesSchema: false,
};

export function descriptorOf(type: PlanNodeType): PlanNodeDescriptor {
  return PLAN_NODES[type] ?? UNRECOGNIZED;
}
