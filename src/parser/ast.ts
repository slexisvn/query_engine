export enum NodeKind {
  EXPLAIN_STMT = 'ExplainStmt',
  SELECT_STMT = 'SelectStmt',
  SET_OP = 'SetOp',
  WITH_CLAUSE = 'WithClause',
  CTE = 'CTE',
  SELECT_ITEM = 'SelectItem',
  ALL_COLUMNS = 'AllColumns',
  TABLE_REF = 'TableRef',
  JOIN_REF = 'JoinRef',
  SUBQUERY_REF = 'SubqueryRef',
  COLUMN_REF = 'ColumnRef',
  LITERAL = 'Literal',
  PARAMETER = 'Parameter',
  BINARY_EXPR = 'BinaryExpr',
  UNARY_EXPR = 'UnaryExpr',
  BETWEEN_EXPR = 'BetweenExpr',
  IN_EXPR = 'InExpr',
  LIKE_EXPR = 'LikeExpr',
  IS_NULL_EXPR = 'IsNullExpr',
  EXISTS_EXPR = 'ExistsExpr',
  SUBQUERY_EXPR = 'SubqueryExpr',
  FUNCTION_CALL = 'FunctionCall',
  AGGREGATE_CALL = 'AggregateCall',
  CASE_EXPR = 'CaseExpr',
  WHEN_CLAUSE = 'WhenClause',
  CAST_EXPR = 'CastExpr',
  EXTRACT_EXPR = 'ExtractExpr',
  SUBSTRING_EXPR = 'SubstringExpr',
  INTERVAL_EXPR = 'IntervalExpr',
  ORDER_KEY = 'OrderKey',
  TYPE_NAME = 'TypeName',
  WINDOW_SPEC = 'WindowSpec',
  WINDOW_CALL = 'WindowCall',
  CREATE_TABLE_STMT = 'CreateTableStmt',
  DROP_TABLE_STMT = 'DropTableStmt',
  COLUMN_DEF = 'ColumnDef',
  EXPLAIN_ANALYZE_STMT = 'ExplainAnalyzeStmt',
}

export type Expr =
  | ColumnRefNode | LiteralNode | ParameterNode | BinaryExprNode | UnaryExprNode
  | BetweenExprNode | InExprNode | LikeExprNode | IsNullExprNode
  | ExistsExprNode | SubqueryExprNode | FunctionCallNode | AggregateCallNode
  | CaseExprNode | CastExprNode | ExtractExprNode | SubstringExprNode
  | IntervalExprNode | WindowCallNode | AllColumnsNode;

export type FromItem = TableRefNode | JoinRefNode | SubqueryRefNode;

export type QueryStmt = SelectStmtNode | SetOpNode;

export type Statement =
  | QueryStmt | ExplainStmtNode | ExplainAnalyzeStmtNode
  | CreateTableStmtNode | DropTableStmtNode;

export type ASTNode =
  | Statement | WithClauseNode | CTENode | SelectItemNode
  | FromItem | Expr | WhenClauseNode | OrderKeyNode | TypeNameNode
  | WindowSpecNode | ColumnDefNode | QuantifiedSubqueryNode;

export interface ExplainStmtNode { kind: NodeKind.EXPLAIN_STMT; query: QueryStmt; }

export interface SelectStmtNode {
  kind: NodeKind.SELECT_STMT;
  withClause: WithClauseNode | null;
  distinct: boolean;
  selectItems: SelectItemNode[];
  from: FromItem | null;
  where: Expr | null;
  groupBy: Expr[] | null;
  having: Expr | null;
  orderBy: OrderKeyNode[] | null;
  limit: Expr | null;
  offset: Expr | null;
}

export interface SetOpNode { kind: NodeKind.SET_OP; op: string; left: QueryStmt; right: QueryStmt; all: boolean; }

export interface WithClauseNode { kind: NodeKind.WITH_CLAUSE; ctes: CTENode[]; }

export interface CTENode { kind: NodeKind.CTE; name: string; query: QueryStmt; columnAliases: string[] | null; }

export interface SelectItemNode { kind: NodeKind.SELECT_ITEM; expr: Expr; alias: string | null; }

export interface AllColumnsNode { kind: NodeKind.ALL_COLUMNS; table: string | null; }

export interface TableRefNode { kind: NodeKind.TABLE_REF; name: string; alias: string; }

export interface JoinRefNode {
  kind: NodeKind.JOIN_REF;
  left: FromItem;
  right: FromItem;
  joinType: string;
  condition: Expr | null;
  natural?: boolean;
  usingColumns?: string[];
}

export interface SubqueryRefNode { kind: NodeKind.SUBQUERY_REF; query: QueryStmt; alias: string | null; }

export interface ColumnRefNode { kind: NodeKind.COLUMN_REF; name: string; table: string | null; }

export interface LiteralNode { kind: NodeKind.LITERAL; value: string | number | boolean | null; dataType: string | null; }

export interface ParameterNode { kind: NodeKind.PARAMETER; index: number; }

export interface BinaryExprNode { kind: NodeKind.BINARY_EXPR; op: string; left: Expr; right: Expr | QuantifiedSubqueryNode; }

