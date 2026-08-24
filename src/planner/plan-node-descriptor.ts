import {
  ExchangeType, PlanNodeType, SetOpType,
  type LogicalPlanNode, type LogicalExchangeNode, type LogicalMergeExchangeNode,
  type LogicalSetOpNode, type LogicalSortNode, type LogicalTopNNode, type LogicalWindowNode,
} from './logical-plan.js';
import { PhysicalNodeType, type PhysicalOperatorNode } from '../execution/physical-plan.js';
import { sortKeyClassOf, type DefaultCostModel } from './cost-model.js';
import { orderKeyTypes } from './sort-properties.js';
import type { BoundWindowNode } from '../binder/expression-binder.js';
import { Config } from '../config.js';

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
  inputCardinalities: readonly number[],
  cardinality: number,
) => number;

export interface PlanNodeDescriptor {
  readonly rewriteMethod: RewriteMethod | null;
  readonly physicalType: PhysicalOperatorNode['type'] | null;
  readonly cost: OperatorCostRule | null;
  readonly capability: OperatorCapability;
  readonly preservesSchema: boolean;
}

const LOCAL: OperatorCapability = { input: InputRequirement.ROW_LOCAL, output: PartitioningEffect.PRESERVES };
const COMBINED_ABOVE: OperatorCapability = { input: InputRequirement.PARTIAL_THEN_COMBINE, output: PartitioningEffect.DESTROYS };
const COLOCATED_GROUPS: OperatorCapability = { input: InputRequirement.COLOCATED_GROUPS, output: PartitioningEffect.DESTROYS };
const COORDINATOR_ONLY: OperatorCapability = { input: InputRequirement.GLOBAL, output: PartitioningEffect.DESTROYS };

const outputCardinalityCost: OperatorCostRule = (costModel, _node, _inputCardinalities, cardinality) => costModel.scanCost(cardinality);
const inputScanCost: OperatorCostRule = (costModel, _node, inputCardinalities) => costModel.scanCost(inputCardinalities[0]);
const inputFilterCost: OperatorCostRule = (costModel, _node, inputCardinalities) => costModel.filterCost(inputCardinalities[0]);
const inputBufferCost: OperatorCostRule = (costModel, _node, inputCardinalities) => costModel.bufferCost(inputCardinalities[0]);
const outputRowCopyCost: OperatorCostRule = (costModel, _node, _inputCardinalities, cardinality) => costModel.rowCopyCost(cardinality);
const inputSortCost: OperatorCostRule = (costModel, node, inputCardinalities) =>
  costModel.sortCost(inputCardinalities[0], sortKeyClassOf(orderKeyTypes((node as LogicalSortNode).orderKeys)));
const inputTopNCost: OperatorCostRule = (costModel, node, inputCardinalities) =>
  costModel.topNSortCost(inputCardinalities[0], (node as LogicalTopNNode).count, sortKeyClassOf(orderKeyTypes((node as LogicalTopNNode).orderKeys)));
const inputHashAggregateCost: OperatorCostRule = (costModel, _node, inputCardinalities) => costModel.hashAggregateCost(inputCardinalities[0]);

const inputWindowCost: OperatorCostRule = (costModel, node, inputCardinalities) => {
  const inputCardinality = inputCardinalities[0];
  const windows = (node as LogicalWindowNode).windowExprs as BoundWindowNode[];
  const partitioning = windows.some(window => window.partitionBy.length > 0)
    ? costModel.hashBuildCost(inputCardinality)
    : 0;
  const ordering = windows.reduce((total, window) => total + (window.orderBy.length > 0
    ? costModel.sortCost(inputCardinality, sortKeyClassOf(orderKeyTypes(window.orderBy)))
    : 0), 0);
  return costModel.bufferCost(inputCardinality) + partitioning + ordering;
};

const setOpCost: OperatorCostRule = (costModel, node, inputCardinalities, cardinality) => {
  const [leftCardinality, rightCardinality] = inputCardinalities;
  if ((node as LogicalSetOpNode).op === SetOpType.UNION) {
    return (node as LogicalSetOpNode).all
      ? costModel.scanCost(leftCardinality + rightCardinality)
      : costModel.hashAggregateCost(leftCardinality + rightCardinality, cardinality);
  }
  return costModel.hashBuildCost(rightCardinality)
    + costModel.bufferCost(leftCardinality)
    + costModel.hashProbeCost(leftCardinality);
};

