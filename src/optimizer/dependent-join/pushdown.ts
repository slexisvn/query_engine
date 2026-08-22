import {
  BoundBinary,
  BoundColumnRef,
  BoundExprKind,
  BoundLiteral,
  BoundWindow,
  type BoundColumnRefNode,
  type BoundExpr,
  type BoundWindowNode,
} from '../../binder/expression-binder.js';
import { exprKey } from '../../binder/expr-key.js';
import { combineConjuncts, splitConjuncts } from '../../binder/conjuncts.js';
import { DataType } from '../../storage/data-type.js';
import {
  JoinType,
  LogicalFilter,
  LogicalSort,
  LogicalWindow,
  PlanNodeType,
  SetOpType,
  getChildren,
  setChildren,
  type LogicalAggregateNode,
  type LogicalFilterNode,
  type LogicalJoinNode,
  type LogicalOrderKey,
  type LogicalPlanNode,
  type LogicalProjectNode,
  type LogicalSetOpNode,
  type LogicalSortNode,
  type LogicalWindowNode,
  type ProjectedExpr,
} from '../../planner/logical-plan.js';
import { projectedColumnAlias, projectedColumnName } from '../../planner/project-schema.js';
import { isNullRejecting, type NullColumnPredicate } from '../passes/null-rejection.js';
import {
  collectColumnRefs,
  referencesCorrelation,
  substituteByKey,
  type CorrelationSet,
} from './correlation.js';
import { nullSafeEquals, type CorrelationDomain } from './domain.js';

const ROW_NUMBER = 'ROW_NUMBER';

export interface PushResult {
  readonly plan: LogicalPlanNode;
  readonly domain: readonly BoundColumnRefNode[];
  readonly carried: readonly BoundColumnRefNode[];
  readonly substitutions: ReadonlyMap<string, BoundExpr>;
}

export interface RowLimit {
  readonly count: number;
  readonly offset: number;
  readonly orderKeys: readonly LogicalOrderKey[];
  readonly input: LogicalPlanNode;
}

export enum DomainRole {
  TRANSPARENT = 'Transparent',
  CONSUMES = 'Consumes',
  BRANCHING = 'Branching',
}

const NODE_ROLES: Partial<Record<PlanNodeType, DomainRole>> = {
  [PlanNodeType.AGGREGATE]: DomainRole.CONSUMES,
  [PlanNodeType.WINDOW]: DomainRole.CONSUMES,
  [PlanNodeType.DISTINCT]: DomainRole.CONSUMES,
  [PlanNodeType.LIMIT]: DomainRole.CONSUMES,
  [PlanNodeType.TOP_N]: DomainRole.CONSUMES,
  [PlanNodeType.JOIN]: DomainRole.BRANCHING,
  [PlanNodeType.SET_OP]: DomainRole.BRANCHING,
  [PlanNodeType.CTE_ANCHOR]: DomainRole.BRANCHING,
};

export const DOMAIN_CARRYING_SIDES: Record<JoinType, readonly number[]> = {
  [JoinType.INNER]: [0, 1],
  [JoinType.CROSS]: [0, 1],
  [JoinType.LEFT]: [0],
  [JoinType.SEMI]: [0],
  [JoinType.ANTI]: [0],
  [JoinType.MARK]: [0],
  [JoinType.SINGLE]: [0],
  [JoinType.RIGHT]: [1],
  [JoinType.FULL]: [],
};

export const LIFTABLE_JOIN_CONDITIONS: ReadonlySet<JoinType> = new Set([JoinType.INNER, JoinType.CROSS]);

export function rowLimitOf(node: LogicalPlanNode): RowLimit | null {
  if (node.type === PlanNodeType.LIMIT) {
    return { count: node.count, offset: node.offset || 0, orderKeys: [], input: node.children[0] };
  }
  if (node.type === PlanNodeType.TOP_N) {
    return { count: node.count, offset: node.offset || 0, orderKeys: node.orderKeys, input: LogicalSort(node.orderKeys, node.children[0]) };
  }
  if (node.type === PlanNodeType.SORT && node.limit != null) {
    return { count: node.limit, offset: node.offset || 0, orderKeys: node.orderKeys, input: LogicalSort(node.orderKeys, node.children[0]) };
  }
  return null;
}

