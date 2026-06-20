import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/parser.js';
import { NodeKind } from '../../src/parser/ast.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';
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

function mockStorage(chunks, schema) {
  const totalRows = chunks.reduce((sum, c) => sum + c.size, 0);
  return {
    getSchema: () => schema,
    rowCount: () => totalRows,
    getColumnIndex: (name) => {
      const upper = name.toUpperCase();
      return schema.findIndex(s => s.name.toUpperCase() === upper);
    },
    async *scan() { for (const c of chunks) yield c; },
  };
}

function registerMockTable(catalog, name, schema, chunks) {
  catalog.registerTable(name, schema);
  catalog.registerTableStorage(name, mockStorage(chunks, schema));
}

// t1: columns id, col1..col6 (all INT32); within each row every column equals id.
function makeT1Engine(ids = [1, 2, 3]) {
  const names = ['id', 'col1', 'col2', 'col3', 'col4', 'col5', 'col6'];
  const schema = names.map(n => ({ name: n.toUpperCase(), dataType: 'INT32' }));
  const chunk = makeChunk(names.map(() => ({ type: 'INT32', values: ids.slice() })));
  const catalog = new Catalog();
  registerMockTable(catalog, 't1', schema, [chunk]);
  return new QueryEngine(catalog);
}

// people: id INT32, name VARCHAR, active BOOLEAN, big INT64
function makePeopleEngine() {
  const schema = [
    { name: 'ID', dataType: 'INT32' },
    { name: 'NAME', dataType: 'VARCHAR' },
    { name: 'ACTIVE', dataType: 'BOOLEAN' },
    { name: 'BIG', dataType: 'INT64' },
  ];
  const chunk = makeChunk([
    { type: 'INT32', values: [1, 2, 3] },
    { type: 'VARCHAR', values: ['Alice', 'Bob', 'Cara'] },
    { type: 'BOOLEAN', values: [true, false, true] },
    { type: 'INT64', values: [5000000000n, 2n, 3n] },
  ]);
  const catalog = new Catalog();
  registerMockTable(catalog, 'people', schema, [chunk]);
  return new QueryEngine(catalog);
}

