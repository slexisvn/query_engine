import { OptimizationPass } from '../pass.js';
import { PlanNodeType, getChildren, setChildren, type LogicalPlanNode } from '../../planner/logical-plan.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class ProjectionPushdown extends OptimizationPass {
  get name() { return 'ProjectionPushdown'; }

  apply(plan: LogicalPlanNode): LogicalPlanNode {
    return pruneColumns(plan, null);
  }
}

function pruneColumns(node: any, required: Set<string> | null): any {
  if (!node) return node;

  switch (node.type) {
    case PlanNodeType.SCAN:
      return pruneScan(node, required);
    case PlanNodeType.PROJECT:
      return pruneProject(node, required);
    case PlanNodeType.FILTER:
      return pruneUnary(node, required ? addExprRefs(required, node.condition) : null);
    case PlanNodeType.JOIN:
      return pruneJoin(node, required);
    case PlanNodeType.AGGREGATE:
      return pruneAggregate(node);
    case PlanNodeType.SORT:
      return pruneSort(node, required);
    case PlanNodeType.LIMIT:
    case PlanNodeType.MATERIALIZE:
      return pruneUnary(node, required);
    case PlanNodeType.DEPENDENT_JOIN:
      return pruneDependentJoin(node, required);
    case PlanNodeType.UNION:
    case PlanNodeType.CTE_ANCHOR:
      return pruneChildren(node, null);
    case PlanNodeType.DISTINCT:
      return pruneUnary(node, null);
    default:
      return pruneChildren(node, required);
  }
}

function pruneScan(node: any, required: Set<string> | null): any {
  if (!required || required.size === 0) return node;
  const refs = collectPlanRefs(node);
  const neededCols = node.columns.filter((col: any) => refSetNeedsColumn(required, refs.aliases, col.name));
  if (neededCols.length > 0 && neededCols.length < node.columns.length) {
    return { ...node, columns: neededCols };
  }
  return node;
}

function pruneProject(node: any, required: Set<string> | null): any {
  const childRequired = new Set<string>();
  for (const [index, expr] of (node.expressions || []).entries()) {
    if (!required || outputNeeded(expr, required, index)) {
      collectExprColumns(expr, childRequired);
    }
  }
  const child = pruneColumns(node.children[0], childRequired);
  return child !== node.children[0] ? setChildren(node, [child]) : node;
}

function pruneAggregate(node: any): any {
  const childRequired = new Set<string>();
  for (const expr of node.groupBy || []) collectExprColumns(expr, childRequired);
  for (const agg of node.aggregates || []) {
    for (const arg of agg.args || []) collectExprColumns(arg, childRequired);
  }
  const child = pruneColumns(node.children[0], childRequired);
  return child !== node.children[0] ? setChildren(node, [child]) : node;
}

function pruneSort(node: any, required: Set<string> | null): any {
  if (!required) return pruneUnary(node, null);
  let childRequired = copyRefs(required);
  for (const key of node.orderKeys || []) childRequired = addExprRefs(childRequired, key.expr);
  return pruneUnary(node, childRequired);
}

function pruneJoin(node: any, required: Set<string> | null): any {
  const left = node.children[0];
  const right = node.children[1];

  if (!required) {
    const newLeft = pruneColumns(left, null);
    const newRight = pruneColumns(right, null);
    if (newLeft !== left || newRight !== right) return setChildren(node, [newLeft, newRight]);
    return node;
  }

  const leftRefs = collectPlanRefs(left);
  const rightRefs = collectPlanRefs(right);
  const refs = copyRefs(required);
  if (node.condition) collectExprColumns(node.condition, refs);

  const leftRequired = filterRefsForPlan(refs, leftRefs);
  const rightRequired = filterRefsForPlan(refs, rightRefs);
  const newLeft = pruneColumns(left, leftRequired);
  const newRight = pruneColumns(right, rightRequired);

  if (newLeft !== left || newRight !== right) return setChildren(node, [newLeft, newRight]);
  return node;
}

function pruneDependentJoin(node: any, required: Set<string> | null): any {
  const refs = copyRefs(required);
  if (node.condition) collectExprColumns(node.condition, refs);
  for (const expr of node.correlatedColumns || []) collectExprColumns(expr, refs);
  const children = node.children || [];
  if (children.length !== 2) return pruneChildren(node, refs);
  const newLeft = pruneColumns(children[0], refs);
  const newRight = pruneColumns(children[1], null);
  if (newLeft !== children[0] || newRight !== children[1]) return setChildren(node, [newLeft, newRight]);
  return node;
}

