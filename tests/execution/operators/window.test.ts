import { describe, it, expect } from 'vitest';
import { WindowOperator } from '../../../src/execution/operators/window.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';

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

function colEval(colIdx) {
  return (chunk, rowIdx) => chunk.columns[colIdx].get(rowIdx);
}

function buildMapping(schema) {
  const mapping = new Map();
  for (let i = 0; i < schema.length; i++) {
    mapping.set(schema[i].name.toUpperCase(), i);
  }
  return mapping;
}

function compileExpr(expr, mapping) {
  if (typeof expr === 'function') return expr;
  if (expr.colIdx !== undefined) return colEval(expr.colIdx);
  if (expr.columnName) return colEval(mapping.get(expr.columnName.toUpperCase()));
  return () => null;
}

function buildOperator(chunks, schema, windowExprs) {
  const mapping = buildMapping(schema);
  return new WindowOperator(windowExprs, schema, mapping, (expr) => compileExpr(expr, mapping));
}

const schema = [
  { name: 'id', dataType: 'INT32' },
  { name: 'dept', dataType: 'VARCHAR' },
  { name: 'salary', dataType: 'INT32' },
];

function testChunks() {
  return [makeChunk([
    { type: 'INT32', values: [1, 2, 3, 4, 5] },
    { type: 'VARCHAR', values: ['A', 'A', 'A', 'B', 'B'] },
    { type: 'INT32', values: [100, 300, 200, 50, 150] },
  ])];
}

