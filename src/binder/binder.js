import { NodeKind } from '../parser/ast.js';
import { DataType, dateToEpochDays, DECIMAL_SCALE } from '../storage/data-type.js';
import { BinderScope } from './scope.js';
import * as BE from './expression-binder.js';

export class Binder {
  constructor(catalog, functionRegistry) {
    this.catalog = catalog;
    this.functionRegistry = functionRegistry;
    this.cteScopes = new Map();
    this.aggregatesFound = [];
  }

  bind(ast) {
    const scope = new BinderScope();
    return this.bindQuery(ast, scope);
  }

  bindQuery(node, scope) {
    if (node.kind === NodeKind.SET_OP) {
      return this.bindSetOp(node, scope);
    }
    return this.bindSelect(node, scope);
  }

  bindSetOp(node, scope) {
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

  bindSelect(node, scope) {
    if (node.withClause) {
      this.bindWithClause(node.withClause, scope);
    }

    const fromScope = scope.child();

    let plan = null;
    if (node.from) {
      plan = this.bindFrom(node.from, fromScope);
    }

    const savedAggregates = this.aggregatesFound;
    this.aggregatesFound = [];
    let outputColumns = [];

    const boundSelectItems = this.bindSelectItems(node.selectItems, fromScope);

    let where = null;
    if (node.where) {
      where = this.bindExpression(node.where, fromScope);
    }

    const aggregates = [...this.aggregatesFound];

    const selectAliasMap = new Map();
    for (const item of boundSelectItems) {
      const alias = item.alias || item.inferredName;
      if (alias) {
        selectAliasMap.set(alias.toUpperCase(), item.expr);
      }
    }

    let groupBy = null;
    if (node.groupBy) {
      groupBy = node.groupBy.map(expr => {
        if (expr.kind === NodeKind.COLUMN_REF && !expr.table) {
          const aliasExpr = selectAliasMap.get(expr.name.toUpperCase());
          if (aliasExpr) return aliasExpr;
        }
        return this.bindExpression(expr, fromScope);
      });
    }

    let having = null;
    if (node.having) {
      having = this.bindExpression(node.having, fromScope);
      aggregates.push(...this.aggregatesFound.slice(aggregates.length));
    }

    this.aggregatesFound = savedAggregates;

    let orderBy = null;
    if (node.orderBy) {
      orderBy = node.orderBy.map(ok => {
        if (ok.expr.kind === 'ColumnRef' && !ok.expr.table) {
          const aliasExpr = selectAliasMap.get(ok.expr.name.toUpperCase());
          if (aliasExpr) {
            return { expr: aliasExpr, direction: ok.direction, nullOrder: ok.nullOrder };
          }
        }
        return {
          expr: this.bindExpression(ok.expr, fromScope),
          direction: ok.direction,
          nullOrder: ok.nullOrder,
        };
      });
    }

    let limit = null;
    if (node.limit) {
      limit = this.bindExpression(node.limit, fromScope);
    }

    let offset = null;
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

  bindWithClause(withClause, scope) {
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

  bindFrom(node, scope) {
    switch (node.kind) {
      case NodeKind.TABLE_REF:
        return this.bindTableRef(node, scope);
      case NodeKind.JOIN_REF:
        return this.bindJoinRef(node, scope);
      case NodeKind.SUBQUERY_REF:
        return this.bindSubqueryRef(node, scope);
      default:
        throw new Error(`Unknown FROM node kind: ${node.kind}`);
    }
  }

  bindTableRef(node, scope) {
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

  bindJoinRef(node, scope) {
    const left = this.bindFrom(node.left, scope);
    const right = this.bindFrom(node.right, scope);

    let condition = null;
    if (node.condition) {
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

  bindSubqueryRef(node, scope) {
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

  bindSelectItems(items, scope) {
    const result = [];
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

  expandStar(node, scope) {
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

  bindExpression(node, scope) {
    if (!node) return null;

    switch (node.kind) {
      case NodeKind.COLUMN_REF:
        return this.bindColumnRef(node, scope);

      case NodeKind.LITERAL:
        return this.bindLiteral(node);

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
        ].filter(Boolean), DataType.VARCHAR);

      case NodeKind.INTERVAL_EXPR:
        return BE.BoundInterval(parseInt(node.value, 10), node.unit);

      case NodeKind.ALL_COLUMNS:
        throw new Error('Star expression in unexpected position');

      default:
        throw new Error(`Unhandled expression kind: ${node.kind}`);
    }
  }

  bindColumnRef(node, scope) {
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

  bindLiteral(node) {
    if (node.value === null) {
      return BE.BoundLiteral(null, null);
    }
    if (node.dataType === 'DATE') {
      const [y, m, d] = node.value.split('-').map(Number);
      return BE.BoundLiteral(dateToEpochDays(y, m, d), DataType.DATE);
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

  bindBinaryExpr(node, scope) {
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

  bindUnaryExpr(node, scope) {
    const operand = this.bindExpression(node.operand, scope);
    if (node.op === 'NOT') {
      return BE.BoundUnary('NOT', operand, DataType.BOOLEAN);
    }
    return BE.BoundUnary(node.op, operand, BE.getExprType(operand));
  }

  bindAggregateCall(node, scope) {
    const args = node.args.map(a => this.bindExpression(a, scope));
    const resultType = this.inferAggregateType(node.name, args);
    const bound = BE.BoundAggregate(node.name, args, node.distinct, resultType);
    this.aggregatesFound.push(bound);
    return bound;
  }

  bindFunctionCall(node, scope) {
    const args = node.args.map(a => this.bindExpression(a, scope));
    const resultType = this.inferFunctionType(node.name, args);
    return BE.BoundFunction(node.name.toUpperCase(), args, resultType);
  }

  bindCaseExpr(node, scope) {
    const operand = node.operand ? this.bindExpression(node.operand, scope) : null;
    const whenClauses = node.whenClauses.map(wc => ({
      condition: this.bindExpression(wc.condition, scope),
      result: this.bindExpression(wc.result, scope),
    }));
    const elseExpr = node.elseExpr ? this.bindExpression(node.elseExpr, scope) : null;
    const resultType = BE.getExprType(whenClauses[0]?.result) || DataType.VARCHAR;
    return BE.BoundCase(operand, whenClauses, elseExpr, resultType);
  }

  bindCastExpr(node, scope) {
    const expr = this.bindExpression(node.expr, scope);
    const targetType = this.resolveTypeName(node.targetType);
    return BE.BoundCast(expr, targetType);
  }

  bindInExpr(node, scope) {
    const expr = this.bindExpression(node.expr, scope);
    if (node.list.kind === NodeKind.SUBQUERY_EXPR) {
      const subScope = scope.child();
      const subPlan = this.bindQuery(node.list.query, subScope);
      return BE.BoundInList(expr, BE.BoundSubquery(subPlan, 'IN'), node.negated);
    }
    const list = node.list.map(e => this.bindExpression(e, scope));
    return BE.BoundInList(expr, list, node.negated);
  }

  bindExistsExpr(node, scope) {
    const subScope = scope.child();
    const subPlan = this.bindQuery(node.query, subScope);
    return BE.BoundExists(subPlan, node.negated);
  }

  bindSubqueryExpr(node, scope) {
    const subScope = scope.child();
    const subPlan = this.bindQuery(node.query, subScope);
    return BE.BoundSubquery(subPlan, 'SCALAR');
  }

  inferColumnName(node) {
    if (node.kind === NodeKind.COLUMN_REF) return node.name;
    if (node.kind === NodeKind.AGGREGATE_CALL) return node.name.toLowerCase();
    if (node.kind === NodeKind.FUNCTION_CALL) return node.name.toLowerCase();
    return null;
  }

  inferArithmeticType(left, right) {
    if (left === DataType.FLOAT64 || right === DataType.FLOAT64) return DataType.FLOAT64;
    if (left === DataType.DECIMAL || right === DataType.DECIMAL) return DataType.DECIMAL;
    if (left === DataType.INT64 || right === DataType.INT64) return DataType.INT64;
    if (left === DataType.DATE) return DataType.DATE;
    return DataType.INT32;
  }

  inferAggregateType(name, args) {
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

  inferFunctionType(name, args) {
    switch (name.toUpperCase()) {
      case 'SUBSTRING': case 'TRIM': case 'UPPER': case 'LOWER':
        return DataType.VARCHAR;
      case 'EXTRACT':
        return DataType.INT32;
      case 'ABS': case 'ROUND':
        return args[0] ? BE.getExprType(args[0]) : DataType.FLOAT64;
      case 'COALESCE': case 'NULLIF':
        return args[0] ? BE.getExprType(args[0]) : null;
      default:
        return DataType.VARCHAR;
    }
  }

  resolveTypeName(typeName) {
    const name = typeName.name.toUpperCase();
    const map = {
      'INTEGER': DataType.INT32, 'INT': DataType.INT32, 'INT32': DataType.INT32,
      'BIGINT': DataType.INT64, 'INT64': DataType.INT64,
      'FLOAT': DataType.FLOAT64, 'DOUBLE': DataType.FLOAT64, 'REAL': DataType.FLOAT64,
      'DECIMAL': DataType.DECIMAL, 'NUMERIC': DataType.DECIMAL,
      'VARCHAR': DataType.VARCHAR, 'TEXT': DataType.VARCHAR, 'CHAR': DataType.VARCHAR,
      'DATE': DataType.DATE,
      'BOOLEAN': DataType.BOOLEAN, 'BOOL': DataType.BOOLEAN,
    };
    return map[name] || DataType.VARCHAR;
  }
}