export function domainRoleOf(node: LogicalPlanNode): DomainRole {
  if (rowLimitOf(node)) return DomainRole.CONSUMES;
  return NODE_ROLES[node.type] ?? DomainRole.TRANSPARENT;
}

function spineOrderKeys(node: LogicalPlanNode): readonly LogicalOrderKey[] {
  let current: LogicalPlanNode | undefined = node;
  while (current) {
    if (current.type === PlanNodeType.SORT || current.type === PlanNodeType.TOP_N) return current.orderKeys;
    if (current.type !== PlanNodeType.PROJECT) return [];
    current = current.children[0];
  }
  return [];
}

function unionColumns(...groups: readonly (readonly BoundColumnRefNode[])[]): BoundColumnRefNode[] {
  const seen = new Set<string>();
  const merged: BoundColumnRefNode[] = [];
  for (const group of groups) {
    for (const ref of group) {
      const key = exprKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(ref);
    }
  }
  return merged;
}

function mergeSubstitutions(...results: readonly PushResult[]): ReadonlyMap<string, BoundExpr> {
  const nonEmpty = results.filter((result) => result.substitutions.size > 0);
  if (nonEmpty.length === 0) return EMPTY_SUBSTITUTIONS;
  if (nonEmpty.length === 1) return nonEmpty[0].substitutions;
  const merged = new Map<string, BoundExpr>();
  for (const result of nonEmpty) {
    for (const [key, value] of result.substitutions) merged.set(key, value);
  }
  return merged;
}

const EMPTY_SUBSTITUTIONS: ReadonlyMap<string, BoundExpr> = new Map();

type PushRule = (ctx: PushdownContext, node: LogicalPlanNode) => PushResult;

export class PushdownContext {
  readonly set: CorrelationSet;
  readonly domain: CorrelationDomain;
  readonly correlated: ReadonlySet<LogicalPlanNode>;
  readonly lifted: BoundExpr[] = [];
  private carryCount = 0;

  constructor(set: CorrelationSet, domain: CorrelationDomain, correlated: ReadonlySet<LogicalPlanNode>) {
    this.set = set;
    this.domain = domain;
    this.correlated = correlated;
  }

  push(node: LogicalPlanNode): PushResult {
    if (!this.correlated.has(node)) {
      const anchor = this.domain.anchor(node);
      return { plan: anchor.plan, domain: anchor.columns, carried: anchor.columns, substitutions: EMPTY_SUBSTITUTIONS };
    }
    const rule = PUSH_RULES[node.type];
    if (!rule) {
      throw new Error(`Unsupported correlated subquery: a ${node.type} operator cannot carry a dependent join`);
    }
    return rule(this, node);
  }

  rewrite(expr: BoundExpr, child: PushResult): BoundExpr {
    const substituted = substituteByKey(expr, child.substitutions, exprKey);
    return referencesCorrelation(substituted, this.set)
      ? this.domain.substitute(substituted, child.domain)
      : substituted;
  }

  nextCarryName(): string {
    return `__carry_${this.carryCount++}`;
  }

  renameLifted(produced: ReadonlyMap<string, BoundColumnRefNode>): void {
    const renames = new Map<string, BoundExpr>();
    for (const [key, ref] of produced) {
      if (key !== exprKey(ref)) renames.set(key, ref);
    }
    if (renames.size === 0) return;
    for (let i = 0; i < this.lifted.length; i++) {
      this.lifted[i] = substituteByKey(this.lifted[i], renames, exprKey);
    }
  }

  innerRefsOf(expr: BoundExpr): BoundColumnRefNode[] {
    return collectColumnRefs(expr).filter((ref) => !this.set.matches(ref));
  }
}

function pushOnlyChild(ctx: PushdownContext, node: LogicalPlanNode): PushResult {
  const child = ctx.push(getChildren(node)[0]);
  return {
    plan: setChildren(node, [child.plan]),
    domain: child.domain,
    carried: child.carried,
    substitutions: child.substitutions,
  };
}

