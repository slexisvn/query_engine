import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, LogicalJoin, LogicalFilter, LogicalSort, LogicalWindow, getChildren, setChildren, type LogicalPlanNode, type LogicalDependentJoinNode, type LogicalProjectNode, type ProjectedExpr, type LogicalOrderKey } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { BoundExprKind, BoundBinary, BoundLiteral, BoundWindow, type BoundExpr, type BoundColumnRefNode } from '../../binder/expression-binder.js';
import { combineConjuncts } from '../../binder/conjuncts.js';
import { DataType } from '../../storage/data-type.js';
import { SCALAR_OUTPUT_NAME } from '../../planner/logical-plan.js';

interface CorrelationResult {
  cleanedPlan: LogicalPlanNode;
  joinCondition: BoundExpr | null;
  correlatedPredicates: BoundExpr[];
}

interface PartitionedPredicates {
  correlatedPreds: BoundExpr[];
  localPreds: BoundExpr[];
}

interface RowLimit {
  count: number;
  offset: number;
  orderKeys: LogicalOrderKey[];
  input: LogicalPlanNode;
}

const ROW_NUMBER = 'ROW_NUMBER';

function rowLimitOf(node: LogicalPlanNode): RowLimit | null {
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

function spineOrderKeys(node: LogicalPlanNode): LogicalOrderKey[] {
  let current: LogicalPlanNode | undefined = node;
  while (current) {
    if (current.type === PlanNodeType.SORT || current.type === PlanNodeType.TOP_N) return current.orderKeys;
    if (current.type !== PlanNodeType.PROJECT) return [];
    current = current.children[0];
  }
  return [];
}

type ExprRecordValue = BoundExpr | BoundExpr[] | string | number | boolean | bigint | null | undefined | object;

export class SubqueryUnnesting extends OptimizationPass {
  override get name() { return 'SubqueryUnnesting'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    let current = plan;
    let changed = true;
    while (changed) {
      const rewriter = new UnnestingRewriter();
      const result = rewriter.rewrite(current);
      changed = rewriter.didChange;
      current = result;
    }
    return current;
  }
}

type Unnester = (
  rewriter: UnnestingRewriter,
  left: LogicalPlanNode,
  subquery: LogicalPlanNode,
  correlated: BoundColumnRefNode[],
  node: LogicalDependentJoinNode,
) => LogicalPlanNode;

const UNNESTERS: Record<string, Unnester> = {
  EXISTS: (r, left, subquery, correlated) => r.unnestExists(left, subquery, correlated),
  NOT_EXISTS: (r, left, subquery, correlated) => r.unnestNotExists(left, subquery, correlated),
  IN: (r, left, subquery, correlated, node) => r.unnestIn(left, subquery, correlated, node.condition, node.compareOp),
  MARK: (r, left, subquery, correlated, node) => r.unnestMark(left, subquery, correlated, node.condition, node.compareOp, node.markColumn!),
  SCALAR: (r, left, subquery, correlated, node) => r.unnestScalar(left, subquery, correlated, node.markColumn),
};

class UnnestingRewriter extends PlanRewriter {
  didChange: boolean;

  constructor() {
    super();
    this.didChange = false;
  }

  override rewriteDependentJoin(node: LogicalDependentJoinNode): LogicalPlanNode {
    const left = this.rewrite(node.children[0]);
    const subquery = this.rewrite(node.children[1]);
    const unnest = UNNESTERS[node.subqueryType];
    if (!unnest) return setChildren(node, [left, subquery]);
    this.didChange = true;
    return unnest(this, left, subquery, node.correlatedColumns || [], node);
  }

  unnestExists(left: LogicalPlanNode, subquery: LogicalPlanNode, correlated: BoundColumnRefNode[]): LogicalPlanNode {
    const { cleanedPlan, joinCondition } = this.extractCorrelation(subquery, correlated);
    return LogicalJoin(JoinType.SEMI, joinCondition, left, this.removeProjection(cleanedPlan));
  }

  unnestNotExists(left: LogicalPlanNode, subquery: LogicalPlanNode, correlated: BoundColumnRefNode[]): LogicalPlanNode {
    const { cleanedPlan, joinCondition } = this.extractCorrelation(subquery, correlated);
    return LogicalJoin(JoinType.ANTI, joinCondition, left, this.removeProjection(cleanedPlan));
  }

  unnestIn(left: LogicalPlanNode, subquery: LogicalPlanNode, correlated: BoundColumnRefNode[], outerExpr: BoundExpr | null, compareOp: string): LogicalPlanNode {
    const { cleanedPlan, joinCondition } = this.extractCorrelation(subquery, correlated);
    return LogicalJoin(
      JoinType.SEMI,
      this.membershipCondition(joinCondition, outerExpr, compareOp, subquery),
      left,
      this.removeProjection(cleanedPlan),
    );
  }

  unnestMark(left: LogicalPlanNode, subquery: LogicalPlanNode, correlated: BoundColumnRefNode[], outerExpr: BoundExpr | null, compareOp: string, markColumn: string): LogicalPlanNode {
    const { cleanedPlan, joinCondition } = this.extractCorrelation(subquery, correlated);
    return {
      ...LogicalJoin(
        JoinType.MARK,
        this.membershipCondition(joinCondition, outerExpr, compareOp, subquery),
        left,
        this.removeProjection(cleanedPlan),
      ),
      markColumn,
    };
  }

  membershipCondition(joinCondition: BoundExpr | null, outerExpr: BoundExpr | null, compareOp: string, subquery: LogicalPlanNode): BoundExpr | null {
    const conditions: BoundExpr[] = [];
    if (joinCondition) conditions.push(joinCondition);
    if (outerExpr) {
      const outputRef = this.getSubqueryOutputRef(subquery);
      if (outputRef) {
        conditions.push({
          kind: BoundExprKind.BINARY,
          op: compareOp,
          left: outerExpr,
          right: outputRef,
          resultType: DataType.BOOLEAN,
        });
      }
    }
    return combineConjuncts(conditions);
  }

  unnestScalar(left: LogicalPlanNode, subquery: LogicalPlanNode, correlated: BoundColumnRefNode[], scalarColumn: string | null): LogicalPlanNode {
    const { cleanedPlan, joinCondition, correlatedPredicates } = this.extractCorrelation(subquery, correlated);
    const outputRef = this.getSubqueryOutputRef(subquery);

    if (correlated.length > 0 && this.hasAggregate(subquery)) {
      const groupByExprs = this.getInnerCorrelationExprs(correlatedPredicates, correlated);

      const innerPlan = this.removeProjection(cleanedPlan);
      const aggregatedPlan = this.addGroupBy(innerPlan, groupByExprs);
      const scalarPlan = this.projectScalarOutput(aggregatedPlan, groupByExprs, outputRef, scalarColumn);
      return LogicalJoin(JoinType.LEFT, joinCondition, left, scalarPlan);
    }

    const innerRefs = this.getInnerCorrelationRefs(correlatedPredicates, correlated);
    const innerPlan = innerRefs.length > 0 ? this.removeProjection(cleanedPlan) : cleanedPlan;
    return LogicalJoin(JoinType.SINGLE, joinCondition, left, this.projectScalarOutput(innerPlan, innerRefs, outputRef, scalarColumn));
  }

  getInnerCorrelationRefs(correlatedPredicates: BoundExpr[], correlated: BoundColumnRefNode[]): BoundExpr[] {
    const refs: BoundExpr[] = [];
    const seen = new Set<string>();
    const isOuterRef = (node: BoundColumnRefNode): boolean =>
      node.isCorrelated
      || correlated.some(c => c.tableAlias === node.tableAlias && c.columnName === node.columnName);

    const visit = (expr: ExprRecordValue): void => {
      if (!expr || typeof expr !== 'object') return;
      const node = expr as BoundExpr;
      if (node.kind === BoundExprKind.COLUMN_REF) {
        if (isOuterRef(node)) return;
        const key = `${node.tableAlias}.${node.columnName}`.toUpperCase();
        if (!seen.has(key)) {
          seen.add(key);
          refs.push(node);
        }
        return;
      }
      for (const value of Object.values(expr as Record<string, ExprRecordValue>)) {
        if (Array.isArray(value)) {
          for (const item of value) visit(item);
        } else if (value && typeof value === 'object') {
          visit(value);
        }
      }
    };

    for (const pred of correlatedPredicates) visit(pred);
    return refs;
  }

  extractCorrelation(subquery: LogicalPlanNode, correlated: BoundColumnRefNode[]): CorrelationResult {
    const correlatedPredicates: BoundExpr[] = [];
    const prepared = this.decorrelateRowLimits(subquery, correlated);
    const cleanedPlan = this.removeCorrelatedPredicates(prepared, correlated, correlatedPredicates);

    const joinConditions = correlatedPredicates.map(pred => {
      return this.rewriteCorrelatedPredicate(pred, correlated);
    });

    return {
      cleanedPlan,
      joinCondition: combineConjuncts(joinConditions),
      correlatedPredicates,
    };
  }

  decorrelateRowLimits(node: LogicalPlanNode, correlated: BoundColumnRefNode[]): LogicalPlanNode {
    if (!node) return node;

    const children = getChildren(node);
    const newChildren = children.map(c => this.decorrelateRowLimits(c, correlated));
    const rebuilt = newChildren.some((c, i) => c !== children[i]) ? setChildren(node, newChildren) : node;

    const limit = rowLimitOf(rebuilt);
    if (!limit) return rebuilt;

    const inner = this.collectCorrelatedPredicates(rebuilt, correlated);
    if (inner.length === 0) return rebuilt;

    const partitionBy = this.getInnerCorrelationExprs(inner, correlated);
    if (partitionBy.length === 0 || !inner.every(pred => this.isEquiCorrelation(pred, correlated))) {
      throw new Error('Unsupported correlated subquery: a row-limiting clause correlated by a non-equality predicate cannot be decorrelated');
    }

    return this.applyPerPartitionLimit(limit, partitionBy);
  }

  applyPerPartitionLimit(limit: RowLimit, partitionBy: BoundExpr[]): LogicalPlanNode {
    const orderKeys = limit.orderKeys.length > 0 ? limit.orderKeys : spineOrderKeys(limit.input);
    const orderBy = orderKeys.map(key => ({ expr: key.expr, direction: key.direction, nullOrder: key.nullOrder }));
    const rowNumber = BoundWindow(ROW_NUMBER, [], partitionBy, orderBy, null, DataType.INT64);

    const projections: LogicalProjectNode[] = [];
    let inner: LogicalPlanNode = limit.input;
    while (inner.type === PlanNodeType.PROJECT) {
      projections.push(inner);
      inner = inner.children[0];
    }

    let ranked: LogicalPlanNode = LogicalFilter(this.rowNumberRange(rowNumber, limit.count, limit.offset), LogicalWindow([rowNumber], inner));
    for (let i = projections.length - 1; i >= 0; i--) {
      ranked = setChildren(projections[i], [ranked]);
    }
    return ranked;
  }

  rowNumberRange(rowNumber: BoundExpr, count: number, offset: number): BoundExpr {
    const bound = (op: string, value: number): BoundExpr =>
      BoundBinary(op, rowNumber, BoundLiteral(value, DataType.INT64), DataType.BOOLEAN);
    const upper = bound('<=', offset + count);
    return offset > 0 ? BoundBinary('AND', bound('>', offset), upper, DataType.BOOLEAN) : upper;
  }

  collectCorrelatedPredicates(node: LogicalPlanNode, correlated: BoundColumnRefNode[]): BoundExpr[] {
    const found: BoundExpr[] = [];
    const walk = (current: LogicalPlanNode): void => {
      if (!current) return;
      if (current.type === PlanNodeType.FILTER) {
        found.push(...this.partitionPredicates(current.condition, correlated).correlatedPreds);
      }
      for (const child of getChildren(current)) walk(child);
    };
    walk(node);
    return found;
  }

  isEquiCorrelation(pred: BoundExpr, correlated: BoundColumnRefNode[]): boolean {
    if (pred.kind !== BoundExprKind.BINARY || pred.op !== '=') return false;
    return this.hasCorrelatedRef(pred.left, correlated) !== this.hasCorrelatedRef(pred.right, correlated);
  }

  removeCorrelatedPredicates(node: LogicalPlanNode, correlated: BoundColumnRefNode[], collected: BoundExpr[]): LogicalPlanNode {
    if (!node) return node;

    if (node.type === PlanNodeType.FILTER) {
      const child = this.removeCorrelatedPredicates(node.children[0], correlated, collected);
      const { correlatedPreds, localPreds } = this.partitionPredicates(node.condition, correlated);
      collected.push(...correlatedPreds);
      if (localPreds.length === 0) return child;
      return LogicalFilter(combineConjuncts(localPreds), child);
    }

    if (node.type === PlanNodeType.PROJECT) {
      const child = this.removeCorrelatedPredicates(node.children[0], correlated, collected);
      return setChildren(node, [child]);
    }

    const children = getChildren(node);
    const newChildren = children.map(c => this.removeCorrelatedPredicates(c, correlated, collected));
    const changed = newChildren.some((c, i) => c !== children[i]);
    return changed ? setChildren(node, newChildren) : node;
  }

  partitionPredicates(expr: BoundExpr | null, correlated: BoundColumnRefNode[]): PartitionedPredicates {
    const correlatedPreds: BoundExpr[] = [];
    const localPreds: BoundExpr[] = [];

    const preds = this.splitConjuncts(expr);
    for (const pred of preds) {
      if (this.hasCorrelatedRef(pred, correlated)) {
        correlatedPreds.push(pred);
      } else {
        localPreds.push(pred);
      }
    }

    return { correlatedPreds, localPreds };
  }

  hasCorrelatedRef(expr: ExprRecordValue, correlated: BoundColumnRefNode[]): boolean {
    if (!expr || typeof expr !== 'object') return false;
    const node = expr as BoundExpr;
    if (node.kind === BoundExprKind.COLUMN_REF && node.isCorrelated) return true;
    if (node.kind === BoundExprKind.COLUMN_REF) {
      return correlated.some(c =>
        c.tableAlias === node.tableAlias && c.columnName === node.columnName
      );
    }
    for (const val of Object.values(expr as Record<string, ExprRecordValue>)) {
      if (Array.isArray(val)) {
        for (const item of val) {
          if (this.hasCorrelatedRef(item, correlated)) return true;
        }
      } else if (val && typeof val === 'object') {
        if (this.hasCorrelatedRef(val, correlated)) return true;
      }
    }
    return false;
  }

  rewriteCorrelatedPredicate(pred: BoundExpr, correlated: BoundColumnRefNode[]): BoundExpr {
    return this.rewriteExprRefs(pred, correlated);
  }

  rewriteExprRefs(expr: BoundExpr, correlated: BoundColumnRefNode[]): BoundExpr {
    if (!expr || typeof expr !== 'object') return expr;
    if (expr.kind === BoundExprKind.COLUMN_REF && expr.isCorrelated) {
      return { ...expr, depth: 0, isCorrelated: false };
    }
    if (expr.kind === BoundExprKind.COLUMN_REF) {
      const match = correlated.find(c =>
        c.tableAlias === expr.tableAlias && c.columnName === expr.columnName
      );
      if (match) {
        return { ...expr, depth: 0, isCorrelated: false };
      }
    }

    switch (expr.kind) {
      case BoundExprKind.BINARY:
        return { ...expr, left: this.rewriteExprRefs(expr.left, correlated), right: this.rewriteExprRefs(expr.right, correlated) };
      case BoundExprKind.UNARY:
        return { ...expr, operand: this.rewriteExprRefs(expr.operand, correlated) };
      case BoundExprKind.FUNCTION:
      case BoundExprKind.AGGREGATE:
        return { ...expr, args: expr.args.map(a => this.rewriteExprRefs(a, correlated)) };
      case BoundExprKind.CASE:
        return {
          ...expr,
          whenClauses: expr.whenClauses.map(wc => ({
            condition: this.rewriteExprRefs(wc.condition, correlated),
            result: this.rewriteExprRefs(wc.result, correlated),
          })),
          elseExpr: expr.elseExpr ? this.rewriteExprRefs(expr.elseExpr, correlated) : null,
        };
      case BoundExprKind.CAST:
        return { ...expr, expr: this.rewriteExprRefs(expr.expr, correlated) };
      case BoundExprKind.BETWEEN:
        return {
          ...expr,
          expr: this.rewriteExprRefs(expr.expr, correlated),
          low: this.rewriteExprRefs(expr.low, correlated),
          high: this.rewriteExprRefs(expr.high, correlated),
        };
      case BoundExprKind.IN_LIST:
        return {
          ...expr,
          expr: this.rewriteExprRefs(expr.expr, correlated),
          list: Array.isArray(expr.list)
            ? expr.list.map(item => this.rewriteExprRefs(item, correlated))
            : this.rewriteExprRefs(expr.list, correlated),
        };
      case BoundExprKind.LIKE:
        return {
          ...expr,
          expr: this.rewriteExprRefs(expr.expr, correlated),
          pattern: this.rewriteExprRefs(expr.pattern, correlated),
        };
      case BoundExprKind.IS_NULL:
        return { ...expr, expr: this.rewriteExprRefs(expr.expr, correlated) };
      case BoundExprKind.EXTRACT:
        return { ...expr, source: this.rewriteExprRefs(expr.source, correlated) };
      case BoundExprKind.WINDOW:
        return {
          ...expr,
          args: expr.args.map(a => this.rewriteExprRefs(a, correlated)),
          partitionBy: expr.partitionBy.map(p => this.rewriteExprRefs(p, correlated)),
          orderBy: expr.orderBy.map(ok => ({ ...ok, expr: this.rewriteExprRefs(ok.expr, correlated) })),
        };
      default:
        return expr;
    }
  }

  splitConjuncts(expr: BoundExpr | null): BoundExpr[] {
    if (!expr) return [];
    if (expr.kind === BoundExprKind.BINARY && expr.op === 'AND') {
      return [...this.splitConjuncts(expr.left), ...this.splitConjuncts(expr.right)];
    }
    return [expr];
  }

  getSubqueryOutputRef(subquery: LogicalPlanNode): ProjectedExpr | null {
    let node: LogicalPlanNode | undefined = subquery;
    while (node) {
      if (node.type === PlanNodeType.PROJECT && node.expressions?.length > 0) {
        return node.expressions[0];
      }
      node = node.children?.[0];
    }
    return null;
  }

  getInnerCorrelationExprs(correlatedPredicates: BoundExpr[], correlated: BoundColumnRefNode[]): BoundExpr[] {
    const exprs: BoundExpr[] = [];
    const seen = new Set<string>();

    for (const pred of correlatedPredicates) {
      if (pred.kind !== BoundExprKind.BINARY || pred.op !== '=') continue;

      const leftCorrelated = this.hasCorrelatedRef(pred.left, correlated);
      const rightCorrelated = this.hasCorrelatedRef(pred.right, correlated);
      let innerExpr: BoundExpr | null = null;

      if (leftCorrelated && !rightCorrelated) innerExpr = pred.right;
      else if (rightCorrelated && !leftCorrelated) innerExpr = pred.left;

      if (!innerExpr) continue;

      const rewritten = this.rewriteExprRefs(innerExpr, correlated);
      const key = JSON.stringify(rewritten);
      if (!seen.has(key)) {
        seen.add(key);
        exprs.push(rewritten);
      }
    }

    return exprs;
  }

  projectScalarOutput(plan: LogicalPlanNode, groupByExprs: BoundExpr[], outputRef: ProjectedExpr | null, scalarColumn: string | null): LogicalPlanNode {
    if (!outputRef) return plan;
    const scalarExpr = { ...outputRef, outputName: scalarColumn ?? SCALAR_OUTPUT_NAME };
    const expressions = [...groupByExprs, scalarExpr];
    if (plan.type === PlanNodeType.PROJECT && !plan.outputAlias) {
      return { ...plan, expressions };
    }
    const project: LogicalProjectNode = {
      type: PlanNodeType.PROJECT,
      expressions,
      children: [plan],
    };
    return project;
  }

  hasAggregate(node: LogicalPlanNode): boolean {
    if (!node) return false;
    if (node.type === PlanNodeType.AGGREGATE) return true;
    for (const child of getChildren(node)) {
      if (this.hasAggregate(child)) return true;
    }
    return false;
  }

  removeProjection(node: LogicalPlanNode): LogicalPlanNode {
    if (node.type === PlanNodeType.PROJECT) {
      return node.children[0];
    }
    return node;
  }

  addGroupBy(node: LogicalPlanNode, groupByExprs: BoundExpr[]): LogicalPlanNode {
    if (node.type === PlanNodeType.AGGREGATE) {
      return {
        ...node,
        groupBy: [...groupByExprs, ...(node.groupBy || [])],
      };
    }
    const children = getChildren(node);
    const newChildren = children.map(c => this.addGroupBy(c, groupByExprs));
    return setChildren(node, newChildren);
  }
}