export interface UnaryExprNode { kind: NodeKind.UNARY_EXPR; op: string; operand: Expr; }

export interface BetweenExprNode { kind: NodeKind.BETWEEN_EXPR; expr: Expr; low: Expr; high: Expr; negated: boolean; }

export interface InExprNode { kind: NodeKind.IN_EXPR; expr: Expr; list: Expr[] | SubqueryExprNode; negated: boolean; }

export interface LikeExprNode { kind: NodeKind.LIKE_EXPR; expr: Expr; pattern: Expr; negated: boolean; }

export interface IsNullExprNode { kind: NodeKind.IS_NULL_EXPR; expr: Expr; negated: boolean; }

export interface ExistsExprNode { kind: NodeKind.EXISTS_EXPR; query: QueryStmt; negated: boolean; }

export interface SubqueryExprNode { kind: NodeKind.SUBQUERY_EXPR; query: QueryStmt; }

export interface FunctionCallNode { kind: NodeKind.FUNCTION_CALL; name: string; args: Expr[]; }

export interface AggregateCallNode { kind: NodeKind.AGGREGATE_CALL; name: string; args: Expr[]; distinct: boolean; }

export interface CaseExprNode { kind: NodeKind.CASE_EXPR; operand: Expr | null; whenClauses: WhenClauseNode[]; elseExpr: Expr | null; }

export interface WhenClauseNode { kind: NodeKind.WHEN_CLAUSE; condition: Expr; result: Expr; }

export interface CastExprNode { kind: NodeKind.CAST_EXPR; expr: Expr; targetType: TypeNameNode; }

export interface ExtractExprNode { kind: NodeKind.EXTRACT_EXPR; field: string; source: Expr; }

export interface SubstringExprNode { kind: NodeKind.SUBSTRING_EXPR; expr: Expr; from: Expr; length: Expr | null; }

export interface IntervalExprNode { kind: NodeKind.INTERVAL_EXPR; value: string; unit: string; }

export interface OrderKeyNode { kind: NodeKind.ORDER_KEY; expr: Expr; direction: string; nullOrder: string | null; }

export interface TypeNameNode { kind: NodeKind.TYPE_NAME; name: string; params: number[]; }

export interface WindowSpecNode { kind: NodeKind.WINDOW_SPEC; partitionBy: Expr[]; orderBy: OrderKeyNode[]; }

export interface WindowCallNode { kind: NodeKind.WINDOW_CALL; name: string; args: Expr[]; windowSpec: WindowSpecNode; }

export interface CreateTableStmtNode { kind: NodeKind.CREATE_TABLE_STMT; name: string; columns: ColumnDefNode[] | null; ifNotExists: boolean; as: QueryStmt | null; }

export interface DropTableStmtNode { kind: NodeKind.DROP_TABLE_STMT; name: string; ifExists: boolean; }

export interface ColumnDefNode { kind: NodeKind.COLUMN_DEF; name: string; typeName: TypeNameNode; }

export interface ExplainAnalyzeStmtNode { kind: NodeKind.EXPLAIN_ANALYZE_STMT; query: QueryStmt; }

export interface QuantifiedSubqueryNode { kind: 'QuantifiedSubquery'; quantifier: string; query: QueryStmt; }

export interface SelectStmtOptions {
  withClause?: WithClauseNode | null;
  distinct?: boolean;
  selectItems: SelectItemNode[];
  from?: FromItem | null;
  where?: Expr | null;
  groupBy?: Expr[] | null;
  having?: Expr | null;
  orderBy?: OrderKeyNode[] | null;
  limit?: Expr | null;
  offset?: Expr | null;
}

export function ExplainStmt(query: QueryStmt): ExplainStmtNode {
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
}: SelectStmtOptions): SelectStmtNode {
  return { kind: NodeKind.SELECT_STMT, withClause, distinct, selectItems, from, where, groupBy, having, orderBy, limit, offset };
}

export function SetOp(op: string, left: QueryStmt, right: QueryStmt, all: boolean = false): SetOpNode {
  return { kind: NodeKind.SET_OP, op, left, right, all };
}

export function WithClause(ctes: CTENode[]): WithClauseNode {
  return { kind: NodeKind.WITH_CLAUSE, ctes };
}

export function CTE(name: string, query: QueryStmt, columnAliases: string[] | null = null): CTENode {
  return { kind: NodeKind.CTE, name, query, columnAliases };
}

export function SelectItem(expr: Expr, alias: string | null = null): SelectItemNode {
  return { kind: NodeKind.SELECT_ITEM, expr, alias };
}

export function AllColumns(table: string | null = null): AllColumnsNode {
  return { kind: NodeKind.ALL_COLUMNS, table };
}

export function TableRef(name: string, alias: string | null = null): TableRefNode {
  return { kind: NodeKind.TABLE_REF, name, alias: alias || name };
}

export function JoinRef(left: FromItem, right: FromItem, joinType: string, condition: Expr | null = null): JoinRefNode {
  return { kind: NodeKind.JOIN_REF, left, right, joinType, condition };
}

