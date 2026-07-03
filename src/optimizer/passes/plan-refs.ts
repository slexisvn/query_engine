import { PlanNodeType, getChildren, type LogicalPlanNode } from '../../planner/logical-plan.js';
import { type BoundExpr } from '../../binder/expression-binder.js';

export interface PlanRefs { aliases: Set<string>; columns: Set<string>; }

export interface ExprRef { tableAlias: string; columnName: string; }

export interface NamedExpr { outputName?: string; alias?: string; name?: string; columnName?: string; }

export interface CollectPlanRefsOptions { recurseProject?: boolean; dottedAlias?: boolean; }

function outputName(expr: BoundExpr | NamedExpr): string {
  const named = expr as NamedExpr;
  return (named?.outputName || named?.alias || named?.name || named?.columnName || '').toUpperCase();
}

export function addOutputRefs(node: LogicalPlanNode, refs: PlanRefs, options: CollectPlanRefsOptions = {}): void {
  if (!node) return;
  if (node.type === PlanNodeType.SCAN) {
    refs.aliases.add((node.alias || node.table || '').toUpperCase());
    for (const col of node.columns || []) {
      refs.columns.add((col.name || (col as { columnName?: string }).columnName || '').toUpperCase());
    }
    return;
  }
  if (node.type === PlanNodeType.CTE_SCAN) {
    refs.aliases.add(((node as { alias?: string }).alias || node.cteName || '').toUpperCase());
    return;
  }
  if (node.type === PlanNodeType.PROJECT) {
    for (const expr of node.expressions || []) refs.columns.add(outputName(expr as NamedExpr));
    if (options.recurseProject) {
      for (const child of getChildren(node)) addOutputRefs(child, refs, options);
    }
    return;
  }
  if (node.type === PlanNodeType.AGGREGATE) {
    for (const expr of node.groupBy || []) refs.columns.add(outputName(expr as NamedExpr));
    for (const agg of node.aggregates || []) refs.columns.add(outputName(agg as NamedExpr));
    return;
  }
  if (node.type === PlanNodeType.JOIN || node.type === PlanNodeType.UNION) {
    for (const child of getChildren(node)) addOutputRefs(child, refs, options);
    return;
  }
  if (node.children?.[0]) addOutputRefs(node.children[0], refs, options);
}

export function collectPlanRefs(node: LogicalPlanNode, options: CollectPlanRefsOptions = {}): PlanRefs {
  const refs: PlanRefs = { aliases: new Set<string>(), columns: new Set<string>() };
  addOutputRefs(node, refs, options);
  refs.aliases.delete('');
  refs.columns.delete('');
  return refs;
}

export function refBelongsToPlan(ref: ExprRef, planRefs: PlanRefs, options: CollectPlanRefsOptions = {}): boolean {
  if (options.dottedAlias) {
    if (ref.tableAlias && ref.tableAlias !== '.') return planRefs.aliases.has(ref.tableAlias);
    return planRefs.columns.has(ref.columnName);
  }
  if (ref.tableAlias) return planRefs.aliases.has(ref.tableAlias);
  return planRefs.columns.has(ref.columnName);
}
