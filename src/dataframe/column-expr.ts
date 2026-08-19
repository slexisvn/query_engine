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
import type { BoundExpr, LiteralValue } from '../binder/expression-binder.js';
import { DataType, normalizeTypeName } from '../storage/data-type.js';
import type { ColumnValue } from '../storage/data-type.js';
import type { CatalogLike } from '../binder/binder.js';
import { inferValueType } from './type-inference.js';
import {
  inferArithmeticType,
  inferComparisonType,
  inferLogicalType,
  inferAggregateResultType,
} from './expr-types.js';
import { bindScalarSql } from './sql-expr-binder.js';

type LiteralInput = ColumnValue | Date | undefined;

type ColInput = Col | LiteralInput;

type BoundExprWithName = BoundExpr & { outputName?: string };

interface SchemaFieldLike {
  tableAlias: string;
  name: string;
  index: number;
  dataType: DataType | null;
}

interface SchemaLike {
  fields: SchemaFieldLike[];
  resolve(name: string, tableAlias: string | null): SchemaFieldLike;
}

interface BindContextLike {
  catalog: CatalogLike;
  functionRegistry: object;
}

type BuildFn = (schema: SchemaLike, ctx: BindContextLike) => BoundExpr;

type BinaryTypeFn = (left: DataType, right: DataType) => DataType;

interface ColBindResult {
  expr: BoundExpr;
  outputName: string | null;
  dataType: DataType | null;
}

function deriveName(expr: BoundExpr | null): string | null {
  if (!expr) return null;
  if (expr.kind === BoundExprKind.COLUMN_REF) return expr.columnName;
  if (expr.kind === BoundExprKind.AGGREGATE) return expr.name.toLowerCase();
  return null;
}

export class Col {
  _build: BuildFn;
  _name: string | null;
  _alias: string | null;

  constructor(buildFn: BuildFn, name: string | null = null) {
    this._build = buildFn;
    this._name = name;
    this._alias = null;
  }

  alias(name: string): Col {
    const next = new Col(this._build, this._name);
    next._alias = name;
    return next;
  }

  as(name: string): Col {
    return this.alias(name);
  }

  bind(schema: SchemaLike, ctx: BindContextLike): ColBindResult {
    const expr = this._build(schema, ctx);
    const outputName = this._alias || this._name || deriveName(expr);
    if (outputName) (expr as BoundExprWithName).outputName = outputName;
    return { expr, outputName, dataType: getExprType(expr) };
  }

  _binary(op: string, other: ColInput, typeFn: BinaryTypeFn): Col {
    const right = toCol(other);
    return new Col((schema, ctx) => {
      const l = this._build(schema, ctx);
      const r = right._build(schema, ctx);
      return BoundBinary(op, l, r, typeFn(getExprType(l) as DataType, getExprType(r) as DataType));
    });
  }

  add(other: ColInput) { return this._binary('+', other, inferArithmeticType); }
  sub(other: ColInput) { return this._binary('-', other, inferArithmeticType); }
  mul(other: ColInput) { return this._binary('*', other, inferArithmeticType); }
  div(other: ColInput) { return this._binary('/', other, inferArithmeticType); }

  eq(other: ColInput) { return this._binary('=', other, inferComparisonType); }
  ne(other: ColInput) { return this._binary('<>', other, inferComparisonType); }
  lt(other: ColInput) { return this._binary('<', other, inferComparisonType); }
  le(other: ColInput) { return this._binary('<=', other, inferComparisonType); }
  gt(other: ColInput) { return this._binary('>', other, inferComparisonType); }
  ge(other: ColInput) { return this._binary('>=', other, inferComparisonType); }

  and(other: ColInput) { return this._binary('AND', other, inferLogicalType); }
  or(other: ColInput) { return this._binary('OR', other, inferLogicalType); }

  not(): Col {
    return new Col((schema, ctx) => BoundUnary('NOT', this._build(schema, ctx), DataType.BOOLEAN));
  }

  isNull(): Col {
    return new Col((schema, ctx) => BoundIsNull(this._build(schema, ctx), false));
  }

  isNotNull(): Col {
    return new Col((schema, ctx) => BoundIsNull(this._build(schema, ctx), true));
  }

  like(pattern: string): Col {
    return new Col((schema, ctx) =>
      BoundLike(this._build(schema, ctx), lit(pattern)._build(schema, ctx), false));
  }

  between(low: ColInput, high: ColInput): Col {
    const lo = toCol(low);
    const hi = toCol(high);
    return new Col((schema, ctx) =>
      BoundBetween(this._build(schema, ctx), lo._build(schema, ctx), hi._build(schema, ctx), false));
  }

  isin(...values: ColInput[]): Col {
    const cols = values.map(toCol);
    return new Col((schema, ctx) =>
      BoundInList(this._build(schema, ctx), cols.map(c => c._build(schema, ctx)), false));
  }

  cast(targetType: DataType | string): Col {
    return new Col((schema, ctx) => BoundCast(this._build(schema, ctx), normalizeTypeName(targetType)));
  }

  desc(): { col: Col; desc: boolean } {
    return { col: this, desc: true };
  }

  asc(): { col: Col; desc: boolean } {
    return { col: this, desc: false };
  }
}

export function toCol(value: ColInput): Col {
  return value instanceof Col ? value : lit(value);
}

export function col(spec: string): Col {
  const dot = spec.indexOf('.');
  const tableAlias = dot >= 0 ? spec.slice(0, dot) : null;
  const name = dot >= 0 ? spec.slice(dot + 1) : spec;
  const built = new Col((schema) => {
    const field = schema.resolve(name, tableAlias);
    return BoundColumnRef(field.tableAlias, field.name, field.index, field.dataType);
  }, name);
  return built;
}

export function lit(value: LiteralInput): Col {
  return new Col(() => BoundLiteral(value as LiteralValue, inferValueType(value)));
}

export function expr(sqlString: string): Col {
  return new Col((schema, ctx) => {
    const bound = bindScalarSql(sqlString, schema, ctx.catalog, ctx.functionRegistry);
    return bound.expr;
  });
}

function aggregate(name: string): (column: Col | string) => Col {
  return (column: Col | string) => {
    const arg = column instanceof Col ? column : col(column);
    const built = new Col((schema, ctx) => {
      const argExpr = arg._build(schema, ctx);
      return BoundAggregate(name, [argExpr], false, inferAggregateResultType(name, getExprType(argExpr) as DataType));
    }, name.toLowerCase());
    return built;
  };
}

export const sum = aggregate('SUM');
export const avg = aggregate('AVG');
export const min = aggregate('MIN');
export const max = aggregate('MAX');
export const count = aggregate('COUNT');

export function countStar(): Col {
  return new Col(() => BoundAggregate('COUNT_STAR', [], false, DataType.INT64), 'count');
}
