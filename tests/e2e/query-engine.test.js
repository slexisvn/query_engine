import { describe, it, expect } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';
import { Column } from '../../src/storage/column.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { timestampToEpochMs } from '../../src/storage/data-type.js';

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

describe('QueryEngine', () => {
  describe('DDL execution (CREATE/DROP TABLE)', () => {
    it('CREATE TABLE creates a queryable table', async () => {
      const catalog = new Catalog();
      const engine = new QueryEngine(catalog);
      const createResult = await engine.run('CREATE TABLE items (id INTEGER, name VARCHAR)');
      expect(createResult.message).toContain('created');
      expect(catalog.hasTable('ITEMS')).toBe(true);
      engine.close();
    });

    it('DROP TABLE removes the table', async () => {
      const catalog = new Catalog();
      const engine = new QueryEngine(catalog);
      await engine.run('CREATE TABLE temp (x INT)');
      expect(catalog.hasTable('TEMP')).toBe(true);
      const dropResult = await engine.run('DROP TABLE temp');
      expect(dropResult.message).toContain('dropped');
      expect(catalog.hasTable('TEMP')).toBe(false);
      engine.close();
    });

    it('CREATE TABLE IF NOT EXISTS does not error on duplicate', async () => {
      const catalog = new Catalog();
      const engine = new QueryEngine(catalog);
      await engine.run('CREATE TABLE t1 (id INT)');
      const result = await engine.run('CREATE TABLE IF NOT EXISTS t1 (id INT)');
      expect(result.message).toContain('already exists');
      engine.close();
    });

    it('CREATE TABLE without IF NOT EXISTS throws on duplicate', async () => {
      const catalog = new Catalog();
      const engine = new QueryEngine(catalog);
      await engine.run('CREATE TABLE t1 (id INT)');
      await expect(engine.run('CREATE TABLE t1 (id INT)')).rejects.toThrow('already exists');
      engine.close();
    });

    it('DROP TABLE IF EXISTS does not error on missing', async () => {
      const catalog = new Catalog();
      const engine = new QueryEngine(catalog);
      const result = await engine.run('DROP TABLE IF EXISTS nonexistent');
      expect(result.message).toContain('does not exist');
      engine.close();
    });

    it('DROP TABLE without IF EXISTS throws on missing', async () => {
      const catalog = new Catalog();
      const engine = new QueryEngine(catalog);
      await expect(engine.run('DROP TABLE nonexistent')).rejects.toThrow('does not exist');
      engine.close();
    });
  });

  describe('EXPLAIN ANALYZE execution', () => {
    it('returns plan with execution time and row count', async () => {
      const schema = [{ name: 'x', dataType: 'INT32' }];
      const catalog = new Catalog();
      registerMockTable(catalog, 't', schema, [
        makeChunk([{ type: 'INT32', values: [1, 2, 3] }]),
      ]);
      const engine = new QueryEngine(catalog);
      const result = await engine.run('EXPLAIN ANALYZE SELECT x FROM t WHERE x > 1');
      expect(result.columns).toContain('EXPLAIN_ANALYZE');
      const plan = result.rows[0]['EXPLAIN_ANALYZE'];
      expect(plan).toContain('Execution Time');
      expect(plan).toContain('ms');
      expect(plan).toContain('Rows Returned');
      engine.close();
    });

    it('execution time is a non-negative number', async () => {
      const schema = [{ name: 'x', dataType: 'INT32' }];
      const catalog = new Catalog();
      registerMockTable(catalog, 't', schema, [
        makeChunk([{ type: 'INT32', values: [1] }]),
      ]);
      const engine = new QueryEngine(catalog);
      const result = await engine.run('EXPLAIN ANALYZE SELECT x FROM t');
      const plan = result.rows[0]['EXPLAIN_ANALYZE'];
      const match = plan.match(/Execution Time: ([\d.]+) ms/);
      expect(match).toBeTruthy();
      expect(parseFloat(match[1])).toBeGreaterThanOrEqual(0);
      engine.close();
    });
  });

  describe('NATURAL JOIN / USING execution', () => {
    function makeJoinEngine() {
      const usersSchema = [
        { name: 'id', dataType: 'INT32' },
        { name: 'name', dataType: 'VARCHAR' },
      ];
      const profilesSchema = [
        { name: 'id', dataType: 'INT32' },
        { name: 'bio', dataType: 'VARCHAR' },
      ];
      const catalog = new Catalog();
      registerMockTable(catalog, 'users', usersSchema, [
        makeChunk([
          { type: 'INT32', values: [1, 2, 3] },
          { type: 'VARCHAR', values: ['Alice', 'Bob', 'Charlie'] },
        ]),
      ]);
      registerMockTable(catalog, 'profiles', profilesSchema, [
        makeChunk([
          { type: 'INT32', values: [1, 2] },
          { type: 'VARCHAR', values: ['Engineer', 'Designer'] },
        ]),
      ]);
      return new QueryEngine(catalog);
    }

    it('NATURAL JOIN matches on common column name (id)', async () => {
      const engine = makeJoinEngine();
      const result = await engine.run('SELECT u.name, p.bio FROM users u NATURAL JOIN profiles p');
      expect(result.rows).toHaveLength(2);
      const alice = result.rows.find(r => r.name === 'Alice');
      expect(alice.bio).toBe('Engineer');
      engine.close();
    });

    it('JOIN USING matches on specified column', async () => {
      const engine = makeJoinEngine();
      const result = await engine.run('SELECT u.name, p.bio FROM users u JOIN profiles p USING (id)');
      expect(result.rows).toHaveLength(2);
      engine.close();
    });

    it('NATURAL LEFT JOIN preserves unmatched rows', async () => {
      const engine = makeJoinEngine();
      const result = await engine.run('SELECT u.name, p.bio FROM users u NATURAL LEFT JOIN profiles p');
      expect(result.rows).toHaveLength(3);
      const charlie = result.rows.find(r => r.name === 'Charlie');
      expect(charlie.bio).toBeNull();
      engine.close();
    });
  });

  describe('window functions execution', () => {
    function makeWindowEngine() {
      const schema = [
        { name: 'id', dataType: 'INT32' },
        { name: 'dept', dataType: 'VARCHAR' },
        { name: 'salary', dataType: 'INT32' },
        { name: 'name', dataType: 'VARCHAR' },
      ];
      const catalog = new Catalog();
      registerMockTable(catalog, 'employees', schema, [
        makeChunk([
          { type: 'INT32', values: [1, 2, 3, 4, 5] },
          { type: 'VARCHAR', values: ['eng', 'eng', 'eng', 'sales', 'sales'] },
          { type: 'INT32', values: [100, 120, 110, 90, 95] },
          { type: 'VARCHAR', values: ['Alice', 'Bob', 'Charlie', 'Dave', 'Eve'] },
        ]),
      ]);
      return new QueryEngine(catalog);
    }

    function makeScoresEngine() {
      const scoresSchema = [
        { name: 'name', dataType: 'VARCHAR' },
        { name: 'score', dataType: 'INT32' },
      ];
      const catalog = new Catalog();
      registerMockTable(catalog, 'scores', scoresSchema, [
        makeChunk([
          { type: 'VARCHAR', values: ['A', 'B', 'C', 'D'] },
          { type: 'INT32', values: [100, 100, 90, 80] },
        ]),
      ]);
      return new QueryEngine(catalog);
    }

    it('ROW_NUMBER assigns sequential numbers', async () => {
      const engine = makeWindowEngine();
      const result = await engine.run('SELECT name, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM employees ORDER BY id');
      const rns = result.rows.map(r => r.rn);
      expect(rns).toEqual([1, 2, 3, 4, 5]);
      engine.close();
    });

    it('ROW_NUMBER with PARTITION BY resets per partition', async () => {
      const engine = makeWindowEngine();
      const result = await engine.run('SELECT name, dept, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary) AS rn FROM employees ORDER BY dept, salary');
      const engRows = result.rows.filter(r => r.dept === 'eng');
      const salesRows = result.rows.filter(r => r.dept === 'sales');
      expect(engRows.map(r => r.rn)).toEqual([1, 2, 3]);
      expect(salesRows.map(r => r.rn)).toEqual([1, 2]);
      engine.close();
    });

    it('RANK produces gaps on ties', async () => {
      const engine = makeScoresEngine();
      const result = await engine.run('SELECT name, score, RANK() OVER (ORDER BY score DESC) AS rnk FROM scores ORDER BY score DESC, name');
      const ranks = result.rows.map(r => r.rnk);
      expect(ranks).toEqual([1, 1, 3, 4]);
      engine.close();
    });

    it('DENSE_RANK has no gaps', async () => {
      const engine = makeScoresEngine();
      const result = await engine.run('SELECT name, score, DENSE_RANK() OVER (ORDER BY score DESC) AS drnk FROM scores ORDER BY score DESC, name');
      const ranks = result.rows.map(r => r.drnk);
      expect(ranks).toEqual([1, 1, 2, 3]);
      engine.close();
    });

    it('LAG returns previous row value', async () => {
      const engine = makeWindowEngine();
      const result = await engine.run('SELECT name, salary, LAG(salary, 1) OVER (ORDER BY id) AS prev_salary FROM employees ORDER BY id');
      expect(result.rows[0].prev_salary).toBeNull();
      expect(result.rows[1].prev_salary).toBe(100);
      expect(result.rows[2].prev_salary).toBe(120);
      engine.close();
    });

    it('SUM without ORDER BY returns full partition total for every row', async () => {
      const engine = makeWindowEngine();
      const result = await engine.run('SELECT name, dept, SUM(salary) OVER (PARTITION BY dept) AS dept_total FROM employees ORDER BY dept, name');
      const eng = result.rows.filter(r => r.dept === 'eng');
      const sales = result.rows.filter(r => r.dept === 'sales');
      for (const row of eng) expect(row.dept_total).toBe(330);
      for (const row of sales) expect(row.dept_total).toBe(185);
      engine.close();
    });

    it('SUM with ORDER BY returns running cumulative sum', async () => {
      const engine = makeWindowEngine();
      const result = await engine.run('SELECT name, dept, SUM(salary) OVER (PARTITION BY dept ORDER BY salary ASC) AS running FROM employees ORDER BY dept, salary');
      const eng = result.rows.filter(r => r.dept === 'eng');
      expect(eng[0].running).toBe(100);
      expect(eng[1].running).toBe(210);
      expect(eng[2].running).toBe(330);
      engine.close();
    });

    it('COUNT without ORDER BY returns partition size for every row', async () => {
      const engine = makeWindowEngine();
      const result = await engine.run('SELECT name, dept, COUNT(*) OVER (PARTITION BY dept) AS cnt FROM employees ORDER BY dept, name');
      const eng = result.rows.filter(r => r.dept === 'eng');
      const sales = result.rows.filter(r => r.dept === 'sales');
      for (const row of eng) expect(row.cnt).toBe(3);
      for (const row of sales) expect(row.cnt).toBe(2);
      engine.close();
    });

    it('MAX without ORDER BY returns partition maximum for every row', async () => {
      const engine = makeWindowEngine();
      const result = await engine.run('SELECT name, dept, MAX(salary) OVER (PARTITION BY dept) AS max_sal FROM employees ORDER BY dept, name');
      const eng = result.rows.filter(r => r.dept === 'eng');
      const sales = result.rows.filter(r => r.dept === 'sales');
      for (const row of eng) expect(row.max_sal).toBe(120);
      for (const row of sales) expect(row.max_sal).toBe(95);
      engine.close();
    });

    it('MIN without ORDER BY returns partition minimum for every row', async () => {
      const engine = makeWindowEngine();
      const result = await engine.run('SELECT name, dept, MIN(salary) OVER (PARTITION BY dept) AS min_sal FROM employees ORDER BY dept, name');
      const eng = result.rows.filter(r => r.dept === 'eng');
      const sales = result.rows.filter(r => r.dept === 'sales');
      for (const row of eng) expect(row.min_sal).toBe(100);
      for (const row of sales) expect(row.min_sal).toBe(90);
      engine.close();
    });
  });

  describe('scalar functions execution', () => {
    function makeScalarEngine() {
      const schema = [
        { name: 'val', dataType: 'INT32' },
        { name: 'txt', dataType: 'VARCHAR' },
      ];
      const catalog = new Catalog();
      registerMockTable(catalog, 'data', schema, [
        makeChunk([
          { type: 'INT32', values: [16, 25, 0, 9] },
          { type: 'VARCHAR', values: ['hello world', 'foo bar', 'test', null] },
        ]),
      ]);
      return new QueryEngine(catalog);
    }

    describe('SQRT', () => {
      it('computes square root correctly', async () => {
        const engine = makeScalarEngine();
        const result = await engine.run('SELECT SQRT(val) AS sq FROM data ORDER BY val');
        expect(result.rows[0].sq).toBe(0);
        expect(result.rows[1].sq).toBe(3);
        expect(result.rows[2].sq).toBe(4);
        expect(result.rows[3].sq).toBe(5);
        engine.close();
      });

      it('returns 3 for input 9', async () => {
        const engine = makeScalarEngine();
        const result = await engine.run('SELECT SQRT(val) AS sq FROM data WHERE val = 9');
        expect(result.rows[0].sq).toBe(3);
        engine.close();
      });
    });

    describe('LENGTH', () => {
      it('returns string length', async () => {
        const engine = makeScalarEngine();
        const result = await engine.run("SELECT LENGTH(txt) AS len FROM data WHERE txt = 'hello world'");
        expect(result.rows[0].len).toBe(11);
        engine.close();
      });

      it('returns null for null input', async () => {
        const engine = makeScalarEngine();
        const result = await engine.run('SELECT LENGTH(txt) AS len FROM data WHERE val = 9');
        expect(result.rows[0].len).toBeNull();
        engine.close();
      });
    });

    describe('REPLACE', () => {
      it('replaces all occurrences of substring', async () => {
        const engine = makeScalarEngine();
        const result = await engine.run("SELECT REPLACE(txt, 'o', '0') AS rep FROM data WHERE txt = 'foo bar'");
        expect(result.rows[0].rep).toBe('f00 bar');
        engine.close();
      });

      it('returns original when pattern not found', async () => {
        const engine = makeScalarEngine();
        const result = await engine.run("SELECT REPLACE(txt, 'xyz', '!') AS rep FROM data WHERE txt = 'test'");
        expect(result.rows[0].rep).toBe('test');
        engine.close();
      });

      it('returns null when any arg is null', async () => {
        const engine = makeScalarEngine();
        const result = await engine.run("SELECT REPLACE(txt, 'a', 'b') AS rep FROM data WHERE val = 9");
        expect(result.rows[0].rep).toBeNull();
        engine.close();
      });
    });
  });

  describe('ORDER BY column not in SELECT list', () => {
    function makeOrderByEngine() {
      const schema = [
        { name: 'id', dataType: 'INT32' },
        { name: 'name', dataType: 'VARCHAR' },
        { name: 'salary', dataType: 'INT32' },
      ];
      const catalog = new Catalog();
      registerMockTable(catalog, 'employees', schema, [
        makeChunk([
          { type: 'INT32', values: [1, 2, 3, 4] },
          { type: 'VARCHAR', values: ['Alice', 'Bob', 'Charlie', 'Dave'] },
          { type: 'INT32', values: [50, 120, 80, 100] },
        ]),
      ]);
      return new QueryEngine(catalog);
    }

    it('sorts by a column excluded from projection', async () => {
      const engine = makeOrderByEngine();
      const result = await engine.run('SELECT name FROM employees ORDER BY salary DESC');
      const names = result.rows.map(r => r.name);
      expect(names).toEqual(['Bob', 'Dave', 'Charlie', 'Alice']);
      engine.close();
    });

    it('output contains only selected columns after sorting', async () => {
      const engine = makeOrderByEngine();
      const result = await engine.run('SELECT name FROM employees ORDER BY salary ASC');
      expect(result.columns).toEqual(['name']);
      expect(result.rows[0].name).toBe('Alice');
      expect(result.rows[3].name).toBe('Bob');
      engine.close();
    });

    it('handles ORDER BY with multiple non-selected columns', async () => {
      const engine = makeOrderByEngine();
      const result = await engine.run('SELECT name FROM employees ORDER BY salary DESC, id ASC');
      const names = result.rows.map(r => r.name);
      expect(names[0]).toBe('Bob');
      engine.close();
    });
  });

  describe('scalar subquery in SELECT', () => {
    function makeSubqueryEngine() {
      const schema = [
        { name: 'id', dataType: 'INT32' },
        { name: 'name', dataType: 'VARCHAR' },
        { name: 'salary', dataType: 'INT32' },
      ];
      const catalog = new Catalog();
      registerMockTable(catalog, 'employees', schema, [
        makeChunk([
          { type: 'INT32', values: [1, 2, 3, 4] },
          { type: 'VARCHAR', values: ['Alice', 'Bob', 'Charlie', 'Dave'] },
          { type: 'INT32', values: [50, 120, 80, 100] },
        ]),
      ]);
      return new QueryEngine(catalog);
    }

    it('scalar AVG subquery returns computed value for every row', async () => {
      const engine = makeSubqueryEngine();
      const result = await engine.run('SELECT name, (SELECT AVG(salary) FROM employees) AS avg_sal FROM employees');
      expect(result.rows).toHaveLength(4);
      for (const row of result.rows) {
        expect(row.avg_sal).toBe(87.5);
      }
      engine.close();
    });

    it('scalar COUNT subquery returns correct count', async () => {
      const engine = makeSubqueryEngine();
      const result = await engine.run('SELECT name, (SELECT COUNT(*) FROM employees) AS total FROM employees');
      expect(result.rows).toHaveLength(4);
      for (const row of result.rows) {
        expect(row.total).toBe(4);
      }
      engine.close();
    });

    it('scalar MAX subquery returns correct maximum', async () => {
      const engine = makeSubqueryEngine();
      const result = await engine.run('SELECT name, (SELECT MAX(salary) FROM employees) AS max_sal FROM employees');
      expect(result.rows).toHaveLength(4);
      for (const row of result.rows) {
        expect(row.max_sal).toBe(120);
      }
      engine.close();
    });
  });

  describe('TIMESTAMP end-to-end', () => {
    it('extracts HOUR, MINUTE, SECOND from timestamp', async () => {
      const schema = [
        { name: 'id', dataType: 'INT32' },
        { name: 'ts', dataType: 'TIMESTAMP' },
      ];
      const tsVal = BigInt(timestampToEpochMs(2024, 3, 15, 14, 30, 45, 0));
      const catalog = new Catalog();
      registerMockTable(catalog, 'events', schema, [
        makeChunk([
          { type: 'INT32', values: [1] },
          { type: 'TIMESTAMP', values: [tsVal] },
        ]),
      ]);
      const engine = new QueryEngine(catalog);
      const result = await engine.run('SELECT EXTRACT(HOUR FROM ts), EXTRACT(MINUTE FROM ts), EXTRACT(SECOND FROM ts) FROM events');
      const row = result.rows[0];
      const keys = Object.keys(row);
      expect(row[keys[0]]).toBe(14);
      expect(row[keys[1]]).toBe(30);
      expect(row[keys[2]]).toBe(45);
      engine.close();
    });
  });
});
