import { BoundExprKind, mapExpr, walkExpr, type BoundColumnRefNode, type BoundExpr } from '../../binder/expression-binder.js';
import { PlanNodeType, getChildren, type LogicalPlanNode } from '../../planner/logical-plan.js';

export type CorrelationKey = string;

export function correlationKeyOf(ref: BoundColumnRefNode): CorrelationKey {
  return `${(ref.tableAlias || '').toUpperCase()}.${ref.columnName.toUpperCase()}`;
}

export class CorrelationSet {
  readonly columns: readonly BoundColumnRefNode[];
  private readonly keys: ReadonlySet<CorrelationKey>;

  constructor(refs: readonly BoundColumnRefNode[]) {
    const seen = new Map<CorrelationKey, BoundColumnRefNode>();
    for (const ref of refs) {
      const key = correlationKeyOf(ref);
      if (!seen.has(key)) seen.set(key, ref);
    }
    this.columns = [...seen.values()];
    this.keys = new Set(seen.keys());
  }

  get size(): number {
    return this.columns.length;
  }

  matches(ref: BoundColumnRefNode): boolean {
    return ref.isCorrelated || this.keys.has(correlationKeyOf(ref));
  }

  indexOf(ref: BoundColumnRefNode): number {
    return this.columns.findIndex((column) => correlationKeyOf(column) === correlationKeyOf(ref));
  }
}

export function referencesCorrelation(expr: BoundExpr | null | undefined, set: CorrelationSet): boolean {
  let found = false;
  walkExpr(expr, (node) => {
    if (found) return false;
    if (node.kind === BoundExprKind.COLUMN_REF && set.matches(node)) found = true;
    return undefined;
  });
  return found;
}

export function collectCorrelatedRefs(expr: BoundExpr | null | undefined, set: CorrelationSet, into: Map<CorrelationKey, BoundColumnRefNode> = new Map()): Map<CorrelationKey, BoundColumnRefNode> {
  walkExpr(expr, (node) => {
    if (node.kind === BoundExprKind.COLUMN_REF && set.matches(node)) {
      const key = correlationKeyOf(node);
      if (!into.has(key)) into.set(key, node);
    }
  });
  return into;
}

export function collectColumnRefs(expr: BoundExpr | null | undefined): BoundColumnRefNode[] {
  const refs: BoundColumnRefNode[] = [];
  walkExpr(expr, (node) => {
    if (node.kind === BoundExprKind.COLUMN_REF) refs.push(node);
  });
  return refs;
}

export function decorrelateRefs(expr: BoundExpr, set: CorrelationSet): BoundExpr {
  return mapExpr(expr, (node) =>
    node.kind === BoundExprKind.COLUMN_REF && set.matches(node)
      ? { ...node, depth: 0, isCorrelated: false }
      : null);
}

export function substituteCorrelatedRefs(expr: BoundExpr, set: CorrelationSet, bind: (ref: BoundColumnRefNode) => BoundExpr): BoundExpr {
  return mapExpr(expr, (node) =>
    node.kind === BoundExprKind.COLUMN_REF && set.matches(node) ? bind(node) : null);
}

export function substituteByKey(expr: BoundExpr, replacements: ReadonlyMap<string, BoundExpr>, keyOf: (node: BoundExpr) => string): BoundExpr {
  if (replacements.size === 0) return expr;
  return mapExpr(expr, (node) => replacements.get(keyOf(node)) ?? null);
}

type ExpressionReader = (node: LogicalPlanNode) => readonly BoundExpr[];

const NO_EXPRESSIONS: readonly BoundExpr[] = [];

const NODE_EXPRESSIONS: Partial<Record<PlanNodeType, ExpressionReader>> = {
  [PlanNodeType.FILTER]: (node) => conditionOf(node, PlanNodeType.FILTER),
  [PlanNodeType.JOIN]: (node) => conditionOf(node, PlanNodeType.JOIN),
  [PlanNodeType.DEPENDENT_JOIN]: (node) => conditionOf(node, PlanNodeType.DEPENDENT_JOIN),
  [PlanNodeType.PROJECT]: (node) => (node as { expressions: BoundExpr[] }).expressions,
  [PlanNodeType.AGGREGATE]: (node) => aggregateExpressions(node),
  [PlanNodeType.PARTIAL_AGGREGATE]: (node) => aggregateExpressions(node),
  [PlanNodeType.FINAL_AGGREGATE]: (node) => aggregateExpressions(node),
  [PlanNodeType.SORT]: (node) => orderKeyExpressions(node),
  [PlanNodeType.TOP_N]: (node) => orderKeyExpressions(node),
  [PlanNodeType.MERGE_EXCHANGE]: (node) => orderKeyExpressions(node),
  [PlanNodeType.WINDOW]: (node) => (node as { windowExprs: BoundExpr[] }).windowExprs,
  [PlanNodeType.EXCHANGE]: (node) => (node as { partitionKeys: BoundExpr[] }).partitionKeys,
  [PlanNodeType.SCAN]: (node) => conditionOf(node, PlanNodeType.SCAN),
};

function conditionOf(node: LogicalPlanNode, type: PlanNodeType): readonly BoundExpr[] {
  const held = type === PlanNodeType.SCAN
    ? (node as { pruningFilter?: BoundExpr }).pruningFilter
    : (node as { condition?: BoundExpr | null }).condition;
  return held ? [held] : NO_EXPRESSIONS;
}

function aggregateExpressions(node: LogicalPlanNode): readonly BoundExpr[] {
  const agg = node as { groupBy?: BoundExpr[]; aggregates?: BoundExpr[]; partialAggregates?: BoundExpr[] };
  return [...(agg.groupBy ?? []), ...(agg.aggregates ?? []), ...(agg.partialAggregates ?? [])];
}

function orderKeyExpressions(node: LogicalPlanNode): readonly BoundExpr[] {
  return (node as { orderKeys: { expr: BoundExpr }[] }).orderKeys.map((key) => key.expr);
}

export function ownExpressions(node: LogicalPlanNode): readonly BoundExpr[] {
  return (NODE_EXPRESSIONS[node.type] ?? (() => NO_EXPRESSIONS))(node);
}

export function referencesCorrelationLocally(node: LogicalPlanNode, set: CorrelationSet): boolean {
  return ownExpressions(node).some((expr) => referencesCorrelation(expr, set));
}

const OPAQUE_TO_CORRELATION: ReadonlySet<PlanNodeType> = new Set([PlanNodeType.CTE_SCAN]);

export function correlationHiddenFromPlan(root: LogicalPlanNode, set: CorrelationSet): BoundColumnRefNode | null {
  const reached = new Map<CorrelationKey, BoundColumnRefNode>();
  let opaque = false;
  const visit = (node: LogicalPlanNode): void => {
    if (OPAQUE_TO_CORRELATION.has(node.type)) opaque = true;
    for (const expr of ownExpressions(node)) collectCorrelatedRefs(expr, set, reached);
    for (const child of getChildren(node)) visit(child);
  };
  visit(root);
  if (!opaque) return null;
  return set.columns.find((column) => !reached.has(correlationKeyOf(column))) ?? null;
}

export function collectCorrelatedNodes(root: LogicalPlanNode, set: CorrelationSet): ReadonlySet<LogicalPlanNode> {
  const correlated = new Set<LogicalPlanNode>();
  const visit = (node: LogicalPlanNode): boolean => {
    let dependent = referencesCorrelationLocally(node, set);
    for (const child of getChildren(node)) {
      if (visit(child)) dependent = true;
    }
    if (dependent) correlated.add(node);
    return dependent;
  };
  visit(root);
  return correlated;
}
