import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, LogicalJoin, LogicalFilter, LogicalAggregate, getChildren, setChildren } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import { combineConjuncts } from './predicate-pushdown.js';

export class SubqueryUnnesting extends OptimizationPass {
  get name() { return 'SubqueryUnnesting'; }

  apply(plan) {
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

class UnnestingRewriter extends PlanRewriter {
  constructor() {
    super();
    this.didChange = false;
    this.markId = 0;
  }

  rewriteDependentJoin(node) {
    this.didChange = true;
    const left = this.rewrite(node.children[0]);
    const subquery = this.rewrite(node.children[1]);
    const correlated = node.correlatedColumns || [];

    switch (node.subqueryType) {
      case 'EXISTS':
        return this.unnestExists(left, subquery, correlated);
      case 'NOT_EXISTS':
        return this.unnestNotExists(left, subquery, correlated);
      case 'IN':
        return this.unnestIn(left, subquery, correlated, node.condition);
      case 'NOT_IN':
        return this.unnestNotIn(left, subquery, correlated, node.condition);
      case 'SCALAR':
        return this.unnestScalar(left, subquery, correlated);
      default:
        return setChildren(node, [left, subquery]);
    }
  }

  unnestExists(left, subquery, correlated) {
    const { cleanedPlan, joinCondition } = this.extractCorrelation(subquery, correlated);
    return LogicalJoin(JoinType.SEMI, joinCondition, left, this.removeProjection(cleanedPlan));
  }

  unnestNotExists(left, subquery, correlated) {
    const { cleanedPlan, joinCondition } = this.extractCorrelation(subquery, correlated);
    return LogicalJoin(JoinType.ANTI, joinCondition, left, this.removeProjection(cleanedPlan));
  }

  unnestIn(left, subquery, correlated, inExpr) {
    const { cleanedPlan, joinCondition } = this.extractCorrelation(subquery, correlated);
    const conditions = [];
    if (joinCondition) conditions.push(joinCondition);
    if (inExpr) {
      const outputRef = this.getSubqueryOutputRef(subquery);
      if (outputRef) {
        conditions.push({
          kind: BoundExprKind.BINARY,
          op: '=',
          left: inExpr,
          right: outputRef,
          resultType: 'BOOLEAN',
        });
      }
    }
    return LogicalJoin(JoinType.SEMI, combineConjuncts(conditions), left, this.exposeCorrelationColumns(cleanedPlan));
  }

  unnestNotIn(left, subquery, correlated, inExpr) {
    const { cleanedPlan, joinCondition } = this.extractCorrelation(subquery, correlated);
    const conditions = [];
    if (joinCondition) conditions.push(joinCondition);
    if (inExpr) {
      const outputRef = this.getSubqueryOutputRef(subquery);
      if (outputRef) {
        conditions.push({
          kind: BoundExprKind.BINARY,
          op: '=',
          left: inExpr,
          right: outputRef,
          resultType: 'BOOLEAN',
        });
      }
    }
    const markName = `__mark_${this.markId++}`;
    const markRef = {
      kind: BoundExprKind.COLUMN_REF,
      tableAlias: '',
      columnName: markName,
      columnIndex: -1,
      dataType: 'BOOLEAN',
      depth: 0,
      isCorrelated: false,
    };
    const markJoin = {
      ...LogicalJoin(JoinType.MARK, combineConjuncts(conditions), left, this.exposeCorrelationColumns(cleanedPlan)),
      markColumn: markName,
    };
    return LogicalFilter({
      kind: BoundExprKind.BINARY,
      op: '=',
      left: markRef,
      right: {
        kind: BoundExprKind.LITERAL,
        value: false,
        dataType: 'BOOLEAN',
      },
      resultType: 'BOOLEAN',
    }, markJoin);
  }

  unnestScalar(left, subquery, correlated) {
    const { cleanedPlan, joinCondition, correlatedPredicates } = this.extractCorrelation(subquery, correlated);
    const outputRef = this.getSubqueryOutputRef(subquery);

    if (correlated.length > 0 && this.hasAggregate(subquery)) {
      const groupByExprs = this.getInnerCorrelationExprs(correlatedPredicates, correlated);

      const innerPlan = this.removeProjection(cleanedPlan);
      const aggregatedPlan = this.addGroupBy(innerPlan, groupByExprs);
      const scalarPlan = this.projectScalarOutput(aggregatedPlan, groupByExprs, outputRef);
      return LogicalJoin(JoinType.LEFT, joinCondition, left, scalarPlan);
    }

    return LogicalJoin(JoinType.SINGLE, joinCondition, left, this.projectScalarOutput(cleanedPlan, [], outputRef));
  }

  extractCorrelation(subquery, correlated) {
    const correlatedPredicates = [];
    const cleanedPlan = this.removeCorrelatedPredicates(subquery, correlated, correlatedPredicates);

    const joinConditions = correlatedPredicates.map(pred => {
      return this.rewriteCorrelatedPredicate(pred, correlated);
    });

    return {
      cleanedPlan,
      joinCondition: combineConjuncts(joinConditions),
      correlatedPredicates,
    };
  }

  removeCorrelatedPredicates(node, correlated, collected) {
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

  partitionPredicates(expr, correlated) {
    const correlatedPreds = [];
    const localPreds = [];

    const preds = this.splitAnd(expr);
    for (const pred of preds) {
      if (this.hasCorrelatedRef(pred, correlated)) {
        correlatedPreds.push(pred);
      } else {
        localPreds.push(pred);
      }
    }

    return { correlatedPreds, localPreds };
  }

  hasCorrelatedRef(expr, correlated) {
    if (!expr || typeof expr !== 'object') return false;
    if (expr.kind === BoundExprKind.COLUMN_REF && expr.isCorrelated) return true;
    if (expr.kind === BoundExprKind.COLUMN_REF) {
      return correlated.some(c =>
        c.tableAlias === expr.tableAlias && c.columnName === expr.columnName
      );
    }
    for (const val of Object.values(expr)) {
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

  rewriteCorrelatedPredicate(pred, correlated) {
    return this.rewriteExprRefs(pred, correlated);
  }

  rewriteExprRefs(expr, correlated) {
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

    const result = {};
    for (const [key, val] of Object.entries(expr)) {
      if (Array.isArray(val)) {
        result[key] = val.map(item =>
          item && typeof item === 'object' ? this.rewriteExprRefs(item, correlated) : item
        );
      } else if (val && typeof val === 'object') {
        result[key] = this.rewriteExprRefs(val, correlated);
      } else {
        result[key] = val;
      }
    }
    return result;
  }

  splitAnd(expr) {
    if (!expr) return [];
    if (expr.kind === BoundExprKind.BINARY && expr.op === 'AND') {
      return [...this.splitAnd(expr.left), ...this.splitAnd(expr.right)];
    }
    return [expr];
  }

  getSubqueryOutputRef(subquery) {
    let node = subquery;
    while (node) {
      if (node.type === PlanNodeType.PROJECT && node.expressions?.length > 0) {
        return node.expressions[0];
      }
      node = node.children?.[0];
    }
    return null;
  }

  getInnerCorrelationExprs(correlatedPredicates, correlated) {
    const exprs = [];
    const seen = new Set();

    for (const pred of correlatedPredicates) {
      if (pred.kind !== BoundExprKind.BINARY || pred.op !== '=') continue;

      const leftCorrelated = this.hasCorrelatedRef(pred.left, correlated);
      const rightCorrelated = this.hasCorrelatedRef(pred.right, correlated);
      let innerExpr = null;

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

  projectScalarOutput(plan, groupByExprs, outputRef) {
    if (!outputRef) return plan;
    const scalarExpr = { ...outputRef, outputName: '_scalar' };
    return {
      type: PlanNodeType.PROJECT,
      expressions: [...groupByExprs, scalarExpr],
      children: [plan],
    };
  }

  hasAggregate(node) {
    if (!node) return false;
    if (node.type === PlanNodeType.AGGREGATE) return true;
    for (const child of getChildren(node)) {
      if (this.hasAggregate(child)) return true;
    }
    return false;
  }

  removeProjection(node) {
    if (node.type === PlanNodeType.PROJECT) {
      return node.children[0];
    }
    return node;
  }

  exposeCorrelationColumns(node) {
    if (node.type === PlanNodeType.PROJECT
      && (node.expressions || []).every(e => e.kind === BoundExprKind.COLUMN_REF)) {
      return node.children[0];
    }
    return node;
  }

  addGroupBy(node, groupByExprs) {
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