function pushFilter(ctx: PushdownContext, node: LogicalPlanNode): PushResult {
  const filter = node as LogicalFilterNode;
  const child = ctx.push(filter.children[0]);
  const { kept, domain, carried } = partitionConjuncts(ctx, filter.condition, child);
  const plan = kept.length > 0 ? LogicalFilter(combineConjuncts(kept), child.plan) : child.plan;
  return { plan, domain, carried, substitutions: child.substitutions };
}

interface SplitConjuncts {
  kept: BoundExpr[];
  domain: BoundColumnRefNode[];
  carried: BoundColumnRefNode[];
}

function partitionConjuncts(ctx: PushdownContext, condition: BoundExpr | null, child: PushResult): SplitConjuncts {
  const kept: BoundExpr[] = [];
  const bound: BoundColumnRefNode[] = [];
  const preserved: BoundColumnRefNode[] = [];

  for (const pred of splitConjuncts(condition)) {
    const substituted = substituteByKey(pred, child.substitutions, exprKey);
    if (!referencesCorrelation(substituted, ctx.set)) {
      kept.push(substituted);
      continue;
    }
    const outcome = ctx.domain.correlatedConjunct(substituted, child.domain);
    if (outcome.lift) {
      ctx.lifted.push(outcome.lift);
      preserved.push(...ctx.innerRefsOf(substituted));
    }
    if (outcome.keep) kept.push(outcome.keep);
    if (outcome.column) bound.push(outcome.column);
  }

  const domain = unionColumns(child.domain, bound);
  return { kept, domain, carried: unionColumns(child.carried, domain, preserved) };
}

function pushProject(ctx: PushdownContext, node: LogicalPlanNode): PushResult {
  const project = node as LogicalProjectNode;
  const child = ctx.push(project.children[0]);
  const expressions: ProjectedExpr[] = project.expressions.map((expr) => {
    const rewritten = ctx.rewrite(expr, child) as ProjectedExpr;
    return expr.outputName && rewritten !== expr ? { ...rewritten, outputName: expr.outputName } : rewritten;
  });

  const produced = new Map<string, BoundColumnRefNode>();
  const takenNames = new Set(expressions.map((expr, index) => projectedColumnName(expr, index).toUpperCase()));
  const outputRefOf = (expr: ProjectedExpr, index: number): BoundColumnRefNode => {
    const name = projectedColumnName(expr, index);
    return BoundColumnRef(projectedColumnAlias(expr, name, project.outputAlias ?? ''), name, index, null);
  };

  expressions.forEach((expr, index) => {
    if (expr.kind !== BoundExprKind.COLUMN_REF) return;
    const key = exprKey(expr);
    if (!produced.has(key)) produced.set(key, outputRefOf(expr, index));
  });

  for (const ref of child.carried) {
    const key = exprKey(ref);
    if (produced.has(key)) continue;
    const collides = takenNames.has(ref.columnName.toUpperCase());
    const outputName = collides ? ctx.nextCarryName() : ref.columnName;
    const projected: ProjectedExpr = collides ? { ...ref, outputName } : { ...ref };
    takenNames.add(outputName.toUpperCase());
    expressions.push(projected);
    produced.set(key, outputRefOf(projected, expressions.length - 1));
  }

  const translate = (refs: readonly BoundColumnRefNode[]): BoundColumnRefNode[] =>
    refs.map((ref) => produced.get(exprKey(ref))!);

  ctx.renameLifted(produced);

  return {
    plan: { ...project, expressions, children: [child.plan] },
    domain: translate(child.domain),
    carried: translate(child.carried),
    substitutions: child.substitutions,
  };
}

function pushAggregate(ctx: PushdownContext, node: LogicalPlanNode): PushResult {
  const aggregate = node as LogicalAggregateNode;
  const child = ctx.push(aggregate.children[0]);
  requireDomain(ctx, child, aggregate.type);
  return {
    plan: {
      ...aggregate,
      groupBy: [...aggregate.groupBy.map((expr) => ctx.rewrite(expr, child)), ...child.domain],
      aggregates: aggregate.aggregates.map((expr) => ctx.rewrite(expr, child)),
      children: [child.plan],
    },
    domain: child.domain,
    carried: child.domain,
    substitutions: child.substitutions,
  };
}