const dependentJoinCost: OperatorCostRule = (costModel, _node, inputCardinalities, cardinality) =>
  costModel.blockNestedLoopJoinCost(inputCardinalities[1], inputCardinalities[0], cardinality);

const exchangeCost: OperatorCostRule = (costModel, node, inputCardinalities) => {
  const exchange = node as LogicalExchangeNode;
  const fanout = exchange.exchangeType === ExchangeType.BROADCAST ? Math.max(1, exchange.partitionCount) : 1;
  return costModel.rowCopyCost(inputCardinalities[0] * fanout);
};

const mergeExchangeCost: OperatorCostRule = (costModel, node, _inputCardinalities, cardinality) =>
  costModel.rowCopyCost(cardinality)
  + costModel.mergeStreamsCost(
    cardinality,
    Config.defaultPartitionCount,
    sortKeyClassOf(orderKeyTypes((node as LogicalMergeExchangeNode).orderKeys)),
  );

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
    cost: inputScanCost,
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
    cost: setOpCost,
    capability: COMBINED_ABOVE,
    preservesSchema: true,
  },
  [PlanNodeType.AGGREGATE]: {
    rewriteMethod: 'rewriteAggregate',
    physicalType: null,
    cost: null,
    capability: COLOCATED_GROUPS,
    preservesSchema: false,
  },
  [PlanNodeType.JOIN]: {
    rewriteMethod: 'rewriteJoin',
    physicalType: null,
    cost: null,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.WINDOW]: {
    rewriteMethod: 'rewriteWindow',
    physicalType: PhysicalNodeType.WINDOW,
    cost: inputWindowCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.DEPENDENT_JOIN]: {
    rewriteMethod: 'rewriteDependentJoin',
    physicalType: PhysicalNodeType.DEPENDENT_JOIN,
    cost: dependentJoinCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.CTE_ANCHOR]: {
    rewriteMethod: 'rewriteCTEAnchor',
    physicalType: PhysicalNodeType.CTE_ANCHOR,
    cost: inputBufferCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.CTE_SCAN]: {
    rewriteMethod: 'rewriteCTEScan',
    physicalType: PhysicalNodeType.CTE_SCAN,
    cost: outputRowCopyCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.MATERIALIZE]: {
    rewriteMethod: 'rewriteMaterialize',
    physicalType: PhysicalNodeType.MATERIALIZE,
    cost: inputBufferCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.EXCHANGE]: {
    rewriteMethod: 'rewriteExchange',
    physicalType: PhysicalNodeType.EXCHANGE,
    cost: exchangeCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.MERGE_EXCHANGE]: {
    rewriteMethod: 'rewriteMergeExchange',
    physicalType: PhysicalNodeType.MERGE_EXCHANGE,
    cost: mergeExchangeCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.EXCHANGE_RECEIVE]: {
    rewriteMethod: 'rewriteExchangeReceive',
    physicalType: PhysicalNodeType.EXCHANGE_RECEIVE,
    cost: outputRowCopyCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.PARTIAL_AGGREGATE]: {
    rewriteMethod: 'rewritePartialAggregate',
    physicalType: PhysicalNodeType.PARTIAL_AGGREGATE,
    cost: inputHashAggregateCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
  [PlanNodeType.FINAL_AGGREGATE]: {
    rewriteMethod: 'rewriteFinalAggregate',
    physicalType: PhysicalNodeType.FINAL_AGGREGATE,
    cost: inputHashAggregateCost,
    capability: COORDINATOR_ONLY,
    preservesSchema: false,
  },
};

const UNRECOGNIZED: PlanNodeDescriptor = {
  rewriteMethod: null,
  physicalType: null,
  cost: null,
  capability: COORDINATOR_ONLY,
  preservesSchema: false,
};

export function descriptorOf(type: PlanNodeType): PlanNodeDescriptor {
  return PLAN_NODES[type] ?? UNRECOGNIZED;
}
