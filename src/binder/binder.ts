import { NodeKind } from '../parser/ast.js';
import type * as AST from '../parser/ast.js';
import { DataType, dateToEpochDays, timestampToEpochMs, normalizeTypeName } from '../storage/data-type.js';
import { BinderScope, type ColumnInfo } from './scope.js';
import * as BE from './expression-binder.js';

export interface TableMeta { name: string; columns: ColumnInfo[]; }

export interface CatalogLike { getTable(name: string): TableMeta | undefined; }

export interface OutputColumn { name: string; expr: BE.BoundExpr; dataType: string | null; }

export interface BoundSelectItem { expr: BE.BoundExpr; alias: string | null; inferredName: string | null; }

export interface BoundOrderKey { expr: BE.BoundExpr; direction: string; nullOrder: string | null; }

export interface BoundTableRef { type: 'TableRef'; tableName: string; alias: string; columns: ColumnInfo[]; }

export interface BoundCTERef { type: 'CTERef'; cteName: string; alias: string; columns: ColumnInfo[]; query: BoundQuery; }

export interface BoundJoinRef { type: 'JoinRef'; joinType: string; left: BoundFrom; right: BoundFrom; condition: BE.BoundExpr | null; }

export interface BoundSubqueryRef { type: 'SubqueryRef'; alias: string; query: BoundQuery; columns: OutputColumn[]; }

export type BoundFrom = BoundTableRef | BoundCTERef | BoundJoinRef | BoundSubqueryRef;

export interface BoundSelect {
  type: 'BoundSelect';
  plan: BoundFrom | null;
  selectItems: BoundSelectItem[];
  where: BE.BoundExpr | null;
  groupBy: BE.BoundExpr[] | null;
  aggregates: BE.BoundExpr[];
  having: BE.BoundExpr | null;
  orderBy: BoundOrderKey[] | null;
  limit: BE.BoundExpr | null;
  offset: BE.BoundExpr | null;
  distinct: boolean;
  outputColumns: OutputColumn[];
}

export interface BoundSetOp {
  type: 'SetOp';
  op: string;
  all: boolean;
  left: BoundQuery;
  right: BoundQuery;
  outputColumns: OutputColumn[];
}

export type BoundQuery = BoundSelect | BoundSetOp;

interface CteInfo { name: string; columns: ColumnInfo[]; bound: BoundQuery; }

interface JoinSide { type?: string; columns?: ColumnInfo[]; alias?: string; tableName?: string; cteName?: string; }

function valueDataType(value: BE.LiteralValue): string | null {
  switch (typeof value) {
    case 'boolean': return DataType.BOOLEAN;
    case 'bigint': return DataType.INT64;
    case 'string': return DataType.VARCHAR;
    case 'number': return Number.isInteger(value) ? DataType.INT32 : DataType.FLOAT64;
    default: return null;
  }
}

export class Binder {
  catalog: CatalogLike;
  functionRegistry: object;
  cteScopes: Map<string, CteInfo>;
  aggregatesFound: BE.BoundExpr[];
  params: readonly BE.LiteralValue[];

  constructor(catalog: CatalogLike, functionRegistry: object, params: readonly BE.LiteralValue[] = []) {
    this.catalog = catalog;
    this.functionRegistry = functionRegistry;
    this.cteScopes = new Map();
    this.aggregatesFound = [];
    this.params = params;
  }

  bind(ast: AST.QueryStmt): BoundQuery {
    const scope = new BinderScope();
    return this.bindQuery(ast, scope);
  }

  bindQuery(node: AST.QueryStmt, scope: BinderScope): BoundQuery {
    if (node.kind === NodeKind.SET_OP) {
      return this.bindSetOp(node, scope);
    }
    return this.bindSelect(node, scope);
  }

  bindSetOp(node: AST.SetOpNode, scope: BinderScope): BoundSetOp {
    const left = this.bindQuery(node.left, scope);
    const right = this.bindQuery(node.right, scope);
    return {
      type: 'SetOp',
      op: node.op,
      all: node.all,
      left,
      right,
      outputColumns: left.outputColumns,
    };
  }

