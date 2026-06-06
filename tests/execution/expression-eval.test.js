import { describe, it, expect } from 'vitest';
import { compileExpression, buildColumnMapping } from '../../src/execution/expression-eval.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { Column } from '../../src/storage/column.js';
import { DataChunk } from '../../src/storage/chunk.js';

function makeChunk(colDefs) {
  const size = colDefs[0].values.length;
  const cols = colDefs.map(({ type, values }) => {
    const col = new Column(type, values.length);
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return col;
  });
  return new DataChunk(cols, size);
}

function colRef(tableAlias, columnName, columnIndex, dataType = 'INT32') {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias, columnName, columnIndex, dataType };
}

function lit(value, dataType = 'INT32') {
  return { kind: BoundExprKind.LITERAL, value, dataType };
}

function bin(op, left, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' };
}

const mapping = new Map([['T.ID', 0], ['ID', 0], ['T.NAME', 1], ['NAME', 1], ['T.VAL', 2], ['VAL', 2]]);
const chunk = makeChunk([
  { type: 'INT32', values: [1, 2, 3, 4, 5] },
  { type: 'VARCHAR', values: ['alice', 'bob', 'charlie', 'dave', 'eve'] },
  { type: 'FLOAT64', values: [10.5, 20.0, 30.5, 40.0, 50.5] },
]);

function evalAll(expr, m = mapping, c = chunk) {
  const fn = compileExpression(expr, m);
  const results = [];
  for (let i = 0; i < c.size; i++) results.push(fn(c, i));
  return results;
}