function pushWindow(ctx: PushdownContext, node: LogicalPlanNode): PushResult {
  const window = node as LogicalWindowNode;
  const child = ctx.push(window.children[0]);
  requireDomain(ctx, child, window.type);

  const substitutions = new Map(child.substitutions);
  const windowExprs = window.windowExprs.map((expr) => {
    const source = expr as BoundWindowNode;
    const rewritten = BoundWindow(
      source.name,
      source.args.map((arg) => ctx.rewrite(arg, child)),
      [...source.partitionBy.map((partition) => ctx.rewrite(partition, child)), ...child.domain],
      source.orderBy.map((key) => ({ ...key, expr: ctx.rewrite(key.expr, child) })),
      source.frame,
      source.resultType,
    );
    substitutions.set(exprKey(source), rewritten);
    return rewritten;
  });

  return {
    plan: { ...window, windowExprs, children: [child.plan] },
    domain: child.domain,
    carried: child.carried,
    substitutions,
  };
}

function pushSort(ctx: PushdownContext, node: LogicalPlanNode): PushResult {
  const sort = node as LogicalSortNode;
  if (rowLimitOf(sort)) return pushRowLimit(ctx, sort);
  const child = ctx.push(sort.children[0]);
  return {
    plan: { ...sort, orderKeys: sort.orderKeys.map((key) => ({ ...key, expr: ctx.rewrite(key.expr, child) })), children: [child.plan] },
    domain: child.domain,
    carried: child.carried,
    substitutions: child.substitutions,
  };
}

function pushRowLimit(ctx: PushdownContext, node: LogicalPlanNode): PushResult {
  const limit = rowLimitOf(node)!;
  const orderKeys = limit.orderKeys.length > 0 ? limit.orderKeys : spineOrderKeys(limit.input);
  const child = ctx.push(limit.input);
  requireDomain(ctx, child, node.type);

  const rowNumber = BoundWindow(
    ROW_NUMBER,
    [],
    [...child.domain],
    orderKeys.map((key) => ({ expr: ctx.rewrite(key.expr, child), direction: key.direction, nullOrder: key.nullOrder })),
    null,
    DataType.INT64,
  );

  const gate = rowNumberRange(rowNumber, limit.count, limit.offset);
  const transparent = peelTransparentProjections(child.plan, child.carried);
  const ranked = LogicalFilter(gate, LogicalWindow([rowNumber], transparent.inner));

  return {
    plan: transparent.rebuild(ranked),
    domain: child.domain,
    carried: child.carried,
    substitutions: child.substitutions,
  };
}

export interface PeeledProjections {
  readonly inner: LogicalPlanNode;
  rebuild(node: LogicalPlanNode): LogicalPlanNode;
}

export function peelTransparentProjections(plan: LogicalPlanNode, needed: readonly BoundColumnRefNode[]): PeeledProjections {
  const peeled: LogicalProjectNode[] = [];
  let inner = plan;
  while (inner.type === PlanNodeType.PROJECT && passesThrough(inner, needed)) {
    peeled.push(inner);
    inner = inner.children[0];
  }
  return {
    inner,
    rebuild: (node: LogicalPlanNode) => peeled.reduceRight<LogicalPlanNode>((acc, project) => setChildren(project, [acc]), node),
  };
}

function passesThrough(project: LogicalProjectNode, needed: readonly BoundColumnRefNode[]): boolean {
  if (project.outputAlias) return false;
  return needed.every((ref) => project.expressions.some((expr, index) =>
    expr.kind === BoundExprKind.COLUMN_REF
    && exprKey(expr) === exprKey(ref)
    && projectedColumnName(expr, index).toUpperCase() === ref.columnName.toUpperCase()));
}

function rowNumberRange(rowNumber: BoundExpr, count: number, offset: number): BoundExpr {
  const bound = (op: string, value: number): BoundExpr =>
    BoundBinary(op, rowNumber, BoundLiteral(value, DataType.INT64), DataType.BOOLEAN);
  const upper = bound('<=', offset + count);
  return offset > 0 ? BoundBinary('AND', bound('>', offset), upper, DataType.BOOLEAN) : upper;
}

