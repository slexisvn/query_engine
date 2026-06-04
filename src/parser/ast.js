export const NodeKind = {
  EXPLAIN_STMT: 'ExplainStmt',
  SELECT_STMT: 'SelectStmt',
  SET_OP: 'SetOp',
  WITH_CLAUSE: 'WithClause',
  CTE: 'CTE',
  SELECT_ITEM: 'SelectItem',
  ALL_COLUMNS: 'AllColumns',
  TABLE_REF: 'TableRef',
  JOIN_REF: 'JoinRef',
  SUBQUERY_REF: 'SubqueryRef',
  COLUMN_REF: 'ColumnRef',
  LITERAL: 'Literal',
  BINARY_EXPR: 'BinaryExpr',
  UNARY_EXPR: 'UnaryExpr',
  BETWEEN_EXPR: 'BetweenExpr',
  IN_EXPR: 'InExpr',
  LIKE_EXPR: 'LikeExpr',
  IS_NULL_EXPR: 'IsNullExpr',
  EXISTS_EXPR: 'ExistsExpr',
  SUBQUERY_EXPR: 'SubqueryExpr',
  FUNCTION_CALL: 'FunctionCall',
  AGGREGATE_CALL: 'AggregateCall',
  CASE_EXPR: 'CaseExpr',
  WHEN_CLAUSE: 'WhenClause',
  CAST_EXPR: 'CastExpr',
  EXTRACT_EXPR: 'ExtractExpr',
  SUBSTRING_EXPR: 'SubstringExpr',
  INTERVAL_EXPR: 'IntervalExpr',
  ORDER_KEY: 'OrderKey',
  TYPE_NAME: 'TypeName',
};

export function ExplainStmt(query) {
  return { kind: NodeKind.EXPLAIN_STMT, query };
}

export function SelectStmt({
  withClause = null,
  distinct = false,
  selectItems,
  from = null,
  where = null,
  groupBy = null,
  having = null,
  orderBy = null,
  limit = null,
  offset = null,
}) {
  return { kind: NodeKind.SELECT_STMT, withClause, distinct, selectItems, from, where, groupBy, having, orderBy, limit, offset };
}

export function SetOp(op, left, right, all = false) {
  return { kind: NodeKind.SET_OP, op, left, right, all };
}

export function WithClause(ctes) {
  return { kind: NodeKind.WITH_CLAUSE, ctes };
}

export function CTE(name, query, columnAliases = null) {
  return { kind: NodeKind.CTE, name, query, columnAliases };
}

export function SelectItem(expr, alias = null) {
  return { kind: NodeKind.SELECT_ITEM, expr, alias };
}

export function AllColumns(table = null) {
  return { kind: NodeKind.ALL_COLUMNS, table };
}

export function TableRef(name, alias = null) {
  return { kind: NodeKind.TABLE_REF, name, alias: alias || name };
}

export function JoinRef(left, right, joinType, condition = null) {
  return { kind: NodeKind.JOIN_REF, left, right, joinType, condition };
}

export function SubqueryRef(query, alias) {
  return { kind: NodeKind.SUBQUERY_REF, query, alias };
}

export function ColumnRef(name, table = null) {
  return { kind: NodeKind.COLUMN_REF, name, table };
}

export function Literal(value, dataType = null) {
  return { kind: NodeKind.LITERAL, value, dataType };
}

export function BinaryExpr(op, left, right) {
  return { kind: NodeKind.BINARY_EXPR, op, left, right };
}

export function UnaryExpr(op, operand) {
  return { kind: NodeKind.UNARY_EXPR, op, operand };
}

export function BetweenExpr(expr, low, high, negated = false) {
  return { kind: NodeKind.BETWEEN_EXPR, expr, low, high, negated };
}

export function InExpr(expr, list, negated = false) {
  return { kind: NodeKind.IN_EXPR, expr, list, negated };
}

export function LikeExpr(expr, pattern, negated = false) {
  return { kind: NodeKind.LIKE_EXPR, expr, pattern, negated };
}

export function IsNullExpr(expr, negated = false) {
  return { kind: NodeKind.IS_NULL_EXPR, expr, negated };
}

export function ExistsExpr(query, negated = false) {
  return { kind: NodeKind.EXISTS_EXPR, query, negated };
}

export function SubqueryExpr(query) {
  return { kind: NodeKind.SUBQUERY_EXPR, query };
}

export function FunctionCall(name, args) {
  return { kind: NodeKind.FUNCTION_CALL, name, args };
}

export function AggregateCall(name, args, distinct = false) {
  return { kind: NodeKind.AGGREGATE_CALL, name, args, distinct };
}

export function CaseExpr(operand, whenClauses, elseExpr = null) {
  return { kind: NodeKind.CASE_EXPR, operand, whenClauses, elseExpr };
}

export function WhenClause(condition, result) {
  return { kind: NodeKind.WHEN_CLAUSE, condition, result };
}

export function CastExpr(expr, targetType) {
  return { kind: NodeKind.CAST_EXPR, expr, targetType };
}

export function ExtractExpr(field, source) {
  return { kind: NodeKind.EXTRACT_EXPR, field, source };
}

export function SubstringExpr(expr, from, length = null) {
  return { kind: NodeKind.SUBSTRING_EXPR, expr, from, length };
}

export function IntervalExpr(value, unit) {
  return { kind: NodeKind.INTERVAL_EXPR, value, unit };
}

export function OrderKey(expr, direction = 'ASC', nullOrder = null) {
  return { kind: NodeKind.ORDER_KEY, expr, direction, nullOrder };
}

export function TypeName(name, params = []) {
  return { kind: NodeKind.TYPE_NAME, name, params };
}
