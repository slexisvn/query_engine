import { PlanNodeType, getChildren, type LogicalPlanNode } from '../../planner/logical-plan.js';
import { type BoundExpr } from '../../binder/expression-binder.js';

export interface PlanRefs { aliases: Set<string>; columns: Set<string>; }

export interface ExprRef { tableAlias: string; columnName: string; }

export interface NamedExpr { outputName?: string; alias?: string; name?: string; columnName?: string; }

export interface CollectPlanRefsOptions { recurseProject?: boolean; dottedAlias?: boolean; }

const DIRECT_REFS = new WeakMap<LogicalPlanNode, PlanRefs>();
const PROJECT_RECURSIVE_REFS = new WeakMap<LogicalPlanNode, PlanRefs>();

const EMPTY_REFS: PlanRefs = { aliases: new Set<string>(), columns: new Set<string>() };

export function outputName(expr: BoundExpr | NamedExpr): string {
  const named = expr as NamedExpr;
  return (named?.outputName || named?.alias || named?.name || named?.columnName || '').toUpperCase();
}

function add(into: Set<string>, value: string | null | undefined): void {
  if (value) into.add(value);
}

function emptyRefs(): PlanRefs {
  return { aliases: new Set<string>(), columns: new Set<string>() };
}

function mergeInto(target: PlanRefs, source: PlanRefs): void {
  for (const alias of source.aliases) target.aliases.add(alias);
  for (const column of source.columns) target.columns.add(column);
}

export function addOutputRefs(node: LogicalPlanNode, refs: PlanRefs, options: CollectPlanRefsOptions = {}): void {
  if (!node) return;
  mergeInto(refs, collectPlanRefs(node, options));
}

function scanRefs(node: LogicalPlanNode & { alias?: string; table?: string; columns?: { name?: string; columnName?: string }[] }): PlanRefs {
  const refs = emptyRefs();
  add(refs.aliases, (node.alias || node.table || '').toUpperCase());
  for (const col of node.columns || []) {
    add(refs.columns, (col.name || col.columnName || '').toUpperCase());
  }
  return refs;
}

function projectRefs(node: LogicalPlanNode, options: CollectPlanRefsOptions): PlanRefs {
  const project = node as LogicalPlanNode & { outputAlias?: string; expressions?: BoundExpr[] };
  const refs = emptyRefs();
  add(refs.aliases, project.outputAlias?.toUpperCase());

  for (const expr of project.expressions || []) {
    add(refs.columns, outputName(expr as NamedExpr));
    add(refs.aliases, (expr as { tableAlias?: string }).tableAlias?.toUpperCase());
  }

  if (options.recurseProject) {
    for (const child of getChildren(node)) mergeInto(refs, collectPlanRefs(child, options));
  }
  return refs;
}

function aggregateRefs(node: LogicalPlanNode): PlanRefs {
  const aggregate = node as LogicalPlanNode & { groupBy?: BoundExpr[]; aggregates?: BoundExpr[] };
  const refs = emptyRefs();
  for (const expr of aggregate.groupBy || []) add(refs.columns, outputName(expr as NamedExpr));
  for (const agg of aggregate.aggregates || []) add(refs.columns, outputName(agg as NamedExpr));
  return refs;
}

function branchRefs(node: LogicalPlanNode, options: CollectPlanRefsOptions): PlanRefs {
  const children = getChildren(node);
  if (children.length === 1) return collectPlanRefs(children[0], options);

  const refs = emptyRefs();
  for (const child of children) mergeInto(refs, collectPlanRefs(child, options));
  return refs;
}

function computeRefs(node: LogicalPlanNode, options: CollectPlanRefsOptions): PlanRefs {
  switch (node.type) {
    case PlanNodeType.SCAN:
      return scanRefs(node);
    case PlanNodeType.CTE_SCAN: {
      const refs = emptyRefs();
      add(refs.aliases, ((node as { alias?: string }).alias || node.cteName || '').toUpperCase());
      return refs;
    }
    case PlanNodeType.PROJECT:
      return projectRefs(node, options);
    case PlanNodeType.AGGREGATE:
      return aggregateRefs(node);
    case PlanNodeType.JOIN:
    case PlanNodeType.SET_OP:
      return branchRefs(node, options);
    default: {
      const child = node.children?.[0];
      return child ? collectPlanRefs(child, options) : EMPTY_REFS;
    }
  }
}

export function collectPlanRefs(node: LogicalPlanNode, options: CollectPlanRefsOptions = {}): PlanRefs {
  if (!node) return EMPTY_REFS;

  const cache = options.recurseProject ? PROJECT_RECURSIVE_REFS : DIRECT_REFS;
  const cached = cache.get(node);
  if (cached) return cached;

  const refs = computeRefs(node, options);
  cache.set(node, refs);
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
