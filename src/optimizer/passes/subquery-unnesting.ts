import { OptimizationPass } from '../pass.js';
import {
  JoinType,
  LogicalJoin,
  LogicalProject,
  PlanNodeType,
  SubqueryType,
  getChildren,
  setChildren,
  type LogicalDependentJoinNode,
  type LogicalPlanNode,
  type LogicalProjectNode,
  type ProjectedExpr,
} from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { projectedColumnAlias, projectedColumnName } from '../../planner/project-schema.js';
import { BoundBinary, BoundColumnRef, getExprType, type BoundColumnRefNode, type BoundExpr } from '../../binder/expression-binder.js';
import { combineConjuncts } from '../../binder/conjuncts.js';
import { DataType } from '../../storage/data-type.js';
import { CorrelationSet, collectCorrelatedNodes, correlationHiddenFromPlan } from '../dependent-join/correlation.js';
import { chooseDomain } from '../dependent-join/domain-choice.js';
import { peelTransparentProjections, pushDependentJoin, type PushdownOutcome } from '../dependent-join/pushdown.js';

interface SubqueryJoinShape {
  readonly joinType: (subquery: LogicalPlanNode) => JoinType;
  readonly comparesOuter: boolean;
  readonly projectsScalar: boolean;
  readonly carriesMark: boolean;
  readonly distinguishesUnknown: boolean;
}

const PASSTHROUGH_SHAPE = { projectsScalar: false, carriesMark: false, distinguishesUnknown: false } as const;

function constantJoin(joinType: JoinType): (subquery: LogicalPlanNode) => JoinType {
  return () => joinType;
}

function scalarJoinType(subquery: LogicalPlanNode): JoinType {
  return hasAggregate(subquery) ? JoinType.LEFT : JoinType.SINGLE;
}

const SUBQUERY_JOINS: Record<SubqueryType, SubqueryJoinShape> = {
  [SubqueryType.EXISTS]: { ...PASSTHROUGH_SHAPE, joinType: constantJoin(JoinType.SEMI), comparesOuter: false },
  [SubqueryType.NOT_EXISTS]: { ...PASSTHROUGH_SHAPE, joinType: constantJoin(JoinType.ANTI), comparesOuter: false },
  [SubqueryType.IN]: { ...PASSTHROUGH_SHAPE, joinType: constantJoin(JoinType.SEMI), comparesOuter: true },
  [SubqueryType.MARK]: { ...PASSTHROUGH_SHAPE, joinType: constantJoin(JoinType.MARK), comparesOuter: true, carriesMark: true, distinguishesUnknown: true },
  [SubqueryType.SCALAR]: { joinType: scalarJoinType, comparesOuter: false, projectsScalar: true, carriesMark: false, distinguishesUnknown: false },
};

export class SubqueryUnnesting extends OptimizationPass {
  override get name() { return 'SubqueryUnnesting'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    let current = plan;
    let changed = true;
    while (changed) {
      const rewriter = new UnnestingRewriter();
      current = rewriter.rewrite(current);
      changed = rewriter.didChange;
    }
    return current;
  }
}

class UnnestingRewriter extends PlanRewriter {
  didChange = false;

  override rewriteDependentJoin(node: LogicalDependentJoinNode): LogicalPlanNode {
    const outer = this.rewrite(node.children[0]);
    const subquery = this.rewrite(node.children[1]);
    const shape = SUBQUERY_JOINS[node.subqueryType];
    if (!shape) return setChildren(node, [outer, subquery]);
    this.didChange = true;

    const set = new CorrelationSet(node.correlatedColumns ?? []);
    const hidden = correlationHiddenFromPlan(subquery, set);
    if (hidden) {
      throw new Error(`Unsupported correlated subquery: a common table expression reads the correlating column ${hidden.tableAlias}.${hidden.columnName}`);
    }
    const correlated = collectCorrelatedNodes(subquery, set);
    const domain = chooseDomain(subquery, outer, set, correlated);
    const pushed = pushDependentJoin(subquery, set, domain, correlated, shape.distinguishesUnknown);
    const outputRef = subqueryOutputRef(pushed.plan);

    const conditions = [...pushed.conditions];
    if (shape.comparesOuter && node.condition && outputRef) {
      conditions.push(BoundBinary(node.compareOp, node.condition, outputRef, DataType.BOOLEAN));
    }

    const right = shape.projectsScalar
      ? projectScalarOutput(pushed, outputRef, node.markColumn)
      : stripTransparentProjection(pushed.plan, outputRef, pushed.columns);
    const join = LogicalJoin(shape.joinType(subquery), combineConjuncts(conditions), outer, right);
    return shape.carriesMark && node.markColumn ? { ...join, markColumn: node.markColumn } : join;
  }
}

function projectedRef(project: LogicalProjectNode, index: number): BoundColumnRefNode {
  const expr = project.expressions[index];
  const name = projectedColumnName(expr, index);
  return BoundColumnRef(projectedColumnAlias(expr, name, project.outputAlias ?? ''), name, index, getExprType(expr));
}

function topProjection(plan: LogicalPlanNode): LogicalProjectNode | null {
  let node: LogicalPlanNode | undefined = plan;
  while (node) {
    if (node.type === PlanNodeType.PROJECT && node.expressions.length > 0) return node;
    node = getChildren(node)[0];
  }
  return null;
}

function subqueryOutputRef(plan: LogicalPlanNode): BoundColumnRefNode | null {
  const project = topProjection(plan);
  return project ? projectedRef(project, 0) : null;
}

function stripTransparentProjection(plan: LogicalPlanNode, outputRef: BoundColumnRefNode | null, columns: readonly BoundColumnRefNode[]): LogicalPlanNode {
  return peelTransparentProjections(plan, outputRef ? [outputRef, ...columns] : columns).inner;
}

function projectScalarOutput(pushed: PushdownOutcome, outputRef: BoundColumnRefNode | null, scalarColumn: string | null): LogicalPlanNode {
  const named = (expr: BoundExpr, outputName: string | null): ProjectedExpr =>
    (outputName ? { ...expr, outputName } : { ...expr });

  if (pushed.plan.type === PlanNodeType.PROJECT && pushed.plan.expressions.length > 0) {
    const [head, ...rest] = pushed.plan.expressions;
    return { ...pushed.plan, expressions: [named(head, scalarColumn), ...rest] };
  }

  if (!outputRef) return pushed.plan;
  return LogicalProject([named(outputRef, scalarColumn), ...pushed.columns.map((ref) => named(ref, null))], pushed.plan);
}

function hasAggregate(node: LogicalPlanNode): boolean {
  if (node.type === PlanNodeType.AGGREGATE) return true;
  return getChildren(node).some(hasAggregate);
}
