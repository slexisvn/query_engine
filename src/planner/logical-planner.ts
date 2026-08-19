import * as LP from './logical-plan.js';
import { BoundExprKind, BoundColumnRef, collectCorrelatedColumns, type BoundExpr, type BoundColumnRefNode, type BoundLiteralNode } from '../binder/expression-binder.js';
import type { BoundQuery, BoundSelect, BoundSetOp, BoundFrom, OutputColumn } from '../binder/binder.js';
import { DataType } from '../storage/data-type.js';

let _cteIdCounter = 0;

export const SCALAR_OUTPUT_NAME = '_scalar';

const EMPTY_INPUT_AGGREGATES: ReadonlyMap<string, BoundLiteralNode> = new Map([
  ['COUNT', { kind: BoundExprKind.LITERAL, value: 0, dataType: DataType.INT64 }],
  ['COUNT_STAR', { kind: BoundExprKind.LITERAL, value: 0, dataType: DataType.INT64 }],
]);

function emptyInputValue(query: BoundQuery): BoundLiteralNode | null {
  if (query.type !== 'BoundSelect') return null;
  if (query.groupBy && query.groupBy.length > 0) return null;
  if (query.outputColumns.length !== 1) return null;
  const expr = query.outputColumns[0].expr;
  if (expr.kind !== BoundExprKind.AGGREGATE) return null;
  return EMPTY_INPUT_AGGREGATES.get(expr.name.toUpperCase()) ?? null;
}

const INVERSE_COMPARISON: ReadonlyMap<string, string> = new Map([
  ['=', '<>'],
  ['<>', '='],
  ['<', '>='],
  ['>', '<='],
  ['<=', '>'],
  ['>=', '<'],
]);

function inverseComparison(op: string): string {
  const inverse = INVERSE_COMPARISON.get(op);
  if (!inverse) throw new Error(`Quantified comparison does not support operator: ${op}`);
  return inverse;
}

const SET_OP_TYPES: ReadonlyMap<string, LP.SetOpType> = new Map([
  ['UNION', LP.SetOpType.UNION],
  ['INTERSECT', LP.SetOpType.INTERSECT],
  ['EXCEPT', LP.SetOpType.EXCEPT],
]);

function setOpTypeOf(op: string): LP.SetOpType {
  const setOp = SET_OP_TYPES.get(op.toUpperCase());
  if (!setOp) throw new Error(`Unsupported set operation: ${op}`);
  return setOp;
}

function applyLimit(node: LP.LogicalPlanNode, limit: BoundExpr | null, offset: BoundExpr | null): LP.LogicalPlanNode {
  if (!limit) return node;
  const limitValue = (limit as BoundLiteralNode).value as number;
  const offsetValue = offset ? (offset as BoundLiteralNode).value as number : 0;
  return LP.LogicalLimit(limitValue, offsetValue, node);
}

function notExpr(operand: BoundExpr): BoundExpr {
  return { kind: BoundExprKind.UNARY, op: 'NOT', operand, resultType: DataType.BOOLEAN };
}

function definedMark(mark: BoundColumnRefNode): BoundExpr {
  return {
    kind: BoundExprKind.FUNCTION,
    name: 'COALESCE',
    args: [mark, { kind: BoundExprKind.LITERAL, value: false, dataType: DataType.BOOLEAN }],
    resultType: DataType.BOOLEAN,
  };
}

function projectionExpr(item: { expr: BoundExpr; alias: string | null; inferredName: string | null }): LP.ProjectedExpr {
  const name = item.alias || item.inferredName;
  if (!name) return item.expr;
  return { ...item.expr, outputName: name };
}

export class LogicalPlanner {
  cteMap: Map<string, LP.LogicalPlanNode>;
  markCount: number;

  constructor() {
    this.cteMap = new Map();
    this.markCount = 0;
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
    let node: LP.LogicalPlanNode = LP.LogicalSetOp(setOpTypeOf(bound.op), left, right, bound.all);
    if (bound.orderBy) node = LP.LogicalSort(bound.orderBy, node);
    return applyLimit(node, bound.limit, bound.offset);
  }

