import * as LP from './logical-plan.js';
import { BoundExprKind, BoundColumnRef, collectCorrelatedColumns, type BoundExpr, type BoundColumnRefNode, type BoundLiteralNode } from '../binder/expression-binder.js';
import type { BoundQuery, BoundSelect, BoundSetOp, BoundFrom } from '../binder/binder.js';

let _cteIdCounter = 0;

function projectionExpr(item: { expr: BoundExpr; alias: string | null; inferredName: string | null }): LP.ProjectedExpr {
  const name = item.alias || item.inferredName;
  if (!name) return item.expr;
  return { ...item.expr, outputName: name };
}

export class LogicalPlanner {
  cteMap: Map<string, LP.LogicalPlanNode>;

  constructor() {
    this.cteMap = new Map();
  }

  plan(boundQuery: BoundQuery): LP.LogicalPlanNode {
    return this.planQuery(boundQuery);
  }

  planQuery(bound: BoundQuery): LP.LogicalPlanNode {
    if (bound.type === 'SetOp') {
      return this.planSetOp(bound);
    }
    return this.planSelect(bound);
  }

  planSetOp(bound: BoundSetOp): LP.LogicalPlanNode {
    const left = this.planQuery(bound.left);
    const right = this.planQuery(bound.right);
    return LP.LogicalUnion(left, right, bound.all);
  }

  planSelect(bound: BoundSelect): LP.LogicalPlanNode {
    let node: LP.LogicalPlanNode | null = null;

    if (bound.plan) {
      node = this.planFrom(bound.plan);
    } else {
      node = LP.LogicalSingleRow();
    }

    if (bound.where) {
      const { expr, subqueryJoins } = this.extractSubqueries(bound.where, node);
      for (const sj of subqueryJoins) {
        node = sj(node);
      }
      if (expr) {
        node = LP.LogicalFilter(expr, node);
      }
    }

    if (bound.aggregates.length > 0 || bound.groupBy) {
      node = LP.LogicalAggregate(
        bound.groupBy || [],
        bound.aggregates,
        node,
      );
    }

    if (bound.having) {
      const { expr, subqueryJoins } = this.extractSubqueries(bound.having, node);
      for (const sj of subqueryJoins) {
        node = sj(node);
      }
      if (expr) {
        node = LP.LogicalFilter(expr, node);
      }
    }

    for (let i = 0; i < bound.selectItems.length; i++) {
      const { expr, subqueryJoins } = this.extractSubqueries(bound.selectItems[i].expr, node);
      for (const sj of subqueryJoins) {
        node = sj(node);
      }
      bound.selectItems[i] = { ...bound.selectItems[i], expr: expr! };
    }

    const windowExprs: BoundExpr[] = [];
    for (const item of bound.selectItems) {
      this._collectWindows(item.expr, windowExprs);
    }
    if (windowExprs.length > 0) {
      node = LP.LogicalWindow(windowExprs, node);
    }

    if (bound.distinct) {
      const projections = bound.selectItems.map(projectionExpr);
      node = LP.LogicalProject(projections, node);
      node = LP.LogicalDistinct(node);
      if (bound.orderBy) {
        node = LP.LogicalSort(bound.orderBy, node);
      }
    } else {
      if (bound.orderBy) {
        node = LP.LogicalSort(bound.orderBy, node);
      }
      const projections = bound.selectItems.map(projectionExpr);
      node = LP.LogicalProject(projections, node);
    }

    if (bound.limit) {
      const limitVal = (bound.limit as BoundLiteralNode).value as number;
      const offsetVal = bound.offset ? (bound.offset as BoundLiteralNode).value as number : 0;
      node = LP.LogicalLimit(limitVal, offsetVal, node);
    }

    return node;
  }

  planFrom(bound: BoundFrom): LP.LogicalPlanNode {
    switch (bound.type) {
      case 'TableRef':
        return LP.LogicalScan(bound.tableName, bound.columns, bound.alias);

      case 'CTERef': {
        const cteId = _cteIdCounter++;
        const ctePlan = (bound.query as BoundQuery & { prebuiltPlan?: LP.LogicalPlanNode }).prebuiltPlan ?? this.planQuery(bound.query);
        this.cteMap.set(bound.cteName.toUpperCase(), ctePlan);
        return LP.LogicalCTEScan(bound.cteName, cteId);
      }

      case 'JoinRef': {
        const left = this.planFrom(bound.left);
        const right = this.planFrom(bound.right);
        const joinType = bound.joinType === 'CROSS' ? LP.JoinType.CROSS : LP.JoinType[bound.joinType as keyof typeof LP.JoinType];
        return LP.LogicalJoin(joinType, bound.condition, left, right);
      }

      case 'SubqueryRef': {
        const subPlan = this.planQuery(bound.query);
        return subPlan;
      }

      default:
        throw new Error(`Unknown from type: ${(bound as BoundFrom).type}`);
    }
  }

