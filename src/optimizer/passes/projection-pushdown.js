import { OptimizationPass } from '../pass.js';
import { PlanNodeType, getChildren, setChildren } from '../../planner/logical-plan.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class ProjectionPushdown extends OptimizationPass {
  get name() { return 'ProjectionPushdown'; }

  apply(plan) {
    return pruneColumns(plan, null);
  }
}

function pruneColumns(node, required) {
  if (!node) return node;

  switch (node.type) {
    case PlanNodeType.SCAN:
      return pruneScan(node, required);
    case PlanNodeType.PROJECT:
      return pruneProject(node, required);
    case PlanNodeType.FILTER:
      return pruneUnary(node, addExprRefs(required, node.condition));
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
      return pruneUnary(node, required);
    default:
      return pruneChildren(node, required);
  }
}

function pruneScan(node, required) {
  if (!required || required.size === 0) return node;
  const refs = collectPlanRefs(node);
  const neededCols = node.columns.filter(col => refSetNeedsColumn(required, refs.aliases, col.name));
  if (neededCols.length > 0 && neededCols.length < node.columns.length) {
    return { ...node, columns: neededCols };
  }
  return node;
}

function pruneProject(node, required) {
  const childRequired = new Set();
  for (const [index, expr] of (node.expressions || []).entries()) {
    if (!required || outputNeeded(expr, required, index)) {
      collectExprColumns(expr, childRequired);
    }
  }
  const child = pruneColumns(node.children[0], childRequired);
  return child !== node.children[0] ? setChildren(node, [child]) : node;
}

function pruneAggregate(node) {
  const childRequired = new Set();
  for (const expr of node.groupBy || []) collectExprColumns(expr, childRequired);
  for (const agg of node.aggregates || []) {
    for (const arg of agg.args || []) collectExprColumns(arg, childRequired);
  }
  const child = pruneColumns(node.children[0], childRequired);
  return child !== node.children[0] ? setChildren(node, [child]) : node;
}

function pruneSort(node, required) {
  let childRequired = copyRefs(required);
  for (const key of node.orderKeys || []) childRequired = addExprRefs(childRequired, key.expr);
  if (!required && childRequired.size === 0) return pruneUnary(node, null);
  return pruneUnary(node, childRequired.size > 0 ? childRequired : null);
}

function pruneJoin(node, required) {
  const left = node.children[0];
  const right = node.children[1];
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

function pruneDependentJoin(node, required) {
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

function pruneUnary(node, required) {
  const child = pruneColumns(node.children?.[0], required);
  return child !== node.children?.[0] ? setChildren(node, [child]) : node;
}

function pruneChildren(node, required) {
  const children = getChildren(node);
  const newChildren = children.map(child => pruneColumns(child, required));
  const changed = newChildren.some((child, i) => child !== children[i]);
  return changed ? setChildren(node, newChildren) : node;
}

function addExprRefs(required, expr) {
  const refs = copyRefs(required);
  collectExprColumns(expr, refs);
  return refs;
}

function copyRefs(required) {
  return required ? new Set(required) : new Set();
}

function collectExprColumns(expr, required) {
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

function collectPlanRefs(node) {
  const refs = { aliases: new Set(), columns: new Set() };
  addOutputRefs(node, refs);
  refs.aliases.delete('');
  refs.columns.delete('');
  return refs;
}

function addOutputRefs(node, refs) {
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

function outputName(expr) {
  return (expr?.outputName || expr?.alias || expr?.name || expr?.columnName || '').toUpperCase();
}

function outputNeeded(expr, required, index) {
  const name = outputName(expr);
  if (!name && index === undefined) return true;
  for (const ref of required) {
    const { columnName } = parseRef(ref);
    if (name && columnName === name) return true;
    if (index !== undefined && columnName === `#${index}`) return true;
  }
  return false;
}

function filterRefsForPlan(required, planRefs) {
  const result = new Set();
  for (const ref of required || []) {
    const parsed = parseRef(ref);
    if (refBelongsToPlan(parsed, planRefs)) result.add(ref);
  }
  return result;
}

function refSetNeedsColumn(required, aliases, columnName) {
  const col = (columnName || '').toUpperCase();
  for (const ref of required) {
    const parsed = parseRef(ref);
    if (parsed.columnName !== col) continue;
    if (!parsed.tableAlias || parsed.tableAlias === '.' || aliases.has(parsed.tableAlias)) return true;
  }
  return false;
}

function refBelongsToPlan(ref, planRefs) {
  if (ref.tableAlias && ref.tableAlias !== '.') return planRefs.aliases.has(ref.tableAlias);
  return planRefs.columns.has(ref.columnName);
}

function refKey(tableAlias, columnName) {
  return `${(tableAlias || '').toUpperCase()}.${(columnName || '').toUpperCase()}`;
}

function parseRef(ref) {
  const dot = ref.indexOf('.');
  if (dot < 0) return { tableAlias: '', columnName: ref.toUpperCase() };
  return {
    tableAlias: ref.slice(0, dot).toUpperCase(),
    columnName: ref.slice(dot + 1).toUpperCase(),
  };
}
