import { OptimizationPass } from '../pass.js';
import { getChildren, setChildren, type LogicalPlanNode, type ProjectedExpr, type LogicalScanNode, type LogicalProjectNode, type LogicalFilterNode, type LogicalJoinNode, type LogicalAggregateNode, type LogicalSortNode, type LogicalTopNNode, type LogicalDependentJoinNode, type LogicalSetOpNode, type LogicalCTEAnchorNode, type LogicalDistinctNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { BoundExprKind, type BoundExpr } from '../../binder/expression-binder.js';
import type { ColumnInfo } from '../../binder/scope.js';
import { collectPlanRefs as collectPlanRefsShared, refBelongsToPlan as refBelongsToPlanShared, outputName, type NamedExpr, type PlanRefs } from './plan-refs.js';

function collectPlanRefs(node: LogicalPlanNode): PlanRefs {
  return collectPlanRefsShared(node, { recurseProject: true });
}

function refBelongsToPlan(ref: { tableAlias: string; columnName: string }, planRefs: PlanRefs): boolean {
  return refBelongsToPlanShared(ref, planRefs, { dottedAlias: true });
}

type ExprChild = BoundExpr | BoundExpr[] | string | number | boolean | bigint | null | undefined | object;

type RequiredColumns = Set<string> | null;

export class ProjectionPushdown extends OptimizationPass {
  override get name() { return 'ProjectionPushdown'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    return new ColumnPruner().rewrite(plan, null);
  }
}

class ColumnPruner extends PlanRewriter<RequiredColumns> {
  override rewriteScan(node: LogicalScanNode, required: RequiredColumns = null): LogicalPlanNode {
    return pruneScan(node, required);
  }

  override rewriteProject(node: LogicalProjectNode, required: RequiredColumns = null): LogicalPlanNode {
    return pruneProject(this, node, required);
  }

  override rewriteFilter(node: LogicalFilterNode, required: RequiredColumns = null): LogicalPlanNode {
    return this.rewriteChildren(node, required ? addExprRefs(required, node.condition) : null);
  }

  override rewriteJoin(node: LogicalJoinNode, required: RequiredColumns = null): LogicalPlanNode {
    return pruneJoin(this, node, required);
  }

  override rewriteAggregate(node: LogicalAggregateNode): LogicalPlanNode {
    return pruneAggregate(this, node);
  }

  override rewriteSort(node: LogicalSortNode, required: RequiredColumns = null): LogicalPlanNode {
    return pruneSort(this, node, required);
  }

  override rewriteTopN(node: LogicalTopNNode, required: RequiredColumns = null): LogicalPlanNode {
    return pruneSort(this, node, required);
  }

  override rewriteDependentJoin(node: LogicalDependentJoinNode, required: RequiredColumns = null): LogicalPlanNode {
    return pruneDependentJoin(this, node, required);
  }

  override rewriteSetOp(node: LogicalSetOpNode): LogicalPlanNode {
    return this.rewriteChildren(node, null);
  }

  override rewriteCTEAnchor(node: LogicalCTEAnchorNode): LogicalPlanNode {
    return this.rewriteChildren(node, null);
  }

  override rewriteDistinct(node: LogicalDistinctNode): LogicalPlanNode {
    return this.rewriteChildren(node, null);
  }
}

function pruneScan(node: LogicalScanNode, required: RequiredColumns): LogicalPlanNode {
  if (!required || required.size === 0) return node;
  const refs = collectPlanRefs(node);
  const neededCols = node.columns.filter((col) => refSetNeedsColumn(required, refs.aliases, col.name));
  if (neededCols.length > 0 && neededCols.length < node.columns.length) {
    return { ...node, columns: neededCols };
  }
  return node;
}

function pruneProject(pruner: ColumnPruner, node: LogicalProjectNode, required: RequiredColumns): LogicalPlanNode {
  const expressions = node.expressions || [];
  const kept = required
    ? expressions.filter((expr, index) => outputNeeded(expr, required, index))
    : expressions;
  const emitted = kept.length > 0 && kept.length < expressions.length ? kept : expressions;

  const childRequired = new Set<string>();
  for (const expr of emitted) collectExprColumns(expr, childRequired);

  const pruned = emitted === expressions ? node : { ...node, expressions: emitted };
  return pruner.rewriteChildren(pruned, childRequired);
}

function pruneAggregate(pruner: ColumnPruner, node: LogicalAggregateNode): LogicalPlanNode {
  const childRequired = new Set<string>();
  for (const expr of node.groupBy || []) collectExprColumns(expr, childRequired);
  for (const agg of node.aggregates || []) {
    for (const arg of (agg as { args?: BoundExpr[] }).args || []) collectExprColumns(arg, childRequired);
  }
  return pruner.rewriteChildren(node, childRequired);
}

function pruneSort(pruner: ColumnPruner, node: LogicalSortNode | LogicalTopNNode, required: RequiredColumns): LogicalPlanNode {
  if (!required) return pruner.rewriteChildren(node, null);
  let childRequired = copyRefs(required);
  for (const key of node.orderKeys || []) childRequired = addExprRefs(childRequired, key.expr);
  return pruner.rewriteChildren(node, childRequired);
}

function pruneJoin(pruner: ColumnPruner, node: LogicalJoinNode, required: RequiredColumns): LogicalPlanNode {
  if (!required) return rewriteSides(pruner, node, null, null);

  const refs = copyRefs(required);
  if (node.condition) collectExprColumns(node.condition, refs);

  const [left, right] = node.children;
  return rewriteSides(
    pruner,
    node,
    filterRefsForPlan(refs, collectPlanRefs(left)),
    filterRefsForPlan(refs, collectPlanRefs(right)),
  );
}

function pruneDependentJoin(pruner: ColumnPruner, node: LogicalDependentJoinNode, required: RequiredColumns): LogicalPlanNode {
  const refs = copyRefs(required);
  if (node.condition) collectExprColumns(node.condition, refs);
  for (const expr of node.correlatedColumns || []) collectExprColumns(expr, refs);

  if (getChildren(node).length !== 2) return pruner.rewriteChildren(node, refs);
  return rewriteSides(pruner, node, refs, null);
}

function rewriteSides(
  pruner: ColumnPruner,
  node: LogicalPlanNode,
  leftRequired: RequiredColumns,
  rightRequired: RequiredColumns,
): LogicalPlanNode {
  const [left, right] = getChildren(node);
  const newLeft = pruner.rewrite(left, leftRequired);
  const newRight = pruner.rewrite(right, rightRequired);
  return newLeft !== left || newRight !== right ? setChildren(node, [newLeft, newRight]) : node;
}

function addExprRefs(required: Set<string>, expr: BoundExpr | null): Set<string> {
  const refs = copyRefs(required);
  collectExprColumns(expr, refs);
  return refs;
}

function copyRefs(required: Set<string> | null): Set<string> {
  return required ? new Set(required) : new Set<string>();
}

function collectExprColumns(expr: ExprChild, required: Set<string>): void {
  if (!expr || typeof expr !== 'object') return;
  const node = expr as BoundExpr;
  if (node.kind === BoundExprKind.COLUMN_REF) {
    required.add(refKey(node.tableAlias, node.columnName));
    if (Number.isInteger(node.columnIndex) && node.columnIndex >= 0) {
      required.add(refKey(node.tableAlias, `#${node.columnIndex}`));
    }
    return;
  }
  for (const val of Object.values(expr as Record<string, ExprChild>)) {
    if (Array.isArray(val)) {
      for (const item of val) collectExprColumns(item, required);
    } else if (val && typeof val === 'object') {
      collectExprColumns(val, required);
    }
  }
}

function outputNeeded(expr: BoundExpr | NamedExpr, required: Set<string>, index?: number): boolean {
  const name = outputName(expr);
  if (!name && index === undefined) return true;
  for (const ref of required) {
    const { columnName } = parseRef(ref);
    if (name && columnName === name) return true;
    if (index !== undefined && columnName === `#${index}`) return true;
  }
  return false;
}

function filterRefsForPlan(required: Set<string> | null, planRefs: PlanRefs): Set<string> {
  const result = new Set<string>();
  for (const ref of required || []) {
    const parsed = parseRef(ref);
    if (refBelongsToPlan(parsed, planRefs)) result.add(ref);
  }
  return result;
}

function refSetNeedsColumn(required: Set<string>, aliases: Set<string>, columnName: string | null): boolean {
  const col = (columnName || '').toUpperCase();
  for (const ref of required) {
    const parsed = parseRef(ref);
    if (parsed.columnName !== col) continue;
    if (!parsed.tableAlias || parsed.tableAlias === '.' || aliases.has(parsed.tableAlias)) return true;
  }
  return false;
}

function refKey(tableAlias: string | null, columnName: string | null): string {
  return `${(tableAlias || '').toUpperCase()}.${(columnName || '').toUpperCase()}`;
}

function parseRef(ref: string): { tableAlias: string; columnName: string } {
  const dot = ref.indexOf('.');
  if (dot < 0) return { tableAlias: '', columnName: ref.toUpperCase() };
  return {
    tableAlias: ref.slice(0, dot).toUpperCase(),
    columnName: ref.slice(dot + 1).toUpperCase(),
  };
}