  extractSubqueries(expr: BoundExpr | null, currentPlan: LP.LogicalPlanNode): { expr: BoundExpr | null; subqueryJoins: Array<(child: LP.LogicalPlanNode) => LP.LogicalPlanNode> } {
    const subqueryJoins: Array<(child: LP.LogicalPlanNode) => LP.LogicalPlanNode> = [];

    const transformed = this.walkAndReplace(expr, (node: BoundExpr): BoundExpr | null => {
      if (node.kind === BoundExprKind.UNARY && node.op === 'NOT'
          && node.operand?.kind === BoundExprKind.EXISTS) {
        const subPlan = this.planQuery(node.operand.plan);
        const correlated = this.findCorrelatedRefs(node.operand.plan);
        subqueryJoins.push((child) =>
          LP.LogicalDependentJoin(child, subPlan, correlated, 'NOT_EXISTS', null)
        );
        return null;
      }

      if (node.kind === BoundExprKind.EXISTS) {
        const subPlan = this.planQuery(node.plan);
        const correlated = this.findCorrelatedRefs(node.plan);
        const subqueryType = node.negated ? 'NOT_EXISTS' : 'EXISTS';

        subqueryJoins.push((child) =>
          LP.LogicalDependentJoin(child, subPlan, correlated, subqueryType, null)
        );
        return null;
      }

      if (node.kind === BoundExprKind.IN_LIST && !Array.isArray(node.list) && node.list.kind === BoundExprKind.SUBQUERY) {
        const subPlan = this.planQuery(node.list.plan);
        const correlated = this.findCorrelatedRefs(node.list.plan);
        const subqueryType = node.negated ? 'NOT_IN' : 'IN';

        subqueryJoins.push((child) =>
          LP.LogicalDependentJoin(child, subPlan, correlated, subqueryType, node.expr)
        );
        return null;
      }

      if (node.kind === BoundExprKind.SUBQUERY && node.subqueryType === 'SCALAR') {
        const subPlan = this.planQuery(node.plan);
        const correlated = this.findCorrelatedRefs(node.plan);

        subqueryJoins.push((child) =>
          LP.LogicalDependentJoin(child, subPlan, correlated, 'SCALAR', null)
        );
        return {
          kind: BoundExprKind.COLUMN_REF,
          tableAlias: '',
          columnName: '_scalar',
          columnIndex: -1,
          dataType: 'FLOAT64',
          depth: 0,
          isCorrelated: false,
        };
      }

      return node;
    });

    return { expr: transformed, subqueryJoins };
  }

  walkAndReplace(expr: BoundExpr | null, fn: (node: BoundExpr) => BoundExpr | null): BoundExpr | null {
    if (!expr) return null;
    const result = fn(expr);
    if (result !== expr) return result;

    switch (expr.kind) {
      case BoundExprKind.BINARY:
        return {
          ...expr,
          left: this.walkAndReplace(expr.left, fn),
          right: this.walkAndReplace(expr.right, fn),
        } as BoundExpr;
      case BoundExprKind.UNARY:
        return { ...expr, operand: this.walkAndReplace(expr.operand, fn) } as BoundExpr;
      case BoundExprKind.CASE:
        return {
          ...expr,
          operand: expr.operand ? this.walkAndReplace(expr.operand, fn) : null,
          whenClauses: expr.whenClauses.map(wc => ({
            condition: this.walkAndReplace(wc.condition, fn),
            result: this.walkAndReplace(wc.result, fn),
          })),
          elseExpr: expr.elseExpr ? this.walkAndReplace(expr.elseExpr, fn) : null,
        } as BoundExpr;
      case BoundExprKind.BETWEEN:
        return {
          ...expr,
          expr: this.walkAndReplace(expr.expr, fn),
          low: this.walkAndReplace(expr.low, fn),
          high: this.walkAndReplace(expr.high, fn),
        } as BoundExpr;
      default:
        return expr;
    }
  }

