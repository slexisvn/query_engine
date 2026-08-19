import { BoundExprKind } from '../binder/expression-binder.js';
import type { BoundExpr } from '../binder/expression-binder.js';

type KeyBuilder = (expr: BoundExpr) => string;

const cache = new WeakMap<BoundExpr, string>();

function list(exprs: readonly BoundExpr[]): string {
  return exprs.map(exprKey).join(',');
}

const KEY_BUILDERS: Record<BoundExprKind, KeyBuilder> = {
  [BoundExprKind.COLUMN_REF]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.COLUMN_REF }>;
    return `col(${(node.tableAlias || '').toUpperCase()}.${node.columnName.toUpperCase()})`;
  },
  [BoundExprKind.LITERAL]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.LITERAL }>;
    return `lit(${typeof node.value}:${String(node.value)})`;
  },
  [BoundExprKind.BINARY]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.BINARY }>;
    return `bin(${node.op},${exprKey(node.left)},${exprKey(node.right)})`;
  },
  [BoundExprKind.UNARY]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.UNARY }>;
    return `un(${node.op},${exprKey(node.operand)})`;
  },
  [BoundExprKind.FUNCTION]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.FUNCTION }>;
    return `fn(${node.name.toUpperCase()},${list(node.args)})`;
  },
  [BoundExprKind.AGGREGATE]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.AGGREGATE }>;
    return aggregateKey(node.name, node.distinct, node.args);
  },
  [BoundExprKind.CASE]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.CASE }>;
    const whens = node.whenClauses.map((wc) => `${exprKey(wc.condition)}=>${exprKey(wc.result)}`).join(',');
    return `case(${node.operand ? exprKey(node.operand) : ''},${whens},${node.elseExpr ? exprKey(node.elseExpr) : ''})`;
  },
  [BoundExprKind.CAST]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.CAST }>;
    return `cast(${node.targetType},${exprKey(node.expr)})`;
  },
  [BoundExprKind.BETWEEN]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.BETWEEN }>;
    return `between(${node.negated},${exprKey(node.expr)},${exprKey(node.low)},${exprKey(node.high)})`;
  },
  [BoundExprKind.IN_LIST]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.IN_LIST }>;
    const items = Array.isArray(node.list) ? list(node.list) : exprKey(node.list);
    return `in(${node.negated},${exprKey(node.expr)},[${items}])`;
  },
  [BoundExprKind.LIKE]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.LIKE }>;
    return `like(${node.negated},${exprKey(node.expr)},${exprKey(node.pattern)})`;
  },
  [BoundExprKind.IS_NULL]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.IS_NULL }>;
    return `isnull(${node.negated},${exprKey(node.expr)})`;
  },
  [BoundExprKind.SUBQUERY]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.SUBQUERY }>;
    return `subquery(${node.subqueryType},${queryKey(node)})`;
  },
  [BoundExprKind.EXISTS]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.EXISTS }>;
    return `exists(${node.negated},${queryKey(node)})`;
  },
  [BoundExprKind.QUANTIFIED]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.QUANTIFIED }>;
    return `quantified(${node.op},${node.quantifier},${exprKey(node.expr)},${queryKey(node)})`;
  },
  [BoundExprKind.EXTRACT]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.EXTRACT }>;
    return `extract(${node.field},${exprKey(node.source)})`;
  },
  [BoundExprKind.INTERVAL]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.INTERVAL }>;
    return `interval(${node.value},${node.unit})`;
  },
  [BoundExprKind.WINDOW]: (e) => {
    const node = e as Extract<BoundExpr, { kind: BoundExprKind.WINDOW }>;
    const partition = list(node.partitionBy);
    const order = node.orderBy.map((ok) => `${exprKey(ok.expr)}:${ok.direction || 'ASC'}:${ok.nullOrder || ''}`).join(',');
    return `window(${node.name.toUpperCase()},${list(node.args)},[${partition}],[${order}],${frameKey(node)})`;
  },
};

function queryKey(expr: BoundExpr): string {
  let id = queryIds.get(expr);
  if (id === undefined) {
    id = nextQueryId++;
    queryIds.set(expr, id);
  }
  return `#${id}`;
}

function frameKey(expr: Extract<BoundExpr, { kind: BoundExprKind.WINDOW }>): string {
  const frame = expr.frame;
  if (!frame) return '';
  return `${frame.mode}:${frame.start.type}:${frame.start.offset ?? ''}:${frame.end.type}:${frame.end.offset ?? ''}`;
}

const queryIds = new WeakMap<BoundExpr, number>();
let nextQueryId = 0;

export function aggregateKey(name: string, distinct: boolean, args: readonly BoundExpr[]): string {
  return `agg(${(name || '').toUpperCase()}${distinct ? ':distinct' : ''},${list(args)})`;
}

function structuralKey(expr: BoundExpr): string {
  return `raw(${JSON.stringify(expr)})`;
}

export function exprKey(expr: BoundExpr): string {
  const cached = cache.get(expr);
  if (cached !== undefined) return cached;
  const build = KEY_BUILDERS[expr.kind];
  const key = build ? build(expr) : structuralKey(expr);
  cache.set(expr, key);
  return key;
}
