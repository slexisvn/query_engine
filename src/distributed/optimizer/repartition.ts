import { PlanNodeType, getChildren, type LogicalPlanNode, type LogicalSortNode } from '../../planner/logical-plan.js';
import { outputName } from '../../optimizer/passes/plan-refs.js';
import { BoundColumnRef, type BoundExpr } from '../../binder/expression-binder.js';
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

export function partitionedScanTables(node: LogicalPlanNode, partitionMap: PartitionMapLike | null): Set<string> {
  const tables = new Set<string>();
  if (!partitionMap) return tables;

  const stack: LogicalPlanNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as LogicalPlanNode;
    if ((current.type === PlanNodeType.SCAN || current.type === PlanNodeType.INDEX_SCAN)
      && partitionMap.getTableInfo(current.table)) {
      tables.add(current.table.toUpperCase());
    }
    for (const child of getChildren(current)) stack.push(child);
  }
  return tables;
}

export function shuffleKeysOf(node: LogicalPlanNode): BoundExpr[] {
  if (node.type !== PlanNodeType.PROJECT) return [];
  return node.expressions.map((expr, index) =>
    BoundColumnRef('', outputName(expr), index, (expr as TypedExpr).dataType ?? null));
}

const MULTISET_PRESERVING = new Set<PlanNodeType>([
  PlanNodeType.SCAN,
  PlanNodeType.INDEX_SCAN,
  PlanNodeType.FILTER,
  PlanNodeType.PROJECT,
  PlanNodeType.SORT,
]);

function preservesMultiset(node: LogicalPlanNode): boolean {
  if (!MULTISET_PRESERVING.has(node.type)) return false;
  return node.type !== PlanNodeType.SORT || (node as LogicalSortNode).limit == null;
}

export function localPartitionedScanTables(node: LogicalPlanNode, partitionMap: PartitionMapLike | null): Set<string> | null {
  if (!partitionMap) return null;

  const tables = new Set<string>();
  const stack: LogicalPlanNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as LogicalPlanNode;
    if (!preservesMultiset(current)) return null;
    if ((current.type === PlanNodeType.SCAN || current.type === PlanNodeType.INDEX_SCAN)
      && partitionMap.getTableInfo(current.table)) {
      tables.add(current.table.toUpperCase());
    }
    for (const child of getChildren(current)) stack.push(child);
  }
  return tables;
}
