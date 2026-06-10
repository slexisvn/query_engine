import {
  BoundColumnRef,
  BoundLiteral,
  BoundBinary,
  BoundUnary,
  BoundAggregate,
  BoundCast,
  BoundBetween,
  BoundInList,
  BoundLike,
  BoundIsNull,
  BoundExprKind,
  getExprType,
} from '../binder/expression-binder.js';
import { DataType } from '../storage/data-type.js';
import { inferValueType } from './type-inference.js';
import {
  inferArithmeticType,
  inferComparisonType,
  inferLogicalType,
  inferAggregateResultType,
} from './expr-types.js';
import { bindScalarSql } from './sql-expr-binder.js';

function deriveName(expr) {
  if (!expr) return null;
  if (expr.kind === BoundExprKind.COLUMN_REF) return expr.columnName;
  if (expr.kind === BoundExprKind.AGGREGATE) return expr.name.toLowerCase();
  return null;
}

export class Col {
  constructor(buildFn, name = null) {
    this._build = buildFn;
    this._name = name;
    this._alias = null;
  }

  alias(name) {
    const next = new Col(this._build, this._name);
    next._alias = name;
    return next;
  }

  as(name) {
    return this.alias(name);
  }

  bind(schema, ctx) {
    const expr = this._build(schema, ctx);
    const outputName = this._alias || this._name || deriveName(expr);
    if (outputName) expr.outputName = outputName;
    return { expr, outputName, dataType: getExprType(expr) };
  }

  _binary(op, other, typeFn) {
    const right = toCol(other);
    return new Col((schema, ctx) => {
      const l = this._build(schema, ctx);
      const r = right._build(schema, ctx);
      return BoundBinary(op, l, r, typeFn(getExprType(l), getExprType(r)));
    });
  }

  add(other) { return this._binary('+', other, inferArithmeticType); }
  sub(other) { return this._binary('-', other, inferArithmeticType); }
  mul(other) { return this._binary('*', other, inferArithmeticType); }
  div(other) { return this._binary('/', other, inferArithmeticType); }

  eq(other) { return this._binary('=', other, inferComparisonType); }
  ne(other) { return this._binary('<>', other, inferComparisonType); }
  lt(other) { return this._binary('<', other, inferComparisonType); }
  le(other) { return this._binary('<=', other, inferComparisonType); }
  gt(other) { return this._binary('>', other, inferComparisonType); }
  ge(other) { return this._binary('>=', other, inferComparisonType); }

  and(other) { return this._binary('AND', other, inferLogicalType); }
  or(other) { return this._binary('OR', other, inferLogicalType); }

  not() {
    return new Col((schema, ctx) => BoundUnary('NOT', this._build(schema, ctx), DataType.BOOLEAN));
  }

  isNull() {
    return new Col((schema, ctx) => BoundIsNull(this._build(schema, ctx), false));
  }

  isNotNull() {
    return new Col((schema, ctx) => BoundIsNull(this._build(schema, ctx), true));
  }

  like(pattern) {
    return new Col((schema, ctx) =>
      BoundLike(this._build(schema, ctx), lit(pattern)._build(schema, ctx), false));
  }

  between(low, high) {
    const lo = toCol(low);
    const hi = toCol(high);
    return new Col((schema, ctx) =>
      BoundBetween(this._build(schema, ctx), lo._build(schema, ctx), hi._build(schema, ctx), false));
  }

  isin(...values) {
    const cols = values.map(toCol);
    return new Col((schema, ctx) =>
      BoundInList(this._build(schema, ctx), cols.map(c => c._build(schema, ctx)), false));
  }

  cast(targetType) {
    return new Col((schema, ctx) => BoundCast(this._build(schema, ctx), targetType));
  }
}

export function toCol(value) {
  return value instanceof Col ? value : lit(value);
}

export function col(spec) {
  const dot = spec.indexOf('.');
  const tableAlias = dot >= 0 ? spec.slice(0, dot) : null;
  const name = dot >= 0 ? spec.slice(dot + 1) : spec;
  const built = new Col((schema) => {
    const field = schema.resolve(name, tableAlias);
    return BoundColumnRef(field.tableAlias, field.name, field.index, field.dataType);
  }, name);
  return built;
}

export function lit(value) {
  return new Col(() => BoundLiteral(value, inferValueType(value)));
}

export function expr(sqlString) {
  return new Col((schema, ctx) => {
    const bound = bindScalarSql(sqlString, schema, ctx.catalog, ctx.functionRegistry);
    return bound.expr;
  });
}

function aggregate(name) {
  return (column) => {
    const arg = column instanceof Col ? column : col(column);
    const built = new Col((schema, ctx) => {
      const argExpr = arg._build(schema, ctx);
      return BoundAggregate(name, [argExpr], false, inferAggregateResultType(name, getExprType(argExpr)));
    }, name.toLowerCase());
    return built;
  };
}

export const sum = aggregate('SUM');
export const avg = aggregate('AVG');
export const min = aggregate('MIN');
export const max = aggregate('MAX');
export const count = aggregate('COUNT');

export function countStar() {
  return new Col(() => BoundAggregate('COUNT_STAR', [], false, DataType.INT64), 'count');
}
