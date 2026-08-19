import { describe, it, expect } from 'vitest';
import { walkExpr, containsAggregate, collectTableRefs } from '../../src/optimizer/expr-walk.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

function col(table, name) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: name };
}

function lit(value) {
  return { kind: BoundExprKind.LITERAL, value };
}

function binary(op, left, right) {
  return { kind: BoundExprKind.BINARY, op, left, right };
}

describe('walkExpr', () => {
  it('visits the root expression', () => {
    const visited = [];
    walkExpr(col('A', 'x'), e => visited.push(e));
    expect(visited).toHaveLength(1);
  });

  it('tolerates null and undefined input', () => {
    const visited = [];
    walkExpr(null, e => visited.push(e));
    walkExpr(undefined, e => visited.push(e));
    expect(visited).toHaveLength(0);
  });

  it('descends into both branches of a binary node', () => {
    const visited = [];
    walkExpr(binary('=', col('A', 'x'), col('B', 'y')), e => visited.push(e));
    expect(visited).toHaveLength(3);
  });

  it('descends into function arguments', () => {
    const visited = [];
    walkExpr({ kind: BoundExprKind.FUNCTION, name: 'UPPER', args: [col('A', 'x'), lit('z')] }, e => visited.push(e));
    expect(visited).toHaveLength(3);
  });
});

describe('containsAggregate', () => {
  it('reports false for a plain comparison', () => {
    expect(containsAggregate(binary('>', col('A', 'x'), lit(1)))).toBe(false);
  });

  it('reports true when an aggregate is nested inside a binary node', () => {
    const agg = { kind: BoundExprKind.AGGREGATE, name: 'SUM', args: [col('A', 'x')] };
    expect(containsAggregate(binary('>', agg, lit(1)))).toBe(true);
  });

  it('reports false for undefined input', () => {
    expect(containsAggregate(undefined)).toBe(false);
  });
});

describe('collectTableRefs', () => {
  it('collects the alias of a bare column reference', () => {
    expect([...collectTableRefs(col('orders', 'id'))]).toEqual(['ORDERS']);
  });

  it('upper-cases aliases so lookups are case insensitive', () => {
    expect(collectTableRefs(col('Orders', 'id')).has('ORDERS')).toBe(true);
  });

  it('collects aliases from both sides of a join predicate', () => {
    const refs = collectTableRefs(binary('=', col('a', 'id'), col('b', 'fk')));
    expect([...refs].sort()).toEqual(['A', 'B']);
  });

  it('deduplicates repeated references to the same alias', () => {
    const refs = collectTableRefs(binary('AND',
      binary('=', col('a', 'id'), lit(1)),
      binary('=', col('a', 'code'), lit(2)),
    ));
    expect([...refs]).toEqual(['A']);
  });

  it('reaches column references inside CASE branches', () => {
    const expr = {
      kind: BoundExprKind.CASE,
      whenClauses: [{ condition: col('a', 'flag'), result: col('b', 'value') }],
      elseExpr: col('c', 'fallback'),
    };

    expect([...collectTableRefs(expr)].sort()).toEqual(['A', 'B', 'C']);
  });

  it('reaches column references inside an IN list', () => {
    const expr = {
      kind: BoundExprKind.IN_LIST,
      expr: col('a', 'id'),
      list: [col('b', 'id'), col('c', 'id')],
    };

    expect([...collectTableRefs(expr)].sort()).toEqual(['A', 'B', 'C']);
  });

  it('reaches column references inside a LIKE pattern', () => {
    const expr = { kind: BoundExprKind.LIKE, expr: col('a', 'name'), pattern: col('b', 'prefix') };
    expect([...collectTableRefs(expr)].sort()).toEqual(['A', 'B']);
  });

  it('reaches column references inside BETWEEN bounds', () => {
    const expr = { kind: BoundExprKind.BETWEEN, expr: col('a', 'x'), low: col('b', 'lo'), high: col('c', 'hi') };
    expect([...collectTableRefs(expr)].sort()).toEqual(['A', 'B', 'C']);
  });

  it('ignores column references that carry no alias', () => {
    expect(collectTableRefs({ kind: BoundExprKind.COLUMN_REF, columnName: 'x' }).size).toBe(0);
  });

  it('returns an empty set for null input', () => {
    expect(collectTableRefs(null).size).toBe(0);
  });
});