export function SubqueryRef(query: QueryStmt, alias: string | null): SubqueryRefNode {
  return { kind: NodeKind.SUBQUERY_REF, query, alias };
}

export function ColumnRef(name: string, table: string | null = null): ColumnRefNode {
  return { kind: NodeKind.COLUMN_REF, name, table };
}

export function Literal(value: string | number | boolean | null, dataType: string | null = null): LiteralNode {
  return { kind: NodeKind.LITERAL, value, dataType };
}

export function Parameter(index: number): ParameterNode {
  return { kind: NodeKind.PARAMETER, index };
}

export function BinaryExpr(op: string, left: Expr, right: Expr | QuantifiedSubqueryNode): BinaryExprNode {
  return { kind: NodeKind.BINARY_EXPR, op, left, right };
}

export function UnaryExpr(op: string, operand: Expr): UnaryExprNode {
  return { kind: NodeKind.UNARY_EXPR, op, operand };
}

export function BetweenExpr(expr: Expr, low: Expr, high: Expr, negated: boolean = false): BetweenExprNode {
  return { kind: NodeKind.BETWEEN_EXPR, expr, low, high, negated };
}

export function InExpr(expr: Expr, list: Expr[] | SubqueryExprNode, negated: boolean = false): InExprNode {
  return { kind: NodeKind.IN_EXPR, expr, list, negated };
}

export function LikeExpr(expr: Expr, pattern: Expr, negated: boolean = false): LikeExprNode {
  return { kind: NodeKind.LIKE_EXPR, expr, pattern, negated };
}

export function IsNullExpr(expr: Expr, negated: boolean = false): IsNullExprNode {
  return { kind: NodeKind.IS_NULL_EXPR, expr, negated };
}

export function ExistsExpr(query: QueryStmt, negated: boolean = false): ExistsExprNode {
  return { kind: NodeKind.EXISTS_EXPR, query, negated };
}

export function SubqueryExpr(query: QueryStmt): SubqueryExprNode {
  return { kind: NodeKind.SUBQUERY_EXPR, query };
}

export function FunctionCall(name: string, args: Expr[]): FunctionCallNode {
  return { kind: NodeKind.FUNCTION_CALL, name, args };
}

export function AggregateCall(name: string, args: Expr[], distinct: boolean = false): AggregateCallNode {
  return { kind: NodeKind.AGGREGATE_CALL, name, args, distinct };
}

export function CaseExpr(operand: Expr | null, whenClauses: WhenClauseNode[], elseExpr: Expr | null = null): CaseExprNode {
  return { kind: NodeKind.CASE_EXPR, operand, whenClauses, elseExpr };
}

export function WhenClause(condition: Expr, result: Expr): WhenClauseNode {
  return { kind: NodeKind.WHEN_CLAUSE, condition, result };
}

export function CastExpr(expr: Expr, targetType: TypeNameNode): CastExprNode {
  return { kind: NodeKind.CAST_EXPR, expr, targetType };
}

export function ExtractExpr(field: string, source: Expr): ExtractExprNode {
  return { kind: NodeKind.EXTRACT_EXPR, field, source };
}

export function SubstringExpr(expr: Expr, from: Expr, length: Expr | null = null): SubstringExprNode {
  return { kind: NodeKind.SUBSTRING_EXPR, expr, from, length };
}

export function IntervalExpr(value: string, unit: string): IntervalExprNode {
  return { kind: NodeKind.INTERVAL_EXPR, value, unit };
}

export function OrderKey(expr: Expr, direction: string = 'ASC', nullOrder: string | null = null): OrderKeyNode {
  return { kind: NodeKind.ORDER_KEY, expr, direction, nullOrder };
}

export function TypeName(name: string, params: number[] = []): TypeNameNode {
  return { kind: NodeKind.TYPE_NAME, name, params };
}

export function WindowSpec(partitionBy: Expr[] = [], orderBy: OrderKeyNode[] = []): WindowSpecNode {
  return { kind: NodeKind.WINDOW_SPEC, partitionBy, orderBy };
}

export function WindowCall(name: string, args: Expr[], windowSpec: WindowSpecNode): WindowCallNode {
  return { kind: NodeKind.WINDOW_CALL, name, args, windowSpec };
}

export function CreateTableStmt(name: string, columns: ColumnDefNode[] | null, ifNotExists: boolean = false, as: QueryStmt | null = null): CreateTableStmtNode {
  return { kind: NodeKind.CREATE_TABLE_STMT, name, columns, ifNotExists, as };
}

export function DropTableStmt(name: string, ifExists: boolean = false): DropTableStmtNode {
  return { kind: NodeKind.DROP_TABLE_STMT, name, ifExists };
}

export function ColumnDef(name: string, typeName: TypeNameNode): ColumnDefNode {
  return { kind: NodeKind.COLUMN_DEF, name, typeName };
}

export function ExplainAnalyzeStmt(query: QueryStmt): ExplainAnalyzeStmtNode {
  return { kind: NodeKind.EXPLAIN_ANALYZE_STMT, query };
}