  _collectWindows(expr: BoundExpr | null, out: BoundExpr[]): void {
    if (!expr) return;
    switch (expr.kind) {
      case BoundExprKind.WINDOW:
        out.push(expr);
        return;
      case BoundExprKind.BINARY:
        this._collectWindows(expr.left, out);
        this._collectWindows(expr.right, out);
        return;
      case BoundExprKind.UNARY:
        this._collectWindows(expr.operand, out);
        return;
      case BoundExprKind.FUNCTION:
      case BoundExprKind.AGGREGATE:
        for (const a of expr.args) this._collectWindows(a, out);
        return;
      case BoundExprKind.CASE:
        if (expr.operand) this._collectWindows(expr.operand, out);
        for (const wc of expr.whenClauses) {
          this._collectWindows(wc.condition, out);
          this._collectWindows(wc.result, out);
        }
        if (expr.elseExpr) this._collectWindows(expr.elseExpr, out);
        return;
    }
  }

  findCorrelatedRefs(boundQuery: BoundQuery): BoundColumnRefNode[] {
    const refs: BoundColumnRefNode[] = [];
    this._scanQuery(boundQuery, refs);
    return refs;
  }

  _scanQuery(q: BoundQuery, refs: BoundColumnRefNode[]): void {
    if (q.type === 'SetOp') {
      this._scanQuery(q.left, refs);
      this._scanQuery(q.right, refs);
      return;
    }
    if (q.plan) this._scanFrom(q.plan, refs);
    if (q.where) this._scanExpr(q.where, refs);
    if (q.having) this._scanExpr(q.having, refs);
    for (const g of q.groupBy || []) this._scanExpr(g, refs);
    for (const a of q.aggregates) this._scanExpr(a, refs);
    for (const item of q.selectItems) this._scanExpr(item.expr, refs);
    for (const ok of q.orderBy || []) this._scanExpr(ok.expr, refs);
    if (q.limit) this._scanExpr(q.limit, refs);
    if (q.offset) this._scanExpr(q.offset, refs);
  }

  _scanFrom(f: BoundFrom, refs: BoundColumnRefNode[]): void {
    switch (f.type) {
      case 'JoinRef':
        this._scanFrom(f.left, refs);
        this._scanFrom(f.right, refs);
        if (f.condition) this._scanExpr(f.condition, refs);
        return;
      case 'SubqueryRef':
        this._scanQuery(f.query, refs);
        return;
      case 'CTERef':
        this._scanQuery(f.query, refs);
        return;
    }
  }

  _scanExpr(e: BoundExpr | null, refs: BoundColumnRefNode[]): void {
    if (!e) return;
    switch (e.kind) {
      case BoundExprKind.COLUMN_REF:
        if (e.isCorrelated) refs.push(e);
        return;
      case BoundExprKind.BINARY:
        this._scanExpr(e.left, refs);
        this._scanExpr(e.right, refs);
        return;
      case BoundExprKind.UNARY:
        this._scanExpr(e.operand, refs);
        return;
      case BoundExprKind.FUNCTION:
      case BoundExprKind.AGGREGATE:
        for (const a of e.args) this._scanExpr(a, refs);
        return;
      case BoundExprKind.CASE:
        if (e.operand) this._scanExpr(e.operand, refs);
        for (const wc of e.whenClauses) {
          this._scanExpr(wc.condition, refs);
          this._scanExpr(wc.result, refs);
        }
        if (e.elseExpr) this._scanExpr(e.elseExpr, refs);
        return;
      case BoundExprKind.CAST:
        this._scanExpr(e.expr, refs);
        return;
      case BoundExprKind.BETWEEN:
        this._scanExpr(e.expr, refs);
        this._scanExpr(e.low, refs);
        this._scanExpr(e.high, refs);
        return;
      case BoundExprKind.IN_LIST:
        this._scanExpr(e.expr, refs);
        if (Array.isArray(e.list)) {
          for (const item of e.list) this._scanExpr(item, refs);
        } else {
          this._scanExpr(e.list, refs);
        }
        return;
      case BoundExprKind.LIKE:
        this._scanExpr(e.expr, refs);
        this._scanExpr(e.pattern, refs);
        return;
      case BoundExprKind.IS_NULL:
        this._scanExpr(e.expr, refs);
        return;
      case BoundExprKind.EXTRACT:
        this._scanExpr(e.source, refs);
        return;
      case BoundExprKind.WINDOW:
        for (const a of e.args) this._scanExpr(a, refs);
        for (const p of e.partitionBy) this._scanExpr(p, refs);
        for (const ok of e.orderBy) this._scanExpr(ok.expr, refs);
        return;
      case BoundExprKind.SUBQUERY:
        this._scanQuery(e.plan, refs);
        return;
      case BoundExprKind.EXISTS:
        this._scanQuery(e.plan, refs);
        return;
    }
  }
}

export function createLogicalPlan(boundQuery: BoundQuery): LP.LogicalPlanNode {
  const planner = new LogicalPlanner();
  const plan = planner.plan(boundQuery);
  plan._cteMap = planner.cteMap;
  return plan;
}