function pushJoin(ctx: PushdownContext, node: LogicalPlanNode): PushResult {
  const join = node as LogicalJoinNode;
  const carryingSides = DOMAIN_CARRYING_SIDES[join.joinType];
  if (carryingSides.length === 0) {
    throw new Error(`Unsupported correlated subquery: a ${join.joinType} join preserves neither side of a dependent join`);
  }

  const correlatedSides = join.children.flatMap((child, index) => (ctx.correlated.has(child) ? [index] : []));
  const single = correlatedSides.length <= 1 ? (correlatedSides[0] ?? carryingSides[0]) : null;

  if (single !== null && carryingSides.includes(single)) {
    const pushedChild = ctx.push(join.children[single]);
    const children = [...join.children];
    children[single] = pushedChild.plan;
    const { kept, domain, carried } = joinConjuncts(ctx, join, pushedChild);
    return {
      plan: { ...join, condition: combineConjuncts(kept), children },
      domain,
      carried,
      substitutions: pushedChild.substitutions,
    };
  }

  const left = ctx.push(join.children[0]);
  const right = ctx.push(join.children[1]);
  const anchored = [left, right][carryingSides[0]];
  const { kept } = joinConjuncts(ctx, join, anchored, mergeSubstitutions(left, right));
  const alignment = left.domain.map((column, index) => nullSafeEquals(column, right.domain[index]));

  return {
    plan: { ...join, condition: combineConjuncts([...kept, ...alignment]), children: [left.plan, right.plan] },
    domain: anchored.domain,
    carried: anchored.carried,
    substitutions: mergeSubstitutions(left, right),
  };
}

function joinConjuncts(ctx: PushdownContext, join: LogicalJoinNode, child: PushResult, substitutions?: ReadonlyMap<string, BoundExpr>): SplitConjuncts {
  const source: PushResult = substitutions ? { ...child, substitutions } : child;
  if (!referencesCorrelation(join.condition, ctx.set)) {
    const kept = splitConjuncts(join.condition).map((pred) => substituteByKey(pred, source.substitutions, exprKey));
    return { kept, domain: [...child.domain], carried: [...child.carried] };
  }
  if (ctx.domain.liftsPredicates && !LIFTABLE_JOIN_CONDITIONS.has(join.joinType)) {
    throw new Error(`Unsupported correlated subquery: a correlated ${join.joinType} join condition cannot be lifted`);
  }
  return partitionConjuncts(ctx, join.condition, source);
}

function pushSetOp(ctx: PushdownContext, node: LogicalPlanNode): PushResult {
  const setOp = node as LogicalSetOpNode;
  const left = ctx.push(setOp.children[0]);
  const right = ctx.push(setOp.children[1]);
  requireDomain(ctx, left, setOp.type);
  requireDomain(ctx, right, setOp.type);
  return {
    plan: setChildren(setOp, [left.plan, right.plan]),
    domain: left.domain,
    carried: left.carried,
    substitutions: mergeSubstitutions(left, right),
  };
}

function pushCTEAnchor(ctx: PushdownContext, node: LogicalPlanNode): PushResult {
  const [producer, consumer] = getChildren(node);
  if (ctx.correlated.has(producer)) {
    throw new Error('Unsupported correlated subquery: a common table expression cannot depend on the correlating row');
  }
  const pushed = ctx.push(consumer);
  return {
    plan: setChildren(node, [producer, pushed.plan]),
    domain: pushed.domain,
    carried: pushed.carried,
    substitutions: pushed.substitutions,
  };
}

function requireDomain(ctx: PushdownContext, child: PushResult, type: PlanNodeType): void {
  if (child.domain.length === 0 && ctx.set.size > 0) {
    throw new Error(`Unsupported correlated subquery: a ${type} operator has no correlation domain to group by`);
  }
}

const PUSH_RULES: Partial<Record<PlanNodeType, PushRule>> = {
  [PlanNodeType.FILTER]: pushFilter,
  [PlanNodeType.PROJECT]: pushProject,
  [PlanNodeType.AGGREGATE]: pushAggregate,
  [PlanNodeType.WINDOW]: pushWindow,
  [PlanNodeType.SORT]: pushSort,
  [PlanNodeType.LIMIT]: pushRowLimit,
  [PlanNodeType.TOP_N]: pushRowLimit,
  [PlanNodeType.DISTINCT]: pushOnlyChild,
  [PlanNodeType.MATERIALIZE]: pushOnlyChild,
  [PlanNodeType.JOIN]: pushJoin,
  [PlanNodeType.SET_OP]: pushSetOp,
  [PlanNodeType.CTE_ANCHOR]: pushCTEAnchor,
};