describe('WindowOperator', () => {
  describe('partition key separation', () => {
    it('keeps multi-column partitions apart when a key contains a separator character', async () => {
      const partSchema = [
        { name: 'a', dataType: 'VARCHAR' },
        { name: 'b', dataType: 'VARCHAR' },
      ];
      const chunks = [makeChunk([
        { type: 'VARCHAR', values: ['a|b', 'a'] },
        { type: 'VARCHAR', values: ['c', 'b|c'] },
      ])];
      const op = buildOperator(chunks, partSchema, [{
        name: 'COUNT',
        args: [],
        partitionBy: [{ columnName: 'a' }, { columnName: 'b' }],
        orderBy: [],
        resultType: 'INT32',
      }]);

      const rows = (await op.execute(chunks))[0].toRows();

      expect(rows.map(r => r[2])).toEqual([1, 1]);
    });
  });

  describe('SUM aggregate frame', () => {
    it('without ORDER BY returns full partition total for all rows', async () => {
      const chunks = testChunks();
      const op = buildOperator(chunks, schema, [{
        name: 'SUM',
        args: [{ columnName: 'salary' }],
        partitionBy: [{ columnName: 'dept' }],
        orderBy: [],
        resultType: 'FLOAT64',
      }]);

      const result = await op.execute(chunks);
      const rows = result[0].toRows();
      expect(rows[0][3]).toBe(600);
      expect(rows[1][3]).toBe(600);
      expect(rows[2][3]).toBe(600);
      expect(rows[3][3]).toBe(200);
      expect(rows[4][3]).toBe(200);
    });

    it('with ORDER BY returns running cumulative sum', async () => {
      const chunks = testChunks();
      const op = buildOperator(chunks, schema, [{
        name: 'SUM',
        args: [{ columnName: 'salary' }],
        partitionBy: [{ columnName: 'dept' }],
        orderBy: [{ expr: { columnName: 'salary' }, direction: 'ASC' }],
        resultType: 'FLOAT64',
      }]);

      const result = await op.execute(chunks);
      const rows = result[0].toRows();
      const deptA = rows.filter((_, i) => chunks[0].columns[1].get(i) === 'A');
      const sums = deptA.map(r => r[3]).sort((a, b) => a - b);
      expect(sums).toEqual([100, 300, 600]);
    });

    it('without PARTITION BY uses entire dataset as one partition', async () => {
      const chunks = testChunks();
      const op = buildOperator(chunks, schema, [{
        name: 'SUM',
        args: [{ columnName: 'salary' }],
        partitionBy: [],
        orderBy: [],
        resultType: 'FLOAT64',
      }]);

      const result = await op.execute(chunks);
      const rows = result[0].toRows();
      for (const row of rows) expect(row[3]).toBe(800);
    });
  });

  describe('COUNT aggregate frame', () => {
    it('without ORDER BY returns partition count for all rows', async () => {
      const chunks = testChunks();
      const op = buildOperator(chunks, schema, [{
        name: 'COUNT_STAR',
        args: [],
        partitionBy: [{ columnName: 'dept' }],
        orderBy: [],
        resultType: 'INT64',
      }]);

      const result = await op.execute(chunks);
      const rows = result[0].toRows();
      expect(rows[0][3]).toBe(3);
      expect(rows[1][3]).toBe(3);
      expect(rows[2][3]).toBe(3);
      expect(rows[3][3]).toBe(2);
      expect(rows[4][3]).toBe(2);
    });

    it('with ORDER BY returns running count', async () => {
      const chunks = testChunks();
      const op = buildOperator(chunks, schema, [{
        name: 'COUNT_STAR',
        args: [],
        partitionBy: [{ columnName: 'dept' }],
        orderBy: [{ expr: { columnName: 'salary' }, direction: 'ASC' }],
        resultType: 'INT64',
      }]);

      const result = await op.execute(chunks);
      const rows = result[0].toRows();
      const deptA = rows.filter((_, i) => chunks[0].columns[1].get(i) === 'A');
      const counts = deptA.map(r => r[3]).sort((a, b) => a - b);
      expect(counts).toEqual([1, 2, 3]);
    });
  });

  describe('MIN aggregate frame', () => {
    it('without ORDER BY returns partition minimum for all rows', async () => {
      const chunks = testChunks();
      const op = buildOperator(chunks, schema, [{
        name: 'MIN',
        args: [{ columnName: 'salary' }],
        partitionBy: [{ columnName: 'dept' }],
        orderBy: [],
        resultType: 'INT32',
      }]);

      const result = await op.execute(chunks);
      const rows = result[0].toRows();
      expect(rows[0][3]).toBe(100);
      expect(rows[1][3]).toBe(100);
      expect(rows[2][3]).toBe(100);
      expect(rows[3][3]).toBe(50);
      expect(rows[4][3]).toBe(50);
    });

    it('with ORDER BY returns running minimum', async () => {
      const chunks = testChunks();
      const op = buildOperator(chunks, schema, [{
        name: 'MIN',
        args: [{ columnName: 'salary' }],
        partitionBy: [{ columnName: 'dept' }],
        orderBy: [{ expr: { columnName: 'id' }, direction: 'ASC' }],
        resultType: 'INT32',
      }]);

      const result = await op.execute(chunks);
      const rows = result[0].toRows();
      const deptA = [rows[0][3], rows[1][3], rows[2][3]];
      expect(deptA[0]).toBe(100);
      expect(deptA[1]).toBe(100);
      expect(deptA[2]).toBe(100);
    });
  });

  describe('MAX aggregate frame', () => {
    it('without ORDER BY returns partition maximum for all rows', async () => {
      const chunks = testChunks();
      const op = buildOperator(chunks, schema, [{
        name: 'MAX',
        args: [{ columnName: 'salary' }],
        partitionBy: [{ columnName: 'dept' }],
        orderBy: [],
        resultType: 'INT32',
      }]);

      const result = await op.execute(chunks);
      const rows = result[0].toRows();
      expect(rows[0][3]).toBe(300);
      expect(rows[1][3]).toBe(300);
      expect(rows[2][3]).toBe(300);
      expect(rows[3][3]).toBe(150);
      expect(rows[4][3]).toBe(150);
    });

    it('with ORDER BY returns running maximum', async () => {
      const chunks = testChunks();
      const op = buildOperator(chunks, schema, [{
        name: 'MAX',
        args: [{ columnName: 'salary' }],
        partitionBy: [{ columnName: 'dept' }],
        orderBy: [{ expr: { columnName: 'salary' }, direction: 'ASC' }],
        resultType: 'INT32',
      }]);

      const result = await op.execute(chunks);
      const rows = result[0].toRows();
      const deptA = rows.filter((_, i) => chunks[0].columns[1].get(i) === 'A');
      const maxes = deptA.map(r => r[3]).sort((a, b) => a - b);
      expect(maxes).toEqual([100, 200, 300]);
    });
  });

  describe('ROW_NUMBER', () => {
    it('assigns sequential numbers within each partition', async () => {
      const chunks = testChunks();
      const op = buildOperator(chunks, schema, [{
        name: 'ROW_NUMBER',
        args: [],
        partitionBy: [{ columnName: 'dept' }],
        orderBy: [{ expr: { columnName: 'salary' }, direction: 'ASC' }],
        resultType: 'INT64',
      }]);

      const result = await op.execute(chunks);
      const rows = result[0].toRows();
      const deptA = rows.filter((_, i) => chunks[0].columns[1].get(i) === 'A');
      const rns = deptA.map(r => r[3]).sort((a, b) => a - b);
      expect(rns).toEqual([1, 2, 3]);
      const deptB = rows.filter((_, i) => chunks[0].columns[1].get(i) === 'B');
      const rnsB = deptB.map(r => r[3]).sort((a, b) => a - b);
      expect(rnsB).toEqual([1, 2]);
    });
  });

  describe('RANK', () => {
    it('produces gaps on ties', async () => {
      const chunks = [makeChunk([
        { type: 'INT32', values: [1, 2, 3, 4] },
        { type: 'VARCHAR', values: ['A', 'A', 'A', 'A'] },
        { type: 'INT32', values: [100, 100, 200, 200] },
      ])];
      const op = buildOperator(chunks, schema, [{
        name: 'RANK',
        args: [],
        partitionBy: [{ columnName: 'dept' }],
        orderBy: [{ expr: { columnName: 'salary' }, direction: 'ASC' }],
        resultType: 'INT64',
      }]);

      const result = await op.execute(chunks);
      const rows = result[0].toRows();
      const ranks = rows.map(r => r[3]);
      expect(ranks).toEqual([1, 1, 3, 3]);
    });
  });

  describe('DENSE_RANK', () => {
    it('produces no gaps on ties', async () => {
      const chunks = [makeChunk([
        { type: 'INT32', values: [1, 2, 3, 4] },
        { type: 'VARCHAR', values: ['A', 'A', 'A', 'A'] },
        { type: 'INT32', values: [100, 100, 200, 200] },
      ])];
      const op = buildOperator(chunks, schema, [{
        name: 'DENSE_RANK',
        args: [],
        partitionBy: [{ columnName: 'dept' }],
        orderBy: [{ expr: { columnName: 'salary' }, direction: 'ASC' }],
        resultType: 'INT64',
      }]);

      const result = await op.execute(chunks);
      const rows = result[0].toRows();
      const ranks = rows.map(r => r[3]);
      expect(ranks).toEqual([1, 1, 2, 2]);
    });
  });
});
