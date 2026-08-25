import type { LogicalPlanNode, LogicalJoinNode, LogicalAggregateNode } from '../planner/logical-plan.js';

export enum PhysicalNodeType {
  TABLE_SCAN = 'TableScan',
  INDEX_SCAN = 'IndexScan',
  SINGLE_ROW = 'SingleRow',
  EMPTY = 'Empty',

  FILTER = 'Filter',
  PROJECT = 'Project',
  SORT = 'Sort',
  TOP_N = 'TopN',
  LIMIT = 'Limit',
  DISTINCT = 'Distinct',
  SET_OP = 'SetOp',
  WINDOW = 'Window',
  MATERIALIZE = 'Materialize',

  HASH_JOIN = 'HashJoin',
  MERGE_JOIN = 'MergeJoin',
  NESTED_LOOP_JOIN = 'NestedLoopJoin',

  HASH_AGGREGATE = 'HashAggregate',
  STREAM_AGGREGATE = 'StreamAggregate',
  UNGROUPED_AGGREGATE = 'UngroupedAggregate',
  PERFECT_HASH_AGGREGATE = 'PerfectHashAggregate',
  PARTIAL_AGGREGATE = 'PartialAggregate',
  FINAL_AGGREGATE = 'FinalAggregate',

  CTE_ANCHOR = 'CTEAnchor',
  CTE_SCAN = 'CTEScan',
  DEPENDENT_JOIN = 'DependentJoin',

  EXCHANGE = 'Exchange',
  MERGE_EXCHANGE = 'MergeExchange',
  EXCHANGE_RECEIVE = 'ExchangeReceive',
}

export type JoinBuildSide = 'left' | 'right';

export interface SortRequirement {
  left: boolean;
  right: boolean;
}

interface PhysicalNodeBase {
  type: PhysicalNodeType;
  children: PhysicalPlanNode[];
  cardinality: number;
  cost: number;
}

export interface PhysicalOperatorNode extends PhysicalNodeBase {
  type: Exclude<PhysicalNodeType, PhysicalNodeType.HASH_JOIN | PhysicalNodeType.MERGE_JOIN | PhysicalNodeType.NESTED_LOOP_JOIN>;
  logical: LogicalPlanNode;
}

export interface PhysicalJoinNode extends PhysicalNodeBase {
  type: PhysicalNodeType.HASH_JOIN | PhysicalNodeType.MERGE_JOIN | PhysicalNodeType.NESTED_LOOP_JOIN;
  logical: LogicalJoinNode;
  buildSide: JoinBuildSide;
  dedupeBuild: boolean;
  requiresSort: SortRequirement;
  runtimeFilterEntries: number;
}

export type PhysicalPlanNode = PhysicalOperatorNode | PhysicalJoinNode;

export const AGGREGATE_NODE_TYPES: ReadonlySet<PhysicalNodeType> = new Set([
  PhysicalNodeType.HASH_AGGREGATE,
  PhysicalNodeType.STREAM_AGGREGATE,
  PhysicalNodeType.UNGROUPED_AGGREGATE,
  PhysicalNodeType.PERFECT_HASH_AGGREGATE,
]);

export const JOIN_NODE_TYPES: ReadonlySet<PhysicalNodeType> = new Set([
  PhysicalNodeType.HASH_JOIN,
  PhysicalNodeType.MERGE_JOIN,
  PhysicalNodeType.NESTED_LOOP_JOIN,
]);

export function physicalOperator(
  type: PhysicalOperatorNode['type'],
  logical: LogicalPlanNode,
  children: PhysicalPlanNode[],
  cardinality: number,
  cost: number,
): PhysicalOperatorNode {
  return { type, logical, children, cardinality, cost };
}

export function physicalJoin(
  type: PhysicalJoinNode['type'],
  logical: LogicalJoinNode,
  children: PhysicalPlanNode[],
  cardinality: number,
  cost: number,
  buildSide: JoinBuildSide,
  dedupeBuild: boolean,
  requiresSort: SortRequirement,
  runtimeFilterEntries: number = 0,
): PhysicalJoinNode {
  return { type, logical, children, cardinality, cost, buildSide, dedupeBuild, requiresSort, runtimeFilterEntries };
}

export function isPhysicalJoin(node: PhysicalPlanNode): node is PhysicalJoinNode {
  return JOIN_NODE_TYPES.has(node.type);
}

export function isPhysicalAggregate(node: PhysicalPlanNode): boolean {
  return AGGREGATE_NODE_TYPES.has(node.type);
}

export function aggregateLogical(node: PhysicalPlanNode): LogicalAggregateNode {
  return node.logical as LogicalAggregateNode;
}

export function totalPhysicalCost(node: PhysicalPlanNode): number {
  // An empty node keeps its child only to borrow a schema from it; that subtree never runs.
  if (node.type === PhysicalNodeType.EMPTY) return node.cost;

  // A dependent join re-runs its inner side once per outer row, so that subtree is not paid for once.
  if (node.type === PhysicalNodeType.DEPENDENT_JOIN && node.children.length === 2) {
    const [outer, inner] = node.children;
    return node.cost + totalPhysicalCost(outer) + Math.max(1, outer.cardinality) * totalPhysicalCost(inner);
  }

  let total = node.cost;
  for (const child of node.children) total += totalPhysicalCost(child);
  return total;
}

export function physicalPlanToString(node: PhysicalPlanNode, indent: number = 0): string {
  const prefix = '  '.repeat(indent);
  let text = `${prefix}${node.type}`;
  if (isPhysicalJoin(node)) {
    text += `(${node.logical.joinType}, build=${node.buildSide}`;
    if (node.dedupeBuild) text += ', dedupeBuild';
    if (node.runtimeFilterEntries > 0) text += ', runtimeFilter';
    if (node.requiresSort.left || node.requiresSort.right) {
      text += `, sort=${node.requiresSort.left ? 'L' : ''}${node.requiresSort.right ? 'R' : ''}`;
    }
    text += ')';
  }
  text += `\n`;
  for (const child of node.children) text += physicalPlanToString(child, indent + 1);
  return text;
}