  bindSelect(node: AST.SelectStmtNode, scope: BinderScope): BoundSelect {
    if (node.withClause) {
      this.bindWithClause(node.withClause, scope);
    }

    const fromScope = scope.child();

    let plan: BoundFrom | null = null;
    if (node.from) {
      plan = this.bindFrom(node.from, fromScope);
    }

    const savedAggregates = this.aggregatesFound;
    this.aggregatesFound = [];
    let outputColumns: OutputColumn[] = [];

    const boundSelectItems = this.bindSelectItems(node.selectItems, fromScope);

    let where: BE.BoundExpr | null = null;
    if (node.where) {
      where = this.bindExpression(node.where, fromScope);
    }

    const aggregates = [...this.aggregatesFound];

    const selectAliasMap = new Map<string, BE.BoundExpr>();
    for (const item of boundSelectItems) {
      const alias = item.alias || item.inferredName;
      if (alias) {
        selectAliasMap.set(alias.toUpperCase(), item.expr);
      }
    }

    let groupBy: BE.BoundExpr[] | null = null;
    if (node.groupBy) {
      groupBy = node.groupBy.map(expr => this.bindKeyWithAlias(expr, fromScope, selectAliasMap));
    }

    let having: BE.BoundExpr | null = null;
    if (node.having) {
      having = this.bindExpression(node.having, fromScope);
      aggregates.push(...this.aggregatesFound.slice(aggregates.length));
    }

    this.aggregatesFound = savedAggregates;

    let orderBy: BoundOrderKey[] | null = null;
    if (node.orderBy) {
      orderBy = node.orderBy.map(ok => ({
        expr: this.bindKeyWithAlias(ok.expr, fromScope, selectAliasMap),
        direction: ok.direction,
        nullOrder: ok.nullOrder,
      }));
    }

    let limit: BE.BoundExpr | null = null;
    if (node.limit) {
      limit = this.bindExpression(node.limit, fromScope);
    }

    let offset: BE.BoundExpr | null = null;
    if (node.offset) {
      offset = this.bindExpression(node.offset, fromScope);
    }

    outputColumns = boundSelectItems.map((item, i) => ({
      name: item.alias || item.inferredName || `col${i}`,
      expr: item.expr,
      dataType: BE.getExprType(item.expr),
    }));

    return {
      type: 'BoundSelect',
      plan,
      selectItems: boundSelectItems,
      where,
      groupBy,
      aggregates,
      having,
      orderBy,
      limit,
      offset,
      distinct: node.distinct,
      outputColumns,
    };
  }

  bindKeyWithAlias(expr: AST.Expr, scope: BinderScope, selectAliasMap: Map<string, BE.BoundExpr>): BE.BoundExpr {
    if (expr.kind === NodeKind.COLUMN_REF && !expr.table) {
      const aliasExpr = selectAliasMap.get(expr.name.toUpperCase());
      if (aliasExpr) return aliasExpr;
    }
    return this.bindExpression(expr, scope);
  }

  bindWithClause(withClause: AST.WithClauseNode, scope: BinderScope): void {
    for (const cte of withClause.ctes) {
      const cteScope = scope.child();
      const bound = this.bindQuery(cte.query, cteScope);
      const columns = bound.outputColumns.map((col, i) => ({
        name: cte.columnAliases ? cte.columnAliases[i] : col.name,
        dataType: col.dataType,
      }));
      this.cteScopes.set(cte.name.toUpperCase(), {
        name: cte.name,
        columns,
        bound,
      });
    }
  }

  bindFrom(node: AST.FromItem, scope: BinderScope): BoundFrom {
    switch (node.kind) {
      case NodeKind.TABLE_REF:
        return this.bindTableRef(node, scope);
      case NodeKind.JOIN_REF:
        return this.bindJoinRef(node, scope);
      case NodeKind.SUBQUERY_REF:
        return this.bindSubqueryRef(node, scope);
      default:
        throw new Error(`Unknown FROM node kind: ${(node as AST.FromItem).kind}`);
    }
  }

  bindTableRef(node: AST.TableRefNode, scope: BinderScope): BoundTableRef | BoundCTERef {
    const upperName = node.name.toUpperCase();
    const cte = this.cteScopes.get(upperName);
    if (cte) {
      scope.addTable(node.alias, {
        originalName: cte.name,
        columns: cte.columns,
        isCTE: true,
      });
      return {
        type: 'CTERef',
        cteName: cte.name,
        alias: node.alias.toUpperCase(),
        columns: cte.columns,
        query: cte.bound,
      };
    }

    const tableInfo = this.catalog.getTable(node.name);
    if (!tableInfo) {
      throw new Error(`Unknown table: ${node.name}`);
    }

    scope.addTable(node.alias, {
      originalName: tableInfo.name,
      columns: tableInfo.columns,
    });

    return {
      type: 'TableRef',
      tableName: tableInfo.name,
      alias: node.alias.toUpperCase(),
      columns: tableInfo.columns,
    };
  }

