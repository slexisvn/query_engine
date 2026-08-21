import { PlanNodeType, LogicalExchange, getChildren, type LogicalPlanNode, type LogicalSortNode, type LogicalScanNode, type LogicalIndexScanNode, type LogicalExchangeNode } from '../../planner/logical-plan.js';
import { outputName } from '../../optimizer/passes/plan-refs.js';
import { BoundColumnRef, type BoundExpr } from '../../binder/expression-binder.js';
import { ExchangeType } from '../planner/fragment.js';
import type { DataType } from '../../storage/data-type.js';

export interface PartitionTableInfoLike {
  partitionCount: number;
}

export interface PartitionMapLike {
  getTableInfo(tableName: string): PartitionTableInfoLike | null;
}

interface TypedExpr {
  dataType?: DataType | null;
}

type PartitionedScanNode = LogicalScanNode | LogicalIndexScanNode;

const MULTISET_PRESERVING = new Set<PlanNodeType>([
  PlanNodeType.SCAN,
  PlanNodeType.INDEX_SCAN,
  PlanNodeType.FILTER,
  PlanNodeType.PROJECT,
  PlanNodeType.SORT,
]);

const ANY_NODE = (): boolean => true;

function preservesMultiset(node: LogicalPlanNode): boolean {
  if (!MULTISET_PRESERVING.has(node.type)) return false;
  return node.type !== PlanNodeType.SORT || (node as LogicalSortNode).limit == null;
}

function isPartitionedScan(node: LogicalPlanNode, partitionMap: PartitionMapLike): node is PartitionedScanNode {
  return (node.type === PlanNodeType.SCAN || node.type === PlanNodeType.INDEX_SCAN)
    && Boolean(partitionMap.getTableInfo(node.table));
}

function collectPartitionedScanTables(
  node: LogicalPlanNode,
  partitionMap: PartitionMapLike,
  traversable: (node: LogicalPlanNode) => boolean
): Set<string> | null {
  const tables = new Set<string>();
  const stack: LogicalPlanNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as LogicalPlanNode;
    if (!traversable(current)) return null;
    if (isPartitionedScan(current, partitionMap)) tables.add(current.table.toUpperCase());
    for (const child of getChildren(current)) stack.push(child);
  }
  return tables;
}

export function partitionedScanTables(node: LogicalPlanNode, partitionMap: PartitionMapLike | null): Set<string> {
  if (!partitionMap) return new Set();
  return collectPartitionedScanTables(node, partitionMap, ANY_NODE) as Set<string>;
}

export function localPartitionedScanTables(node: LogicalPlanNode, partitionMap: PartitionMapLike | null): Set<string> | null {
  if (!partitionMap) return null;
  return collectPartitionedScanTables(node, partitionMap, preservesMultiset);
}

export function shuffleKeysOf(node: LogicalPlanNode): BoundExpr[] {
  if (node.type !== PlanNodeType.PROJECT) return [];
  return node.expressions.map((expr, index) =>
    BoundColumnRef('', outputName(expr), index, (expr as TypedExpr).dataType ?? null));
}

export function hashShuffleExchange(keySource: LogicalPlanNode, input: LogicalPlanNode, cardinality: number | undefined): LogicalExchangeNode {
  const exchange = LogicalExchange(ExchangeType.HASH_SHUFFLE, shuffleKeysOf(keySource), 0, input);
  exchange._cardinality = cardinality;
  return exchange;
}