function pruneUnary(node: any, required: Set<string> | null): any {
  const child = pruneColumns(node.children?.[0], required);
  return child !== node.children?.[0] ? setChildren(node, [child]) : node;
}

function pruneChildren(node: any, required: Set<string> | null): any {
  const children = getChildren(node);
  const newChildren = children.map(child => pruneColumns(child, required));
  const changed = newChildren.some((child, i) => child !== children[i]);
  return changed ? setChildren(node, newChildren) : node;
}

function addExprRefs(required: Set<string>, expr: any): Set<string> {
  const refs = copyRefs(required);
  collectExprColumns(expr, refs);
  return refs;
}

function copyRefs(required: Set<string> | null): Set<string> {
  return required ? new Set(required) : new Set<string>();
}

function collectExprColumns(expr: any, required: Set<string>): void {
  if (!expr || typeof expr !== 'object') return;
  if (expr.kind === BoundExprKind.COLUMN_REF) {
    required.add(refKey(expr.tableAlias, expr.columnName));
    if (Number.isInteger(expr.columnIndex) && expr.columnIndex >= 0) {
      required.add(refKey(expr.tableAlias, `#${expr.columnIndex}`));
    }
    return;
  }
  for (const val of Object.values(expr)) {
    if (Array.isArray(val)) {
      for (const item of val) collectExprColumns(item, required);
    } else if (val && typeof val === 'object') {
      collectExprColumns(val, required);
    }
  }
}

function collectPlanRefs(node: any): { aliases: Set<string>; columns: Set<string> } {
  const refs = { aliases: new Set<string>(), columns: new Set<string>() };
  addOutputRefs(node, refs);
  refs.aliases.delete('');
  refs.columns.delete('');
  return refs;
}

function addOutputRefs(node: any, refs: { aliases: Set<string>; columns: Set<string> }): void {
  if (!node) return;
  if (node.type === PlanNodeType.SCAN) {
    refs.aliases.add((node.alias || node.table || '').toUpperCase());
    for (const col of node.columns || []) refs.columns.add((col.name || col.columnName || '').toUpperCase());
    return;
  }
  if (node.type === PlanNodeType.CTE_SCAN) {
    refs.aliases.add((node.alias || node.cteName || '').toUpperCase());
    return;
  }
  if (node.type === PlanNodeType.PROJECT) {
    for (const expr of node.expressions || []) refs.columns.add(outputName(expr));
    for (const child of getChildren(node)) addOutputRefs(child, refs);
    return;
  }
  if (node.type === PlanNodeType.AGGREGATE) {
    for (const expr of node.groupBy || []) refs.columns.add(outputName(expr));
    for (const agg of node.aggregates || []) refs.columns.add(outputName(agg));
    return;
  }
  if (node.type === PlanNodeType.JOIN || node.type === PlanNodeType.UNION) {
    for (const child of getChildren(node)) addOutputRefs(child, refs);
    return;
  }
  if (node.children?.[0]) addOutputRefs(node.children[0], refs);
}

function outputName(expr: any): string {
  return (expr?.outputName || expr?.alias || expr?.name || expr?.columnName || '').toUpperCase();
}

function outputNeeded(expr: any, required: Set<string>, index?: number): boolean {
  const name = outputName(expr);
  if (!name && index === undefined) return true;
  for (const ref of required) {
    const { columnName } = parseRef(ref);
    if (name && columnName === name) return true;
    if (index !== undefined && columnName === `#${index}`) return true;
  }
  return false;
}

function filterRefsForPlan(required: Set<string> | null, planRefs: { aliases: Set<string>; columns: Set<string> }): Set<string> {
  const result = new Set<string>();
  for (const ref of required || []) {
    const parsed = parseRef(ref);
    if (refBelongsToPlan(parsed, planRefs)) result.add(ref);
  }
  return result;
}

function refSetNeedsColumn(required: Set<string>, aliases: Set<string>, columnName: any): boolean {
  const col = (columnName || '').toUpperCase();
  for (const ref of required) {
    const parsed = parseRef(ref);
    if (parsed.columnName !== col) continue;
    if (!parsed.tableAlias || parsed.tableAlias === '.' || aliases.has(parsed.tableAlias)) return true;
  }
  return false;
}

function refBelongsToPlan(ref: { tableAlias: string; columnName: string }, planRefs: { aliases: Set<string>; columns: Set<string> }): boolean {
  if (ref.tableAlias && ref.tableAlias !== '.') return planRefs.aliases.has(ref.tableAlias);
  return planRefs.columns.has(ref.columnName);
}

function refKey(tableAlias: any, columnName: any): string {
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