  bindJoinRef(node: AST.JoinRefNode, scope: BinderScope): BoundJoinRef {
    const left = this.bindFrom(node.left, scope);
    const right = this.bindFrom(node.right, scope);

    let condition: BE.BoundExpr | null = null;

    if (node.natural) {
      condition = this.buildNaturalJoinCondition(left, right, scope);
    } else if (node.usingColumns) {
      condition = this.buildUsingCondition(node.usingColumns, left, right, scope);
    } else if (node.condition) {
      condition = this.bindExpression(node.condition, scope);
    }

    return {
      type: 'JoinRef',
      joinType: node.joinType,
      left,
      right,
      condition,
    };
  }

  buildNaturalJoinCondition(left: BoundFrom, right: BoundFrom, scope: BinderScope): BE.BoundExpr | null {
    const leftCols = this.getRefColumnNames(left);
    const rightCols = this.getRefColumnNames(right);
    const common = leftCols.filter(n => rightCols.includes(n));
    if (common.length === 0) return null;
    return this.buildUsingCondition(common, left, right, scope);
  }

  buildUsingCondition(columnNames: string[], left: BoundFrom, right: BoundFrom, scope: BinderScope): BE.BoundExpr | null {
    let condition: BE.BoundExpr | null = null;
    for (const colName of columnNames) {
      const leftRef = scope.resolveColumn(colName, this.getRefAlias(left));
      const rightRef = scope.resolveColumn(colName, this.getRefAlias(right));
      if (!leftRef || !rightRef) throw new Error(`USING column not found: ${colName}`);
      const eq = BE.BoundBinary('=',
        BE.BoundColumnRef(leftRef.tableAlias, leftRef.column.name, leftRef.columnIndex, leftRef.column.dataType),
        BE.BoundColumnRef(rightRef.tableAlias, rightRef.column.name, rightRef.columnIndex, rightRef.column.dataType),
        DataType.BOOLEAN
      );
      condition = condition ? BE.BoundBinary('AND', condition, eq, DataType.BOOLEAN) : eq;
    }
    return condition;
  }

  getRefColumnNames(ref: JoinSide): string[] {
    const cols = ref.columns || [];
    return cols.map(c => c.name.toUpperCase());
  }

  getRefAlias(ref: JoinSide): string | null {
    return ref.alias || ref.tableName || ref.cteName || null;
  }

  bindSubqueryRef(node: AST.SubqueryRefNode, scope: BinderScope): BoundSubqueryRef {
    const subScope = scope.child();
    const bound = this.bindQuery(node.query, subScope);

    const alias = node.alias || '_subquery';
    scope.addTable(alias, {
      originalName: alias,
      columns: bound.outputColumns.map(c => ({ name: c.name, dataType: c.dataType })),
    });

    return {
      type: 'SubqueryRef',
      alias: alias.toUpperCase(),
      query: bound,
      columns: bound.outputColumns,
    };
  }

  bindSelectItems(items: AST.SelectItemNode[], scope: BinderScope): BoundSelectItem[] {
    const result: BoundSelectItem[] = [];
    for (const item of items) {
      if (item.expr.kind === NodeKind.ALL_COLUMNS) {
        const expanded = this.expandStar(item.expr, scope);
        result.push(...expanded);
      } else {
        const expr = this.bindExpression(item.expr, scope);
        result.push({
          expr,
          alias: item.alias,
          inferredName: this.inferColumnName(item.expr),
        });
      }
    }
    return result;
  }

  expandStar(node: AST.AllColumnsNode, scope: BinderScope): BoundSelectItem[] {
    if (node.table) {
      const cols = scope.getTableColumns(node.table);
      if (!cols) throw new Error(`Unknown table for star: ${node.table}`);
      return cols.map(c => ({
        expr: BE.BoundColumnRef(c.tableAlias, c.column.name, c.columnIndex, c.column.dataType),
        alias: null,
        inferredName: c.column.name,
      }));
    }
    return scope.getAllColumns().map(c => ({
      expr: BE.BoundColumnRef(c.tableAlias, c.column.name, c.columnIndex, c.column.dataType),
      alias: null,
      inferredName: c.column.name,
    }));
  }

