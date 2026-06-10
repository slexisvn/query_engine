import * as LP from './logical-plan.js';
import { BoundExprKind, BoundColumnRef, collectCorrelatedColumns } from '../binder/expression-binder.js';

let _cteIdCounter = 0;

function projectionExpr(item) {
  const name = item.alias || item.inferredName;
  if (!name) return item.expr;
  return { ...item.expr, outputName: name };
}

export class LogicalPlanner {
  constructor() {
    this.cteMap = new Map();
  }

  plan(boundQuery) {
    return this.planQuery(boundQuery);
  }

  planQuery(bound) {
    if (bound.type === 'SetOp') {
      return this.planSetOp(bound);
    }
    return this.planSelect(bound);
  }

  planSetOp(bound) {
    const left = this.planQuery(bound.left);
    const right = this.planQuery(bound.right);
    return LP.LogicalUnion(left, right, bound.all);
  }

  planSelect(bound) {
    let node = null;

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
      bound.selectItems[i] = { ...bound.selectItems[i], expr };
    }

    const windowExprs = [];
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
      const limitVal = bound.limit.value;
      const offsetVal = bound.offset ? bound.offset.value : 0;
      node = LP.LogicalLimit(limitVal, offsetVal, node);
    }

    return node;
  }

  planFrom(bound) {
    switch (bound.type) {
      case 'TableRef':
        return LP.LogicalScan(bound.tableName, bound.columns, bound.alias);

      case 'CTERef': {
        const cteId = _cteIdCounter++;
        const ctePlan = this.planQuery(bound.query);
        this.cteMap.set(bound.cteName.toUpperCase(), ctePlan);
        return LP.LogicalCTEScan(bound.cteName, cteId);
      }

      case 'JoinRef': {
        const left = this.planFrom(bound.left);
        const right = this.planFrom(bound.right);
        const joinType = bound.joinType === 'CROSS' ? LP.JoinType.CROSS : LP.JoinType[bound.joinType];
        return LP.LogicalJoin(joinType, bound.condition, left, right);
      }

      case 'SubqueryRef': {
        const subPlan = this.planQuery(bound.query);
        return subPlan;
      }

      default:
        throw new Error(`Unknown from type: ${bound.type}`);
    }
  }

  extractSubqueries(expr, currentPlan) {
    const subqueryJoins = [];

    const transformed = this.walkAndReplace(expr, (node) => {
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

      if (node.kind === BoundExprKind.IN_LIST && node.list?.kind === BoundExprKind.SUBQUERY) {
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

  walkAndReplace(expr, fn) {
    if (!expr) return null;
    const result = fn(expr);
    if (result !== expr) return result;

    switch (expr.kind) {
      case BoundExprKind.BINARY:
        return {
          ...expr,
          left: this.walkAndReplace(expr.left, fn),
          right: this.walkAndReplace(expr.right, fn),
        };
      case BoundExprKind.UNARY:
        return { ...expr, operand: this.walkAndReplace(expr.operand, fn) };
      case BoundExprKind.CASE:
        return {
          ...expr,
          operand: expr.operand ? this.walkAndReplace(expr.operand, fn) : null,
          whenClauses: expr.whenClauses.map(wc => ({
            condition: this.walkAndReplace(wc.condition, fn),
            result: this.walkAndReplace(wc.result, fn),
          })),
          elseExpr: expr.elseExpr ? this.walkAndReplace(expr.elseExpr, fn) : null,
        };
      case BoundExprKind.BETWEEN:
        return {
          ...expr,
          expr: this.walkAndReplace(expr.expr, fn),
          low: this.walkAndReplace(expr.low, fn),
          high: this.walkAndReplace(expr.high, fn),
        };
      default:
        return expr;
    }
  }

  _collectWindows(expr, out) {
    if (!expr) return;
    if (expr.kind === BoundExprKind.WINDOW) {
      out.push(expr);
      return;
    }
    if (expr.left) this._collectWindows(expr.left, out);
    if (expr.right) this._collectWindows(expr.right, out);
    if (expr.operand) this._collectWindows(expr.operand, out);
    if (expr.args) for (const a of expr.args) this._collectWindows(a, out);
    if (expr.whenClauses) for (const wc of expr.whenClauses) {
      this._collectWindows(wc.condition, out);
      this._collectWindows(wc.result, out);
    }
    if (expr.elseExpr) this._collectWindows(expr.elseExpr, out);
  }

  findCorrelatedRefs(boundQuery) {
    const refs = [];
    this._scanForCorrelated(boundQuery, refs);
    return refs;
  }

  _scanForCorrelated(obj, refs) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.kind === BoundExprKind.COLUMN_REF && obj.isCorrelated) {
      refs.push(obj);
      return;
    }
    for (const val of Object.values(obj)) {
      if (Array.isArray(val)) {
        for (const item of val) this._scanForCorrelated(item, refs);
      } else if (val && typeof val === 'object') {
        this._scanForCorrelated(val, refs);
      }
    }
  }
}

export function createLogicalPlan(boundQuery) {
  const planner = new LogicalPlanner();
  const plan = planner.plan(boundQuery);
  plan._cteMap = planner.cteMap;
  return plan;
}