describe('compileExpression', () => {
  describe('COLUMN_REF', () => {
    it('reads column by mapping key', () => {
      const results = evalAll(colRef('T', 'ID', 0));
      expect(results).toEqual([1, 2, 3, 4, 5]);
    });

    it('reads column by name-only fallback', () => {
      const results = evalAll(colRef('', 'NAME', -1, 'VARCHAR'));
      expect(results).toEqual(['alice', 'bob', 'charlie', 'dave', 'eve']);
    });

    it('falls back to columnIndex when no mapping match', () => {
      const fn = compileExpression(colRef('X', 'UNKNOWN', 2, 'FLOAT64'), new Map());
      expect(fn(chunk, 0)).toBe(10.5);
    });
  });

  describe('LITERAL', () => {
    it('returns constant value', () => {
      const fn = compileExpression(lit(42));
      expect(fn(chunk, 0)).toBe(42);
      expect(fn(chunk, 4)).toBe(42);
    });
  });

  describe('BINARY comparison operators', () => {
    it('evaluates = correctly', () => {
      const results = evalAll(bin('=', colRef('T', 'ID', 0), lit(3)));
      expect(results).toEqual([false, false, true, false, false]);
    });

    it('evaluates <> correctly', () => {
      const results = evalAll(bin('<>', colRef('T', 'ID', 0), lit(3)));
      expect(results).toEqual([true, true, false, true, true]);
    });

    it('evaluates < correctly', () => {
      const results = evalAll(bin('<', colRef('T', 'ID', 0), lit(3)));
      expect(results).toEqual([true, true, false, false, false]);
    });

    it('evaluates > correctly', () => {
      const results = evalAll(bin('>', colRef('T', 'ID', 0), lit(3)));
      expect(results).toEqual([false, false, false, true, true]);
    });

    it('evaluates <= correctly', () => {
      const results = evalAll(bin('<=', colRef('T', 'ID', 0), lit(3)));
      expect(results).toEqual([true, true, true, false, false]);
    });

    it('evaluates >= correctly', () => {
      const results = evalAll(bin('>=', colRef('T', 'ID', 0), lit(3)));
      expect(results).toEqual([false, false, true, true, true]);
    });

    it('returns false when comparing with null', () => {
      const nullChunk = makeChunk([{ type: 'INT32', values: [null] }]);
      const m = new Map([['T.X', 0], ['X', 0]]);
      const fn = compileExpression(bin('=', colRef('T', 'X', 0), lit(1)), m);
      expect(fn(nullChunk, 0)).toBe(false);
    });
  });

  describe('BINARY arithmetic operators', () => {
    it('evaluates + correctly', () => {
      const expr = { kind: BoundExprKind.BINARY, op: '+', left: colRef('T', 'ID', 0), right: lit(10) };
      const results = evalAll(expr);
      expect(results).toEqual([11, 12, 13, 14, 15]);
    });

    it('evaluates - correctly', () => {
      const expr = { kind: BoundExprKind.BINARY, op: '-', left: colRef('T', 'ID', 0), right: lit(1) };
      const results = evalAll(expr);
      expect(results).toEqual([0, 1, 2, 3, 4]);
    });

    it('evaluates * correctly', () => {
      const expr = { kind: BoundExprKind.BINARY, op: '*', left: colRef('T', 'ID', 0), right: lit(3) };
      const results = evalAll(expr);
      expect(results).toEqual([3, 6, 9, 12, 15]);
    });

    it('evaluates / correctly', () => {
      const expr = { kind: BoundExprKind.BINARY, op: '/', left: lit(10), right: lit(2) };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBe(5);
    });

    it('returns null for division by zero', () => {
      const expr = { kind: BoundExprKind.BINARY, op: '/', left: lit(10), right: lit(0) };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBeNull();
    });

    it('evaluates % correctly', () => {
      const expr = { kind: BoundExprKind.BINARY, op: '%', left: colRef('T', 'ID', 0), right: lit(2) };
      const results = evalAll(expr);
      expect(results).toEqual([1, 0, 1, 0, 1]);
    });

    it('evaluates || (string concat)', () => {
      const expr = { kind: BoundExprKind.BINARY, op: '||', left: colRef('T', 'NAME', 1, 'VARCHAR'), right: lit('!', 'VARCHAR') };
      const results = evalAll(expr);
      expect(results).toEqual(['alice!', 'bob!', 'charlie!', 'dave!', 'eve!']);
    });

    it('returns null for arithmetic on null', () => {
      const expr = { kind: BoundExprKind.BINARY, op: '+', left: lit(null), right: lit(5) };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBeNull();
    });
  });

  describe('BINARY logical operators', () => {
    it('evaluates AND', () => {
      const expr = bin('AND', bin('>', colRef('T', 'ID', 0), lit(2)), bin('<', colRef('T', 'ID', 0), lit(5)));
      const results = evalAll(expr);
      expect(results).toEqual([false, false, true, true, false]);
    });

    it('evaluates OR', () => {
      const expr = bin('OR', bin('=', colRef('T', 'ID', 0), lit(1)), bin('=', colRef('T', 'ID', 0), lit(5)));
      const results = evalAll(expr);
      expect(results).toEqual([true, false, false, false, true]);
    });
  });

  describe('UNARY', () => {
    it('negates a number', () => {
      const expr = { kind: BoundExprKind.UNARY, op: '-', operand: colRef('T', 'ID', 0) };
      const results = evalAll(expr);
      expect(results).toEqual([-1, -2, -3, -4, -5]);
    });

    it('applies NOT', () => {
      const expr = { kind: BoundExprKind.UNARY, op: 'NOT', operand: bin('=', colRef('T', 'ID', 0), lit(3)) };
      const results = evalAll(expr);
      expect(results).toEqual([true, true, false, true, true]);
    });
  });

  describe('BETWEEN', () => {
    it('matches values within range', () => {
      const expr = { kind: BoundExprKind.BETWEEN, expr: colRef('T', 'ID', 0), low: lit(2), high: lit(4), negated: false };
      const results = evalAll(expr);
      expect(results).toEqual([false, true, true, true, false]);
    });

    it('negated BETWEEN excludes range', () => {
      const expr = { kind: BoundExprKind.BETWEEN, expr: colRef('T', 'ID', 0), low: lit(2), high: lit(4), negated: true };
      const results = evalAll(expr);
      expect(results).toEqual([true, false, false, false, true]);
    });
  });

  describe('IN_LIST', () => {
    it('matches against literal list', () => {
      const expr = {
        kind: BoundExprKind.IN_LIST,
        expr: colRef('T', 'ID', 0),
        list: [lit(1), lit(3), lit(5)],
        negated: false,
      };
      const results = evalAll(expr);
      expect(results).toEqual([true, false, true, false, true]);
    });

    it('negated IN_LIST excludes values', () => {
      const expr = {
        kind: BoundExprKind.IN_LIST,
        expr: colRef('T', 'ID', 0),
        list: [lit(1), lit(3)],
        negated: true,
      };
      const results = evalAll(expr);
      expect(results).toEqual([false, true, false, true, true]);
    });
  });

  describe('LIKE', () => {
    it('matches with % wildcard', () => {
      const expr = {
        kind: BoundExprKind.LIKE,
        expr: colRef('T', 'NAME', 1, 'VARCHAR'),
        pattern: lit('a%', 'VARCHAR'),
        negated: false,
      };
      const results = evalAll(expr);
      expect(results).toEqual([true, false, false, false, false]);
    });

    it('matches with _ single char wildcard', () => {
      const expr = {
        kind: BoundExprKind.LIKE,
        expr: colRef('T', 'NAME', 1, 'VARCHAR'),
        pattern: lit('bo_', 'VARCHAR'),
        negated: false,
      };
      const results = evalAll(expr);
      expect(results[1]).toBe(true);
      expect(results[0]).toBe(false);
    });

    it('negated LIKE returns inverse', () => {
      const expr = {
        kind: BoundExprKind.LIKE,
        expr: colRef('T', 'NAME', 1, 'VARCHAR'),
        pattern: lit('%e', 'VARCHAR'),
        negated: true,
      };
      const results = evalAll(expr);
      expect(results[0]).toBe(false);
      expect(results[1]).toBe(true);
    });

    it('returns false for null value', () => {
      const nullChunk = makeChunk([{ type: 'VARCHAR', values: [null] }]);
      const m = new Map([['T.N', 0], ['N', 0]]);
      const expr = {
        kind: BoundExprKind.LIKE,
        expr: colRef('T', 'N', 0, 'VARCHAR'),
        pattern: lit('%', 'VARCHAR'),
        negated: false,
      };
      const fn = compileExpression(expr, m);
      expect(fn(nullChunk, 0)).toBe(false);
    });
  });

  describe('IS_NULL', () => {
    it('detects null values', () => {
      const c = makeChunk([{ type: 'INT32', values: [1, null, 3] }]);
      const m = new Map([['T.X', 0], ['X', 0]]);
      const expr = { kind: BoundExprKind.IS_NULL, expr: colRef('T', 'X', 0), negated: false };
      const fn = compileExpression(expr, m);
      expect(fn(c, 0)).toBe(false);
      expect(fn(c, 1)).toBe(true);
      expect(fn(c, 2)).toBe(false);
    });

    it('IS NOT NULL', () => {
      const c = makeChunk([{ type: 'INT32', values: [1, null, 3] }]);
      const m = new Map([['T.X', 0], ['X', 0]]);
      const expr = { kind: BoundExprKind.IS_NULL, expr: colRef('T', 'X', 0), negated: true };
      const fn = compileExpression(expr, m);
      expect(fn(c, 0)).toBe(true);
      expect(fn(c, 1)).toBe(false);
    });
  });

  describe('CASE', () => {
    it('evaluates WHEN clauses in order', () => {
      const expr = {
        kind: BoundExprKind.CASE,
        whenClauses: [
          { condition: bin('=', colRef('T', 'ID', 0), lit(1)), result: lit('one', 'VARCHAR') },
          { condition: bin('=', colRef('T', 'ID', 0), lit(2)), result: lit('two', 'VARCHAR') },
        ],
        elseExpr: lit('other', 'VARCHAR'),
      };
      const results = evalAll(expr);
      expect(results).toEqual(['one', 'two', 'other', 'other', 'other']);
    });

    it('returns null when no WHEN matches and no ELSE', () => {
      const expr = {
        kind: BoundExprKind.CASE,
        whenClauses: [
          { condition: bin('=', colRef('T', 'ID', 0), lit(999)), result: lit('nope', 'VARCHAR') },
        ],
        elseExpr: null,
      };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBeNull();
    });
  });

  describe('CAST', () => {
    it('casts to INT32', () => {
      const expr = { kind: BoundExprKind.CAST, expr: lit('42', 'VARCHAR'), targetType: 'INT32' };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBe(42);
    });

    it('casts to FLOAT64', () => {
      const expr = { kind: BoundExprKind.CAST, expr: lit('3.14', 'VARCHAR'), targetType: 'FLOAT64' };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBeCloseTo(3.14);
    });

    it('casts to VARCHAR', () => {
      const expr = { kind: BoundExprKind.CAST, expr: lit(100), targetType: 'VARCHAR' };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBe('100');
    });

    it('returns null for null input', () => {
      const expr = { kind: BoundExprKind.CAST, expr: lit(null), targetType: 'INT32' };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBeNull();
    });
  });

  describe('FUNCTION', () => {
    it('SUBSTRING extracts portion of string', () => {
      const expr = {
        kind: BoundExprKind.FUNCTION, name: 'SUBSTRING',
        args: [colRef('T', 'NAME', 1, 'VARCHAR'), lit(1), lit(3)],
      };
      const results = evalAll(expr);
      expect(results[0]).toBe('ali');
      expect(results[1]).toBe('bob');
    });

    it('UPPER converts to uppercase', () => {
      const expr = { kind: BoundExprKind.FUNCTION, name: 'UPPER', args: [colRef('T', 'NAME', 1, 'VARCHAR')] };
      const results = evalAll(expr);
      expect(results[0]).toBe('ALICE');
    });

    it('LOWER converts to lowercase', () => {
      const expr = { kind: BoundExprKind.FUNCTION, name: 'LOWER', args: [lit('HELLO', 'VARCHAR')] };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBe('hello');
    });

    it('TRIM removes whitespace', () => {
      const expr = { kind: BoundExprKind.FUNCTION, name: 'TRIM', args: [lit('  hi  ', 'VARCHAR')] };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBe('hi');
    });

    it('ABS returns absolute value', () => {
      const expr = { kind: BoundExprKind.FUNCTION, name: 'ABS', args: [lit(-42)] };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBe(42);
    });

    it('ROUND rounds to specified decimals', () => {
      const expr = { kind: BoundExprKind.FUNCTION, name: 'ROUND', args: [lit(3.14159), lit(2)] };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBeCloseTo(3.14);
    });

    it('COALESCE returns first non-null', () => {
      const expr = { kind: BoundExprKind.FUNCTION, name: 'COALESCE', args: [lit(null), lit(null), lit(42)] };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBe(42);
    });

    it('NULLIF returns null when values equal', () => {
      const expr = { kind: BoundExprKind.FUNCTION, name: 'NULLIF', args: [lit(5), lit(5)] };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBeNull();
    });

    it('NULLIF returns first value when not equal', () => {
      const expr = { kind: BoundExprKind.FUNCTION, name: 'NULLIF', args: [lit(5), lit(3)] };
      const fn = compileExpression(expr, mapping);
      expect(fn(chunk, 0)).toBe(5);
    });
  });

  describe('nested expressions', () => {
    it('evaluates deeply nested arithmetic', () => {
      const expr = {
        kind: BoundExprKind.BINARY, op: '+',
        left: {
          kind: BoundExprKind.BINARY, op: '*',
          left: colRef('T', 'ID', 0),
          right: lit(10),
        },
        right: lit(1),
      };
      const results = evalAll(expr);
      expect(results).toEqual([11, 21, 31, 41, 51]);
    });

    it('evaluates comparison on computed value', () => {
      const computed = { kind: BoundExprKind.BINARY, op: '*', left: colRef('T', 'ID', 0), right: lit(10) };
      const expr = bin('>', computed, lit(25));
      const results = evalAll(expr);
      expect(results).toEqual([false, false, true, true, true]);
    });
  });

  describe('null expression', () => {
    it('returns null for null expr', () => {
      const fn = compileExpression(null, mapping);
      expect(fn(chunk, 0)).toBeNull();
    });
  });
});