  bindExpression(node: AST.Expr | AST.QuantifiedSubqueryNode, scope: BinderScope): BE.BoundExpr {
    if (!node) return null!;

    switch (node.kind) {
      case NodeKind.COLUMN_REF:
        return this.bindColumnRef(node, scope);

      case NodeKind.LITERAL:
        return this.bindLiteral(node);

      case NodeKind.PARAMETER:
        return this.bindParameter(node);

      case NodeKind.BINARY_EXPR:
        return this.bindBinaryExpr(node, scope);

      case NodeKind.UNARY_EXPR:
        return this.bindUnaryExpr(node, scope);

      case NodeKind.AGGREGATE_CALL:
        return this.bindAggregateCall(node, scope);

      case NodeKind.FUNCTION_CALL:
        return this.bindFunctionCall(node, scope);

      case NodeKind.CASE_EXPR:
        return this.bindCaseExpr(node, scope);

      case NodeKind.CAST_EXPR:
        return this.bindCastExpr(node, scope);

      case NodeKind.BETWEEN_EXPR:
        return BE.BoundBetween(
          this.bindExpression(node.expr, scope),
          this.bindExpression(node.low, scope),
          this.bindExpression(node.high, scope),
          node.negated,
        );

      case NodeKind.IN_EXPR:
        return this.bindInExpr(node, scope);

      case NodeKind.LIKE_EXPR:
        return BE.BoundLike(
          this.bindExpression(node.expr, scope),
          this.bindExpression(node.pattern, scope),
          node.negated,
        );

      case NodeKind.IS_NULL_EXPR:
        return BE.BoundIsNull(this.bindExpression(node.expr, scope), node.negated);

      case NodeKind.EXISTS_EXPR:
        return this.bindExistsExpr(node, scope);

      case NodeKind.SUBQUERY_EXPR:
        return this.bindSubqueryExpr(node, scope);

      case NodeKind.EXTRACT_EXPR:
        return BE.BoundExtract(node.field, this.bindExpression(node.source, scope));

      case NodeKind.SUBSTRING_EXPR:
        return BE.BoundFunction('SUBSTRING', [
          this.bindExpression(node.expr, scope),
          this.bindExpression(node.from, scope),
          node.length ? this.bindExpression(node.length, scope) : null,
        ].filter(Boolean) as BE.BoundExpr[], DataType.VARCHAR);

      case NodeKind.INTERVAL_EXPR:
        return BE.BoundInterval(parseInt(node.value, 10), node.unit);

      case NodeKind.WINDOW_CALL:
        return this.bindWindowCall(node, scope);

      case NodeKind.ALL_COLUMNS:
        throw new Error('Star expression in unexpected position');

      default:
        throw new Error(`Unhandled expression kind: ${(node as { kind: string }).kind}`);
    }
  }

  bindWindowCall(node: AST.WindowCallNode, scope: BinderScope): BE.BoundWindowNode {
    const args = node.args.map(a => this.bindExpression(a, scope));
    const partitionBy = node.windowSpec.partitionBy.map(e => this.bindExpression(e, scope));
    const orderBy = node.windowSpec.orderBy.map(ok => ({
      expr: this.bindExpression(ok.expr, scope),
      direction: ok.direction,
      nullOrder: ok.nullOrder,
    }));
    const resultType = this.inferWindowType(node.name, args);
    return BE.BoundWindow(node.name.toUpperCase(), args, partitionBy, orderBy, resultType);
  }

  bindColumnRef(node: AST.ColumnRefNode, scope: BinderScope): BE.BoundColumnRefNode {
    const resolved = scope.resolveColumn(node.name, node.table);
    if (!resolved) {
      throw new Error(`Unknown column: ${node.table ? `${node.table}.` : ''}${node.name}`);
    }
    return BE.BoundColumnRef(
      resolved.tableAlias,
      resolved.column.name,
      resolved.columnIndex,
      resolved.column.dataType,
      resolved.depth,
    );
  }

