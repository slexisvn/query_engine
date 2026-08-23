import { OptimizationPass } from '../pass.js';
import {
  PlanNodeType, JoinType, LogicalPartialAggregate, LogicalFinalAggregate,
  type LogicalPlanNode, type LogicalAggregateNode, type LogicalJoinNode,
} from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { DefaultCardinalityEstimator, type TableStats } from '../../planner/cardinality.js';
import { PhysicalPlanner } from '../../execution/physical-planner.js';
import { totalPhysicalCost } from '../../execution/physical-plan.js';
import {
  aggregateFunctionName, decompositionOf, SINGLE_COLUMN_PARTIAL_FUNCTIONS,
} from '../../planner/aggregate-decomposition.js';
import { collectTableRefs } from '../expr-walk.js';
import { collectColumnRefs } from '../dependent-join/correlation.js';
import { exprKey } from '../../binder/expr-key.js';
import { BoundExprKind, type BoundExpr, type BoundAggregateNode } from '../../binder/expression-binder.js';
import { Config } from '../../config.js';

export const AGGREGATE_PUSHDOWN_PASS = 'AggregatePushdown';

type PushSide = 0 | 1;

type DecomposedAggregate = BoundAggregateNode & { func: string };

export class AggregatePushdown extends OptimizationPass {
  statistics: Map<string, TableStats>;

  constructor(statistics: Map<string, TableStats> = new Map()) {
    super();
    this.statistics = statistics;
  }

  override get name() { return AGGREGATE_PUSHDOWN_PASS; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    return new AggregatePushdownRewriter(this.statistics).rewrite(plan);
  }
}

class AggregatePushdownRewriter extends PlanRewriter {
  estimator: DefaultCardinalityEstimator;
  physicalPlanner: PhysicalPlanner;

  constructor(statistics: Map<string, TableStats>) {
    super();
    this.estimator = new DefaultCardinalityEstimator(statistics);
    this.physicalPlanner = new PhysicalPlanner(statistics);
  }

  override rewriteAggregate(node: LogicalAggregateNode): LogicalPlanNode {
    const rewritten = this.rewriteChildren(node);
    const join = rewritten.children[0];

    if (join.type !== PlanNodeType.JOIN || join.joinType !== JoinType.INNER) return rewritten;
    if (!join.condition) return rewritten;

    const groupBy = rewritten.groupBy ?? [];
    const aggregates = (rewritten.aggregates ?? []) as BoundAggregateNode[];
    if (groupBy.length === 0 || aggregates.length === 0) return rewritten;
    if (!aggregates.every(agg => this.isPushable(agg))) return rewritten;

    const sideRefs = join.children.map(scanAliasesOf);
    const pushSide = this.soleSideOf(groupBy, sideRefs);
    if (pushSide === null) return rewritten;
    if (!this.aggregateInputsConfinedTo(aggregates, pushSide, sideRefs)) return rewritten;

    if (this.estimator.estimatePlan(join.children[pushSide]) < Config.eagerAggregationMinRows) return rewritten;

    const partialGroupBy = this.partialGroupingFor(groupBy, join.condition, sideRefs[pushSide]);

    const partialAggregates: DecomposedAggregate[] = aggregates.map(agg => ({ ...agg, func: decompositionOf(agg)!.partial }));
    const finalAggregates: DecomposedAggregate[] = aggregates.map(agg => ({ ...agg, func: decompositionOf(agg)!.final }));

    const children = [...join.children];
    children[pushSide] = LogicalPartialAggregate(
      partialGroupBy,
      partialAggregates as BoundExpr[],
      children[pushSide]
    );

    const candidate = LogicalFinalAggregate(
      groupBy,
      finalAggregates as BoundExpr[],
      partialAggregates as BoundExpr[],
      { ...join, children } as LogicalJoinNode
    );

    return this.isCheaper(candidate, rewritten) ? candidate : rewritten;
  }

  isCheaper(candidate: LogicalPlanNode, current: LogicalPlanNode): boolean {
    const candidateCost = this.costOf(candidate);
    if (candidateCost === null) return false;
    const currentCost = this.costOf(current);
    return currentCost !== null && candidateCost < currentCost;
  }

  costOf(node: LogicalPlanNode): number | null {
    try {
      return totalPhysicalCost(this.physicalPlanner.plan(node));
    } catch {
      return null;
    }
  }

  isPushable(agg: BoundAggregateNode): boolean {
    if (agg.kind !== BoundExprKind.AGGREGATE || agg.distinct) return false;
    return SINGLE_COLUMN_PARTIAL_FUNCTIONS.has(aggregateFunctionName(agg));
  }

  soleSideOf(exprs: readonly BoundExpr[], sideRefs: Set<string>[]): PushSide | null {
    let side: PushSide | null = null;
    for (const expr of exprs) {
      if (expr.kind !== BoundExprKind.COLUMN_REF) return null;
      const owner = this.ownerOf(expr, sideRefs);
      if (owner === null || (side !== null && owner !== side)) return null;
      side = owner;
    }
    return side;
  }

  ownerOf(expr: BoundExpr, sideRefs: Set<string>[]): PushSide | null {
    const table = (expr as { tableAlias?: string }).tableAlias?.toUpperCase() ?? '';
    if (sideRefs[0].has(table)) return 0;
    if (sideRefs[1].has(table)) return 1;
    return null;
  }

  aggregateInputsConfinedTo(aggregates: BoundAggregateNode[], pushSide: PushSide, sideRefs: Set<string>[]): boolean {
    const forbidden = sideRefs[pushSide === 0 ? 1 : 0];
    for (const agg of aggregates) {
      for (const arg of agg.args ?? []) {
        for (const table of collectTableRefs(arg)) {
          if (forbidden.has(table)) return false;
        }
      }
    }
    return true;
  }

  partialGroupingFor(groupBy: readonly BoundExpr[], condition: BoundExpr, pushRefs: Set<string>): BoundExpr[] {
    const grouping = [...groupBy];
    const seen = new Set(grouping.map(exprKey));
    for (const ref of collectColumnRefs(condition)) {
      if (!pushRefs.has((ref.tableAlias || '').toUpperCase())) continue;
      const key = exprKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      grouping.push(ref);
    }
    return grouping;
  }
}

function scanAliasesOf(node: LogicalPlanNode): Set<string> {
  const aliases = new Set<string>();
  const stack: LogicalPlanNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === PlanNodeType.SCAN) {
      aliases.add((current.alias || current.table || '').toUpperCase());
      continue;
    }
    for (const child of current.children ?? []) stack.push(child);
  }
  return aliases;
}