describe('buildColumnMapping', () => {
  it('creates mapping with table alias prefix', () => {
    const schemas = [
      { alias: 'T', columns: [{ name: 'ID' }, { name: 'NAME' }] },
    ];
    const m = buildColumnMapping(schemas);

    expect(m.get('T.ID')).toBe(0);
    expect(m.get('T.NAME')).toBe(1);
    expect(m.get('ID')).toBe(0);
    expect(m.get('NAME')).toBe(1);
  });

  it('handles multiple schemas with correct offsets', () => {
    const schemas = [
      { alias: 'A', columns: [{ name: 'X' }] },
      { alias: 'B', columns: [{ name: 'Y' }, { name: 'Z' }] },
    ];
    const m = buildColumnMapping(schemas);

    expect(m.get('A.X')).toBe(0);
    expect(m.get('B.Y')).toBe(1);
    expect(m.get('B.Z')).toBe(2);
  });

  it('last occurrence wins for ambiguous bare column names', () => {
    const schemas = [
      { alias: 'A', columns: [{ name: 'ID' }] },
      { alias: 'B', columns: [{ name: 'ID' }] },
    ];
    const m = buildColumnMapping(schemas);

    expect(m.get('ID')).toBe(1);
    expect(m.get('A.ID')).toBe(0);
    expect(m.get('B.ID')).toBe(1);
  });
});