  planSelect(bound: BoundSelect): LP.LogicalPlanNode {
    let node: LP.LogicalPlanNode | null = null;

    if (bound.plan) {
      node = this.planFrom(bound.plan);
    } else {
      node = LP.LogicalSingleRow();
    }

    if (bound.where) {
      const { expr, subqueryJoins } = this.extractSubqueries(bound.where, true);
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
      const { expr, subqueryJoins } = this.extractSubqueries(bound.having, true);
      for (const sj of subqueryJoins) {
        node = sj(node);
      }
      if (expr) {
        node = LP.LogicalFilter(expr, node);
      }
    }

    for (let i = 0; i < bound.selectItems.length; i++) {
      const { expr, subqueryJoins } = this.extractSubqueries(bound.selectItems[i].expr, false);
      for (const sj of subqueryJoins) {
        node = sj(node);
      }
      bound.selectItems[i] = { ...bound.selectItems[i], expr: expr! };
    }

    const windowExprs: BoundExpr[] = [];
    for (const item of bound.selectItems) {
      this._collectWindows(item.expr, windowExprs);
    }
    for (const key of bound.orderBy || []) {
      this._collectWindows(key.expr, windowExprs);
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

    return applyLimit(node, bound.limit, bound.offset);
  }

  planFrom(bound: BoundFrom): LP.LogicalPlanNode {
    switch (bound.type) {
      case 'TableRef':
        return LP.LogicalScan(bound.tableName, bound.columns, bound.alias);

      case 'CTERef': {
        const cteId = _cteIdCounter++;
        const ctePlan = (bound.query as BoundQuery & { prebuiltPlan?: LP.LogicalPlanNode }).prebuiltPlan ?? this.planQuery(bound.query);
        this.cteMap.set(bound.cteName.toUpperCase(), ctePlan);
        return LP.LogicalCTEScan(bound.cteName, cteId, bound.alias);
      }

      case 'JoinRef': {
        const left = this.planFrom(bound.left);
        const right = this.planFrom(bound.right);
        const joinType = bound.joinType === 'CROSS' ? LP.JoinType.CROSS : LP.JoinType[bound.joinType as keyof typeof LP.JoinType];
        return LP.LogicalJoin(joinType, bound.condition, left, right);
      }

      case 'SubqueryRef':
        return this.aliasRelation(this.planQuery(bound.query), bound.alias, bound.columns);

      default:
        throw new Error(`Unknown from type: ${(bound as BoundFrom).type}`);
    }
  }

  aliasRelation(plan: LP.LogicalPlanNode, alias: string, columns: OutputColumn[]): LP.LogicalPlanNode {
    if (plan.type === LP.PlanNodeType.PROJECT) return { ...plan, outputAlias: alias };
    const projections = columns.map((col, i) => ({
      ...BoundColumnRef(alias, col.name, i, col.dataType),
      outputName: col.name,
    }));
    return LP.LogicalProject(projections, plan, alias);
  }

  extractSubqueries(expr: BoundExpr | null, conjunctive: boolean): { expr: BoundExpr | null; subqueryJoins: Array<(child: LP.LogicalPlanNode) => LP.LogicalPlanNode> } {
    const subqueryJoins: Array<(child: LP.LogicalPlanNode) => LP.LogicalPlanNode> = [];

    const hoistMark = (plan: BoundQuery, outerExpr: BoundExpr | null, compareOp: string = '='): BoundColumnRefNode => {
      const markColumn = `__mark_${this.markCount++}`;
      const subPlan = this.planQuery(plan);
      const correlated = this.findCorrelatedRefs(plan);
      subqueryJoins.push((child) =>
        LP.LogicalDependentJoin(child, subPlan, correlated, 'MARK', outerExpr, markColumn, compareOp)
      );
      return BoundColumnRef('', markColumn, -1, DataType.BOOLEAN);
    };

    const hoistSemi = (plan: BoundQuery, outerExpr: BoundExpr | null, compareOp: string): void => {
      const subPlan = this.planQuery(plan);
      const correlated = this.findCorrelatedRefs(plan);
      subqueryJoins.push((child) =>
        LP.LogicalDependentJoin(child, subPlan, correlated, 'IN', outerExpr, null, compareOp)
      );
    };

    const transformed = this.walkAndReplace(expr, (node: BoundExpr, inConjunct: boolean): BoundExpr | null => {
      const negatedExists = node.kind === BoundExprKind.UNARY && node.op === 'NOT'
        && node.operand?.kind === BoundExprKind.EXISTS
        ? node.operand
        : null;

      if (negatedExists) {
        if (!inConjunct) return notExpr(definedMark(hoistMark(negatedExists.plan, null)));
        const subPlan = this.planQuery(negatedExists.plan);
        const correlated = this.findCorrelatedRefs(negatedExists.plan);
        subqueryJoins.push((child) =>
          LP.LogicalDependentJoin(child, subPlan, correlated, 'NOT_EXISTS', null)
        );
        return null;
      }

      if (node.kind === BoundExprKind.EXISTS) {
        if (!inConjunct) {
          const mark = definedMark(hoistMark(node.plan, null));
          return node.negated ? notExpr(mark) : mark;
        }
        const subPlan = this.planQuery(node.plan);
        const correlated = this.findCorrelatedRefs(node.plan);
        subqueryJoins.push((child) =>
          LP.LogicalDependentJoin(child, subPlan, correlated, node.negated ? 'NOT_EXISTS' : 'EXISTS', null)
        );
        return null;
      }

      if (node.kind === BoundExprKind.IN_LIST && !Array.isArray(node.list) && node.list.kind === BoundExprKind.SUBQUERY) {
        if (node.negated || !inConjunct) {
          const mark = hoistMark(node.list.plan, node.expr);
          return node.negated ? notExpr(mark) : mark;
        }
        hoistSemi(node.list.plan, node.expr, '=');
        return null;
      }

      if (node.kind === BoundExprKind.QUANTIFIED) {
        if (node.quantifier === 'ALL') {
          return notExpr(hoistMark(node.plan, node.expr, inverseComparison(node.op)));
        }
        if (!inConjunct) return hoistMark(node.plan, node.expr, node.op);
        hoistSemi(node.plan, node.expr, node.op);
        return null;
      }

      if (node.kind === BoundExprKind.SUBQUERY && node.subqueryType === 'SCALAR') {
        const subPlan = this.planQuery(node.plan);
        const correlated = this.findCorrelatedRefs(node.plan);

        subqueryJoins.push((child) =>
          LP.LogicalDependentJoin(child, subPlan, correlated, 'SCALAR', null)
        );
        const scalarType = node.plan.outputColumns[0]?.dataType ?? DataType.FLOAT64;
        const scalarRef = BoundColumnRef('', SCALAR_OUTPUT_NAME, -1, scalarType);
        const emptyValue = emptyInputValue(node.plan);
        if (!emptyValue) return scalarRef;
        return {
          kind: BoundExprKind.FUNCTION,
          name: 'COALESCE',
          args: [scalarRef, emptyValue],
          resultType: scalarType,
        };
      }

      return node;
    }, conjunctive);

    return { expr: transformed, subqueryJoins };
  }

  walkAndReplace(expr: BoundExpr | null, fn: (node: BoundExpr, conjunctive: boolean) => BoundExpr | null, conjunctive: boolean): BoundExpr | null {
    if (!expr) return null;
    const result = fn(expr, conjunctive);
    if (result !== expr) return result;

    switch (expr.kind) {
      case BoundExprKind.BINARY: {
        const childConjunctive = conjunctive && expr.op === 'AND';
        return {
          ...expr,
          left: this.walkAndReplace(expr.left, fn, childConjunctive),
          right: this.walkAndReplace(expr.right, fn, childConjunctive),
        } as BoundExpr;
      }
      case BoundExprKind.UNARY:
        return { ...expr, operand: this.walkAndReplace(expr.operand, fn, false) } as BoundExpr;
      case BoundExprKind.CASE:
        return {
          ...expr,
          operand: expr.operand ? this.walkAndReplace(expr.operand, fn, false) : null,
          whenClauses: expr.whenClauses.map(wc => ({
            condition: this.walkAndReplace(wc.condition, fn, false),
            result: this.walkAndReplace(wc.result, fn, false),
          })),
          elseExpr: expr.elseExpr ? this.walkAndReplace(expr.elseExpr, fn, false) : null,
        } as BoundExpr;
      case BoundExprKind.BETWEEN:
        return {
          ...expr,
          expr: this.walkAndReplace(expr.expr, fn, false),
          low: this.walkAndReplace(expr.low, fn, false),
          high: this.walkAndReplace(expr.high, fn, false),
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
      case BoundExprKind.QUANTIFIED:
        this._scanExpr(e.expr, refs);
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