  bindLiteral(node: AST.LiteralNode): BE.BoundLiteralNode {
    if (node.value === null) {
      return BE.BoundLiteral(null, null);
    }
    if (node.dataType === 'DATE') {
      const [y, m, d] = (node.value as string).split('-').map(Number);
      return BE.BoundLiteral(dateToEpochDays(y, m, d), DataType.DATE);
    }
    if (node.dataType === 'TIMESTAMP') {
      const parts = (node.value as string).split(/[T ]/);
      const [y, mo, d] = parts[0].split('-').map(Number);
      let h = 0, mi = 0, s = 0, ms = 0;
      if (parts[1]) {
        const timeParts = parts[1].split(':');
        h = Number(timeParts[0]) || 0;
        mi = Number(timeParts[1]) || 0;
        if (timeParts[2]) {
          const secParts = timeParts[2].split('.');
          s = Number(secParts[0]) || 0;
          ms = secParts[1] ? Number(secParts[1].padEnd(3, '0').slice(0, 3)) : 0;
        }
      }
      return BE.BoundLiteral(timestampToEpochMs(y, mo, d, h, mi, s, ms), DataType.TIMESTAMP);
    }
    if (node.dataType === 'BOOLEAN') {
      return BE.BoundLiteral(node.value, DataType.BOOLEAN);
    }
    if (node.dataType === 'VARCHAR') {
      return BE.BoundLiteral(node.value, DataType.VARCHAR);
    }
    if (typeof node.value === 'number') {
      if (Number.isInteger(node.value)) {
        return BE.BoundLiteral(node.value, DataType.INT32);
      }
      return BE.BoundLiteral(node.value, DataType.FLOAT64);
    }
    return BE.BoundLiteral(node.value, DataType.VARCHAR);
  }

  bindParameter(node: AST.ParameterNode): BE.BoundLiteralNode {
    if (node.index < 1 || node.index > this.params.length) {
      throw new Error(`Missing value for parameter $${node.index}`);
    }
    const value = this.params[node.index - 1];
    return BE.BoundLiteral(value, valueDataType(value));
  }

  bindBinaryExpr(node: AST.BinaryExprNode, scope: BinderScope): BE.BoundBinaryNode {
    const left = this.bindExpression(node.left, scope);
    const right = this.bindExpression(node.right, scope);
    const op = node.op;

    if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
      return BE.BoundBinary(op, left, right, DataType.BOOLEAN);
    }
    if (['AND', 'OR'].includes(op)) {
      return BE.BoundBinary(op, left, right, DataType.BOOLEAN);
    }
    if (['||'].includes(op)) {
      return BE.BoundBinary(op, left, right, DataType.VARCHAR);
    }