describe('CREATE TABLE ... AS (CTAS)', () => {
  describe('parsing', () => {
    it('parses CREATE TABLE t2 AS FROM t1 (FROM-first ⇒ implicit SELECT *)', () => {
      const ast = parse('CREATE TABLE t2 AS FROM t1');
      expect(ast.kind).toBe(NodeKind.CREATE_TABLE_STMT);
      expect(ast.name).toBe('t2');
      expect(ast.columns).toBeNull();
      expect(ast.as).not.toBeNull();
      expect(ast.as.kind).toBe(NodeKind.SELECT_STMT);
      expect(ast.as.selectItems).toHaveLength(1);
      expect(ast.as.selectItems[0].expr.kind).toBe(NodeKind.ALL_COLUMNS);
      expect(ast.as.from.kind).toBe(NodeKind.TABLE_REF);
      expect(ast.as.from.name).toBe('t1');
    });

    it('parses CREATE TABLE t AS SELECT with projection', () => {
      const ast = parse('CREATE TABLE t AS SELECT id, col1 + col2 AS s FROM t1');
      expect(ast.kind).toBe(NodeKind.CREATE_TABLE_STMT);
      expect(ast.as.kind).toBe(NodeKind.SELECT_STMT);
      expect(ast.as.selectItems).toHaveLength(2);
      expect(ast.as.selectItems[1].alias).toBe('s');
    });

    it('still parses CREATE TABLE with explicit column definitions', () => {
      const ast = parse('CREATE TABLE t (id INTEGER, name VARCHAR)');
      expect(ast.kind).toBe(NodeKind.CREATE_TABLE_STMT);
      expect(ast.as).toBeNull();
      expect(ast.columns).toHaveLength(2);
    });

    it('parses standalone FROM-first query as SELECT *', () => {
      const ast = parse('FROM t1 WHERE id = 1');
      expect(ast.kind).toBe(NodeKind.SELECT_STMT);
      expect(ast.selectItems[0].expr.kind).toBe(NodeKind.ALL_COLUMNS);
      expect(ast.from.name).toBe('t1');
      expect(ast.where).not.toBeNull();
    });
  });

  describe('execution', () => {
    it('materializes CTAS table with the source schema and data', async () => {
      const engine = makeT1Engine([1, 2, 3]);
      const create = await engine.run('CREATE TABLE t2 AS FROM t1');
      expect(create.message).toMatch(/created/);

      const out = await engine.run('SELECT * FROM t2');
      expect(out.columns).toEqual(['ID', 'COL1', 'COL2', 'COL3', 'COL4', 'COL5', 'COL6']);
      expect(out.rows).toHaveLength(3);
      expect(out.rows.map(r => r.ID).sort()).toEqual([1, 2, 3]);
      expect(out.rows.every(r => r.COL1 === r.ID && r.COL6 === r.ID)).toBe(true);
      engine.close();
    });

    it('supports the 6-table comma join with cross-table arithmetic predicate', async () => {
      const engine = makeT1Engine([1, 2, 3]);
      for (const t of ['t2', 't3', 't4', 't5', 't6']) {
        await engine.run(`CREATE TABLE ${t} AS FROM t1`);
      }

      const result = await engine.run(`
        SELECT t1.id
        FROM t1, t2, t3, t4, t5, t6
        WHERE t1.col1 = t2.col1
          AND t2.col2 = t3.col2
          AND t4.col4 = t5.col4
          AND t5.col5 = t6.col5
          AND t1.id + t2.id + t3.id = t4.id + t5.id + t6.id
      `);

      // All six equalities force every table to pick the same id, so exactly one
      // combination per id value survives → ids {1,2,3}.
      expect(result.rows).toHaveLength(3);
      expect(result.rows.map(r => r.id).sort()).toEqual([1, 2, 3]);
      engine.close();
    });

    it('CTAS with projection/expression infers output schema and types', async () => {
      const engine = makeT1Engine([1, 2, 3]);
      await engine.run('CREATE TABLE summed AS SELECT id, col1 + col2 AS s FROM t1');

      const out = await engine.run('SELECT * FROM summed');
      expect(out.columns).toEqual(['ID', 'S']);
      const byId = Object.fromEntries(out.rows.map(r => [r.ID, r.S]));
      expect(byId).toEqual({ 1: 2, 2: 4, 3: 6 });
      engine.close();
    });

    it('CTAS honors WHERE / filtering in the source query', async () => {
      const engine = makeT1Engine([1, 2, 3]);
      await engine.run('CREATE TABLE big AS SELECT id FROM t1 WHERE id > 1');

      const out = await engine.run('SELECT id FROM big');
      expect(out.rows.map(r => r.id).sort()).toEqual([2, 3]);
      engine.close();
    });

    it('rejects CTAS that would produce duplicate column names', async () => {
      const engine = makeT1Engine([1, 2, 3]);
      await engine.run('CREATE TABLE t2 AS FROM t1');
      await expect(
        engine.run('CREATE TABLE dup AS SELECT t1.id, t2.id FROM t1, t2')
      ).rejects.toThrow(/[Dd]uplicate column/);
      engine.close();
    });

    it('still rejects creating a table that already exists', async () => {
      const engine = makeT1Engine([1, 2, 3]);
      await engine.run('CREATE TABLE t2 AS FROM t1');
      await expect(engine.run('CREATE TABLE t2 AS FROM t1')).rejects.toThrow(/already exists/);
      engine.close();
    });
  });

  describe('varied query shapes', () => {
    it('preserves VARCHAR / BOOLEAN / INT64 values and types', async () => {
      const engine = makePeopleEngine();
      await engine.run('CREATE TABLE p2 AS FROM people');
      const out = await engine.run('SELECT * FROM p2');
      expect(out.columns).toEqual(['ID', 'NAME', 'ACTIVE', 'BIG']);
      const alice = out.rows.find(r => r.NAME === 'Alice');
      expect(alice.ACTIVE).toBe(true);
      // CTAS persists what the query yields (agrees with a direct SELECT).
      const direct = await engine.run('SELECT big FROM people WHERE id = 1');
      expect(Number(alice.BIG)).toBe(5000000000);
      expect(Number(alice.BIG)).toBe(Number(direct.rows[0].big));
      engine.close();
    });

    it('CTAS from SELECT with no FROM (constant)', async () => {
      const engine = makePeopleEngine();
      await engine.run('CREATE TABLE one AS SELECT 1 AS x, 2 AS y');
      const out = await engine.run('SELECT * FROM one');
      expect(out.columns).toEqual(['X', 'Y']);
      expect(out.rows).toEqual([{ X: 1, Y: 2 }]);
      engine.close();
    });

    it('CTAS from GROUP BY aggregate (COUNT)', async () => {
      const engine = makePeopleEngine();
      await engine.run('CREATE TABLE agg AS SELECT active, COUNT(*) AS c FROM people GROUP BY active');
      const out = await engine.run('SELECT * FROM agg');
      const byActive = Object.fromEntries(out.rows.map(r => [String(r.ACTIVE), Number(r.C)]));
      expect(byActive['true']).toBe(2);
      expect(byActive['false']).toBe(1);
      engine.close();
    });

    it('CTAS from ORDER BY + LIMIT', async () => {
      const engine = makePeopleEngine();
      await engine.run('CREATE TABLE top2 AS SELECT id FROM people ORDER BY id DESC LIMIT 2');
      const out = await engine.run('SELECT id FROM top2');
      expect(out.rows.map(r => r.id).sort()).toEqual([2, 3]);
      engine.close();
    });

    it('CTAS from UNION', async () => {
      const engine = makePeopleEngine();
      await engine.run('CREATE TABLE u AS SELECT id FROM people WHERE id = 1 UNION SELECT id FROM people WHERE id = 3');
      const out = await engine.run('SELECT id FROM u');
      expect(out.rows.map(r => r.id).sort()).toEqual([1, 3]);
      engine.close();
    });

    it('CTAS from DISTINCT', async () => {
      const engine = makePeopleEngine();
      await engine.run('CREATE TABLE d AS SELECT DISTINCT active FROM people');
      const out = await engine.run('SELECT active FROM d');
      expect(out.rows.map(r => r.active).sort()).toEqual([false, true]);
      engine.close();
    });

    it('CTAS empty result still creates a queryable empty table', async () => {
      const engine = makePeopleEngine();
      await engine.run('CREATE TABLE none AS SELECT id FROM people WHERE id > 999');
      const out = await engine.run('SELECT id FROM none');
      expect(out.rows).toHaveLength(0);
      expect(out.columns).toEqual(['id']);
      engine.close();
    });

    it('CREATE TABLE IF NOT EXISTS ... AS skips when the table exists', async () => {
      const engine = makePeopleEngine();
      await engine.run('CREATE TABLE x AS SELECT id FROM people WHERE id = 1');
      const r = await engine.run('CREATE TABLE IF NOT EXISTS x AS SELECT id FROM people');
      expect(r.message).toMatch(/already exists/);
      const out = await engine.run('SELECT id FROM x');
      expect(out.rows).toHaveLength(1); // unchanged, not re-materialized
      engine.close();
    });

    it('lowercase column reference resolves against the uppercased CTAS schema', async () => {
      const engine = makePeopleEngine();
      await engine.run('CREATE TABLE p3 AS FROM people');
      const out = await engine.run('SELECT name FROM p3 WHERE id = 2');
      expect(out.rows).toEqual([{ name: 'Bob' }]);
      engine.close();
    });

    it('CTAS persists exactly what the query yields (consistent with a plain SELECT)', async () => {
      // CTAS must mirror the source query's own output, not invent a
      // representation of its own — a materialized COALESCE column matches a
      // plain SELECT (and stays numeric).
      const engine = makeT1Engine([1, 2, 3]);
      const direct = await engine.run('SELECT COALESCE(NULL, id) AS y FROM t1');
      await engine.run('CREATE TABLE c AS SELECT COALESCE(NULL, id) AS y FROM t1');
      const materialized = await engine.run('SELECT y FROM c');
      expect(materialized.rows.map((r) => r.y).sort()).toEqual(direct.rows.map((r) => r.y).sort());
      expect(materialized.rows.map((r) => r.y).sort()).toEqual([1, 2, 3]);
      engine.close();
    });
  });

  describe('statement boundaries (trailing tokens)', () => {
    it('rejects trailing tokens after CREATE TABLE ... AS <query>', () => {
      expect(() => parse('CREATE TABLE t AS SELECT id FROM t1 )')).toThrow();
    });
    it('rejects trailing tokens after a column-def CREATE TABLE', () => {
      expect(() => parse('CREATE TABLE t (a INT) garbage')).toThrow();
    });
    it('rejects trailing tokens after DROP TABLE', () => {
      expect(() => parse('DROP TABLE t1 garbage')).toThrow();
    });
    it('still accepts a trailing semicolon on every statement kind', () => {
      expect(() => parse('CREATE TABLE t AS SELECT id FROM t1;')).not.toThrow();
      expect(() => parse('CREATE TABLE t (a INT);')).not.toThrow();
      expect(() => parse('DROP TABLE t1;')).not.toThrow();
    });
  });

  describe('FROM-first works symmetrically in subqueries', () => {
    it('parses a FROM-first derived table and IN-subquery', () => {
      expect(() => parse('SELECT * FROM (FROM t1) x')).not.toThrow();
      expect(() => parse('SELECT id FROM t1 WHERE id IN (FROM t1)')).not.toThrow();
    });
    it('executes a FROM-first derived table', async () => {
      const engine = makeT1Engine([1, 2, 3]);
      const out = await engine.run('SELECT id FROM (FROM t1) x WHERE id > 1');
      expect(out.rows.map((r) => r.id).sort()).toEqual([2, 3]);
      engine.close();
    });
    it('executes CTAS over a FROM-first derived table', async () => {
      const engine = makeT1Engine([1, 2, 3]);
      await engine.run('CREATE TABLE z AS SELECT id FROM (FROM t1) sub');
      const out = await engine.run('SELECT id FROM z');
      expect(out.rows.map((r) => r.id).sort()).toEqual([1, 2, 3]);
      engine.close();
    });
  });
});
