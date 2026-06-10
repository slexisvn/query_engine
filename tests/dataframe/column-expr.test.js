import { describe, it, expect } from 'vitest';
import { col, lit, expr, sum, avg, count, countStar } from '../../src/dataframe/column-expr.js';
import { DFSchema } from '../../src/dataframe/schema.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { DataType } from '../../src/storage/data-type.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { defaultFunctionRegistry } from '../../src/catalog/function-registry.js';

function schema() {
  return DFSchema.fromStorageSchema([
    { name: 'age', dataType: DataType.INT32 },
    { name: 'city', dataType: DataType.VARCHAR },
  ], 'T');
}

const ctx = { catalog: new Catalog(), functionRegistry: defaultFunctionRegistry };

describe('col builder', () => {
  it('resolves a column ref against the schema', () => {
    const { expr: e, dataType, outputName } = col('age').bind(schema(), ctx);
    expect(e.kind).toBe(BoundExprKind.COLUMN_REF);
    expect(e.columnName).toBe('age');
    expect(e.tableAlias).toBe('T');
    expect(dataType).toBe(DataType.INT32);
    expect(outputName).toBe('age');
  });

  it('resolves qualified names', () => {
    const { expr: e } = col('T.city').bind(schema(), ctx);
    expect(e.columnName).toBe('city');
    expect(e.tableAlias).toBe('T');
  });

  it('infers literal types', () => {
    expect(lit(5).bind(schema(), ctx).dataType).toBe(DataType.INT32);
    expect(lit('x').bind(schema(), ctx).dataType).toBe(DataType.VARCHAR);
    expect(lit(null).bind(schema(), ctx).expr.value).toBe(null);
  });

  it('produces boolean comparisons and arithmetic types', () => {
    expect(col('age').gt(lit(18)).bind(schema(), ctx).dataType).toBe(DataType.BOOLEAN);
    expect(col('age').add(lit(1)).bind(schema(), ctx).dataType).toBe(DataType.INT32);
    expect(col('age').and(col('age')).bind(schema(), ctx).dataType).toBe(DataType.BOOLEAN);
  });

  it('honors alias for output name', () => {
    expect(col('age').alias('years').bind(schema(), ctx).outputName).toBe('years');
  });

  it('builds aggregates with correct result types', () => {
    expect(sum('age').bind(schema(), ctx).expr.name).toBe('SUM');
    expect(avg('age').bind(schema(), ctx).dataType).toBe(DataType.FLOAT64);
    expect(count('age').bind(schema(), ctx).dataType).toBe(DataType.INT64);
    expect(countStar().bind(schema(), ctx).expr.name).toBe('COUNT_STAR');
  });

  it('binds raw SQL expressions against the schema', () => {
    const { expr: e, dataType } = expr('age + 1').bind(schema(), ctx);
    expect(e.kind).toBe(BoundExprKind.BINARY);
    expect(dataType).toBe(DataType.INT32);
  });
});