    const resultType = this.inferArithmeticType(BE.getExprType(left), BE.getExprType(right));
    return BE.BoundBinary(op, left, right, resultType);
  }

  bindUnaryExpr(node: AST.UnaryExprNode, scope: BinderScope): BE.BoundUnaryNode {
    const operand = this.bindExpression(node.operand, scope);
    if (node.op === 'NOT') {
      return BE.BoundUnary('NOT', operand, DataType.BOOLEAN);
    }
    return BE.BoundUnary(node.op, operand, BE.getExprType(operand));
  }

  bindAggregateCall(node: AST.AggregateCallNode, scope: BinderScope): BE.BoundAggregateNode {
    const args = node.args.map(a => this.bindExpression(a, scope));
    const resultType = this.inferAggregateType(node.name, args);
    const bound = BE.BoundAggregate(node.name, args, node.distinct, resultType);
    this.aggregatesFound.push(bound);
    return bound;
  }

  bindFunctionCall(node: AST.FunctionCallNode, scope: BinderScope): BE.BoundFunctionNode {
    const args = node.args.map(a => this.bindExpression(a, scope));
    const resultType = this.inferFunctionType(node.name, args);
    return BE.BoundFunction(node.name.toUpperCase(), args, resultType);
  }

  bindCaseExpr(node: AST.CaseExprNode, scope: BinderScope): BE.BoundCaseNode {
    const operand = node.operand ? this.bindExpression(node.operand, scope) : null;
    const whenClauses = node.whenClauses.map(wc => ({
      condition: this.bindExpression(wc.condition, scope),
      result: this.bindExpression(wc.result, scope),
    }));
    const elseExpr = node.elseExpr ? this.bindExpression(node.elseExpr, scope) : null;
    const resultType = BE.getExprType(whenClauses[0]?.result) || DataType.VARCHAR;
    return BE.BoundCase(operand, whenClauses, elseExpr, resultType);
  }

  bindCastExpr(node: AST.CastExprNode, scope: BinderScope): BE.BoundCastNode {
    const expr = this.bindExpression(node.expr, scope);
    const targetType = this.resolveTypeName(node.targetType);
    return BE.BoundCast(expr, targetType);
  }

  bindInExpr(node: AST.InExprNode, scope: BinderScope): BE.BoundInListNode {
    const expr = this.bindExpression(node.expr, scope);
    const inList = node.list;
    if (!Array.isArray(inList) && inList.kind === NodeKind.SUBQUERY_EXPR) {
      const subScope = scope.child();
      const subPlan = this.bindQuery(inList.query, subScope);
      return BE.BoundInList(expr, BE.BoundSubquery(subPlan, 'IN'), node.negated);
    }
    const list = (inList as AST.Expr[]).map(e => this.bindExpression(e, scope));
    return BE.BoundInList(expr, list, node.negated);
  }

  bindExistsExpr(node: AST.ExistsExprNode, scope: BinderScope): BE.BoundExistsNode {
    const subScope = scope.child();
    const subPlan = this.bindQuery(node.query, subScope);
    return BE.BoundExists(subPlan, node.negated);
  }

  bindSubqueryExpr(node: AST.SubqueryExprNode, scope: BinderScope): BE.BoundSubqueryNode {
    const subScope = scope.child();
    const subPlan = this.bindQuery(node.query, subScope);
    return BE.BoundSubquery(subPlan, 'SCALAR');
  }

  inferColumnName(node: AST.Expr): string | null {
    if (node.kind === NodeKind.COLUMN_REF) return node.name;
    if (node.kind === NodeKind.AGGREGATE_CALL) return node.name.toLowerCase();
    if (node.kind === NodeKind.FUNCTION_CALL) return node.name.toLowerCase();
    return null;
  }

  inferArithmeticType(left: string | null, right: string | null): string {
    if (left === DataType.FLOAT64 || right === DataType.FLOAT64) return DataType.FLOAT64;
    if (left === DataType.DECIMAL || right === DataType.DECIMAL) return DataType.DECIMAL;
    if (left === DataType.INT64 || right === DataType.INT64) return DataType.INT64;
    if (left === DataType.DATE) return DataType.DATE;
    return DataType.INT32;
  }

  inferAggregateType(name: string, args: BE.BoundExpr[]): string {
    switch (name.toUpperCase()) {
      case 'COUNT':
      case 'COUNT_STAR':
        return DataType.INT64;
      case 'SUM':
        return args[0] ? (BE.getExprType(args[0]) || DataType.FLOAT64) : DataType.FLOAT64;
      case 'AVG':
        return DataType.FLOAT64;
      case 'MIN':
      case 'MAX':
        return args[0] ? (BE.getExprType(args[0]) || DataType.FLOAT64) : DataType.FLOAT64;
      default:
        return DataType.FLOAT64;
    }
  }

  inferFunctionType(name: string, args: BE.BoundExpr[]): string | null {
    switch (name.toUpperCase()) {
      case 'SUBSTRING': case 'TRIM': case 'UPPER': case 'LOWER': case 'REPLACE':
        return DataType.VARCHAR;
      case 'EXTRACT':
        return DataType.INT32;
      case 'LENGTH':
        return DataType.INT32;
      case 'ABS': case 'ROUND': case 'SQRT':
        return args[0] ? BE.getExprType(args[0]) : DataType.FLOAT64;
      case 'COALESCE': case 'NULLIF': {
        for (const arg of args) {
          const argType = BE.getExprType(arg);
          if (argType) return argType;
        }
        return null;
      }
      default:
        return DataType.VARCHAR;
    }
  }

  inferWindowType(name: string, args: BE.BoundExpr[]): string | null {
    switch (name.toUpperCase()) {
      case 'ROW_NUMBER': case 'RANK': case 'DENSE_RANK':
        return DataType.INT64;
      case 'LAG': case 'LEAD':
        return args[0] ? BE.getExprType(args[0]) : DataType.VARCHAR;
      case 'SUM': case 'AVG': case 'MIN': case 'MAX': case 'COUNT': case 'COUNT_STAR':
        return this.inferAggregateType(name, args);
      default:
        return DataType.FLOAT64;
    }
  }

  resolveTypeName(typeName: AST.TypeNameNode): string {
    return normalizeTypeName(typeName.name);
  }
}