type NullRejection = (plan: LogicalPlanNode, refs: NullColumnPredicate) => boolean;

const REJECTS_THROUGH_LEFT: NullRejection = (plan, refs) => rejectsNullDomain(getChildren(plan)[0], refs);
const REJECTS_THROUGH_EITHER: NullRejection = (plan, refs) => getChildren(plan).some((child) => rejectsNullDomain(child, refs));
const REJECTS_NEVER: NullRejection = () => false;

const SET_OP_REJECTION: Record<SetOpType, NullRejection> = {
  [SetOpType.UNION]: (plan, refs) => getChildren(plan).every((child) => rejectsNullDomain(child, refs)),
  [SetOpType.INTERSECT]: REJECTS_THROUGH_EITHER,
  [SetOpType.EXCEPT]: REJECTS_THROUGH_LEFT,
};

const JOIN_REJECTION: Partial<Record<JoinType, NullRejection>> = {
  [JoinType.INNER]: REJECTS_THROUGH_EITHER,
  [JoinType.CROSS]: REJECTS_THROUGH_EITHER,
  [JoinType.SEMI]: REJECTS_THROUGH_EITHER,
  [JoinType.LEFT]: REJECTS_THROUGH_LEFT,
  [JoinType.SINGLE]: REJECTS_THROUGH_LEFT,
  [JoinType.RIGHT]: (plan, refs) => rejectsNullDomain(getChildren(plan)[1], refs),
};

const REJECTION_RULES: Partial<Record<PlanNodeType, NullRejection>> = {
  [PlanNodeType.FILTER]: (plan, refs) => {
    const condition = (plan as LogicalFilterNode).condition;
    return (condition !== null && isNullRejecting(condition, refs)) || REJECTS_THROUGH_LEFT(plan, refs);
  },
  [PlanNodeType.PROJECT]: REJECTS_THROUGH_LEFT,
  [PlanNodeType.DISTINCT]: REJECTS_THROUGH_LEFT,
  [PlanNodeType.SORT]: REJECTS_THROUGH_LEFT,
  [PlanNodeType.TOP_N]: REJECTS_THROUGH_LEFT,
  [PlanNodeType.LIMIT]: REJECTS_THROUGH_LEFT,
  [PlanNodeType.MATERIALIZE]: REJECTS_THROUGH_LEFT,
  [PlanNodeType.WINDOW]: REJECTS_THROUGH_LEFT,
  [PlanNodeType.AGGREGATE]: (plan, refs) =>
    (plan as LogicalAggregateNode).groupBy.length > 0 && REJECTS_THROUGH_LEFT(plan, refs),
  [PlanNodeType.JOIN]: (plan, refs) => (JOIN_REJECTION[(plan as LogicalJoinNode).joinType] ?? REJECTS_NEVER)(plan, refs),
  [PlanNodeType.SET_OP]: (plan, refs) => SET_OP_REJECTION[(plan as LogicalSetOpNode).op](plan, refs),
};

function rejectsNullDomain(plan: LogicalPlanNode, refs: NullColumnPredicate): boolean {
  return (REJECTION_RULES[plan.type] ?? REJECTS_NEVER)(plan, refs);
}

export interface PushdownOutcome {
  readonly plan: LogicalPlanNode;
  readonly conditions: readonly BoundExpr[];
  readonly columns: readonly BoundColumnRefNode[];
}

export function pushDependentJoin(
  subquery: LogicalPlanNode,
  set: CorrelationSet,
  domain: CorrelationDomain,
  correlated: ReadonlySet<LogicalPlanNode>,
  alwaysNullSafe: boolean,
): PushdownOutcome {
  const ctx = new PushdownContext(set, domain, correlated);
  const pushed = ctx.push(subquery);
  const nullSafe = Array.from({ length: domain.width }, (_, index) =>
    alwaysNullSafe || !rejectsNullDomain(pushed.plan, domain.columnMatcher(index)));
  return {
    plan: pushed.plan,
    conditions: [...ctx.lifted, ...domain.joinBack(pushed.domain, nullSafe)],
    columns: pushed.carried,
  };
}
