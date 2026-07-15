import { describe, it, expect, afterEach } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';
import { Column } from '../../src/storage/column.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { timestampToEpochMs } from '../../src/storage/data-type.js';
import { Config } from '../../src/config.js';

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

  describe('join over renamed subquery projections (regression)', () => {
    const SA = [{ name: 'id', dataType: 'INT32' }, { name: 'name', dataType: 'VARCHAR' }];
    const SB = [{ name: 'id', dataType: 'INT32' }, { name: 'score', dataType: 'INT32' }];

    function engineWith(bIds, bScores) {
      const catalog = new Catalog();
      registerMockTable(catalog, 'A', SA, [makeChunk([
        { type: 'INT32', values: [1, 2] },
        { type: 'VARCHAR', values: ['a', 'b'] },
      ])]);
      registerMockTable(catalog, 'B', SB, [makeChunk([
        { type: 'INT32', values: bIds },
        { type: 'INT32', values: bScores },
      ])]);
      return new QueryEngine(catalog);
    }

    it('INNER join over renamed projections returns correct, non-duplicated rows', async () => {
      const engine = engineWith([1, 2], [10, 20]);
      const result = await engine.run(
        'SELECT x.k, x.nm, y.sc FROM (SELECT id AS k, name AS nm FROM A) x '
        + 'JOIN (SELECT id AS k2, score AS sc FROM B) y ON x.k = y.k2 ORDER BY x.k'
      );
      expect(result.rows).toEqual([
        { k: 1, nm: 'a', sc: 10 },
        { k: 2, nm: 'b', sc: 20 },
      ]);
      engine.close();
    });

    it('LEFT join over renamed projections is not eliminated and keeps right columns', async () => {
      const engine = engineWith([1], [10]);
      const result = await engine.run(
        'SELECT lid, lname, rscore FROM (SELECT id AS lid, name AS lname FROM A) x '
        + 'LEFT JOIN (SELECT id AS rid, score AS rscore FROM B) y ON lid = rid ORDER BY lid'
      );
      expect(result.rows).toEqual([
        { lid: 1, lname: 'a', rscore: 10 },
        { lid: 2, lname: 'b', rscore: null },
      ]);
      engine.close();
    });

    it('SORT over a renaming projection keeps all projected columns', async () => {
      const engine = engineWith([1], [10]);
      const result = await engine.run(
        'SELECT k, nm FROM (SELECT id AS k, name AS nm FROM A) x ORDER BY k'
      );
      expect(result.rows).toEqual([
        { k: 1, nm: 'a' },
        { k: 2, nm: 'b' },
      ]);
      engine.close();
    });
  });

  describe('SQL three-valued logic (NULL)', () => {
    function engineWithB() {
      const schema = [{ name: 'id', dataType: 'INT32' }, { name: 'b', dataType: 'INT32' }];
      const catalog = new Catalog();
      registerMockTable(catalog, 'T', schema, [makeChunk([
        { type: 'INT32', values: [1, 2, 3] },
        { type: 'INT32', values: [5, null, 0] },
      ])]);
      return new QueryEngine(catalog);
    }

    it('NOT (comparison) with NULL is UNKNOWN, not TRUE', async () => {
      const engine = engineWithB();
      const rows = await engine.run('SELECT id FROM T WHERE NOT (b > 1)');
      expect(rows.rows.map(r => r.id)).toEqual([3]);
      engine.close();
    });

    it('NOT IN with NULL operand is UNKNOWN', async () => {
      const engine = engineWithB();
      const rows = await engine.run('SELECT id FROM T WHERE b NOT IN (5)');
      expect(rows.rows.map(r => r.id)).toEqual([3]);
      engine.close();
    });

    it('NULL * 0 is NULL (not 0)', async () => {
      const schema = [{ name: 'id', dataType: 'INT32' }, { name: 'a', dataType: 'INT32' }];
      const catalog = new Catalog();
      registerMockTable(catalog, 'T', schema, [makeChunk([
        { type: 'INT32', values: [1, 2] },
        { type: 'INT32', values: [4, null] },
      ])]);
      const engine = new QueryEngine(catalog);
      const rows = await engine.run('SELECT id, (a * 0) AS z FROM T');
      expect(rows.rows).toEqual([{ id: 1, z: 0 }, { id: 2, z: null }]);
      engine.close();
    });
  });

  describe('HAVING with aggregates', () => {
    it('does not push a HAVING predicate that references an aggregate below the aggregate', async () => {
      const schema = [{ name: 'g', dataType: 'INT32' }];
      const catalog = new Catalog();
      registerMockTable(catalog, 'T', schema, [makeChunk([
        { type: 'INT32', values: [0, 0, 2, 2] },
      ])]);
      const engine = new QueryEngine(catalog);
      const rows = await engine.run('SELECT g, SUM(g) AS sg FROM T GROUP BY g HAVING SUM(g) < 3');
      expect(rows.rows).toEqual([{ g: 0, sg: 0 }]);
      engine.close();
    });
  });

  describe('WASM vectorized projection preserves NULL semantics', () => {
    const savedMin = Config.wasmMinChunkSize;
    afterEach(() => { Config.wasmMinChunkSize = savedMin; });

    it('arithmetic over a nullable column yields NULL for null rows (matches serial)', async () => {
      const schema = [{ name: 'id', dataType: 'INT32' }, { name: 'a', dataType: 'INT32' }, { name: 'b', dataType: 'INT32' }];
      const rows = [[0, 3, 2], [1, null, 5], [2, 4, null], [3, 6, 1]];
      const make = () => {
        const catalog = new Catalog();
        registerMockTable(catalog, 'T', schema, [makeChunk([
          { type: 'INT32', values: rows.map(r => r[0]) },
          { type: 'INT32', values: rows.map(r => r[1]) },
          { type: 'INT32', values: rows.map(r => r[2]) },
        ])]);
        return new QueryEngine(catalog);
      };
      Config.wasmMinChunkSize = savedMin;
      const serial = (await make().run('SELECT id, (a * b) + a AS e FROM T ORDER BY id')).rows;

      const engine = make();
      await engine.enableWasm();
      Config.wasmMinChunkSize = 1;
      const wasm = (await engine.run('SELECT id, (a * b) + a AS e FROM T ORDER BY id')).rows;
      engine.close();

      expect(wasm).toEqual(serial);
      expect(wasm[1].e).toBe(null);
      expect(wasm[2].e).toBe(null);
    });
  });

  describe('spilling does not change results', () => {
    const savedLimit = Config.memoryLimit;
    const savedFlush = Config.flushBatchSize;
    afterEach(() => { Config.memoryLimit = savedLimit; Config.flushBatchSize = savedFlush; });

    function bigTable() {
      const ids = [], ks = [], vs = [];
      for (let i = 0; i < 60; i++) { ids.push(i); ks.push((i * 7) % 9); vs.push((i * 13 + 5) % 40); }
      const schema = [{ name: 'id', dataType: 'INT32' }, { name: 'k', dataType: 'INT32' }, { name: 'v', dataType: 'INT32' }];
      const catalog = new Catalog();
      registerMockTable(catalog, 'A', schema, [makeChunk([
        { type: 'INT32', values: ids }, { type: 'INT32', values: ks }, { type: 'INT32', values: vs },
      ])]);
      return new QueryEngine(catalog);
    }

    async function run(sql) {
      const engine = bigTable();
      const rows = (await engine.run(sql)).rows;
      engine.close();
      return rows;
    }

    for (const sql of [
      'SELECT k, SUM(v) AS s, COUNT(*) AS c, AVG(v) AS a FROM A GROUP BY k',
      'SELECT id, v FROM A ORDER BY v ASC, id ASC',
      'SELECT a.id, b.v AS bv FROM A a JOIN A b ON a.k = b.k',
    ]) {
      it(`matches in-memory vs spilled: ${sql.slice(0, 32)}...`, async () => {
        Config.memoryLimit = savedLimit; Config.flushBatchSize = savedFlush;
        const inMemory = await run(sql);
        Config.memoryLimit = 4; Config.flushBatchSize = 2;
        const spilled = await run(sql);
        const key = r => JSON.stringify(r);
        const ordered = sql.includes('ORDER BY');
        const a = inMemory.map(key); const b = spilled.map(key);
        expect(b.length).toBe(a.length);
        expect(ordered ? b : b.sort()).toEqual(ordered ? a : a.sort());
      });
    }
  });

  describe('parallel morsel aggregate matches serial', () => {
    const savedThreshold = Config.parallelAggThreshold;
    afterEach(() => { Config.parallelAggThreshold = savedThreshold; });

    function salesEngine() {
      const cities = [], ages = [], spends = [];
      for (let i = 0; i < 400; i++) {
        cities.push(['hanoi', 'saigon', 'hue', 'danang'][i % 4]);
        ages.push(i % 13 === 0 ? null : 18 + (i % 50));
        spends.push(i % 17 === 0 ? null : (i * 11) % 500);
      }
      const schema = [
        { name: 'city', dataType: 'VARCHAR' },
        { name: 'age', dataType: 'INT32' },
        { name: 'spend', dataType: 'INT32' },
      ];
      const catalog = new Catalog();
      registerMockTable(catalog, 'SALES', schema, [makeChunk([
        { type: 'VARCHAR', values: cities }, { type: 'INT32', values: ages }, { type: 'INT32', values: spends },
      ])]);
      return new QueryEngine(catalog);
    }

    const queries = [
      'SELECT city, COUNT(*) AS c, SUM(spend) AS s, AVG(spend) AS a, MIN(age) AS mn, MAX(age) AS mx FROM SALES GROUP BY city',
      'SELECT city, COUNT(age) AS ca FROM SALES GROUP BY city',
      'SELECT COUNT(*) AS c, SUM(spend) AS s FROM SALES',
    ];

    for (const sql of queries) {
      it(`parallel == serial: ${sql.slice(0, 34)}...`, async () => {
        const serialEngine = salesEngine();
        const serial = (await serialEngine.run(sql)).rows;
        serialEngine.close();

        const parEngine = salesEngine();
        const enabled = await parEngine.enableParallel();
        if (!enabled || !parEngine.fragmentPool) { parEngine.close(); return; }
        Config.parallelAggThreshold = 0;
        const parallel = (await parEngine.run(sql)).rows;
        await parEngine.shutdown();

        const key = r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]]));
        expect(parallel.map(key).sort()).toEqual(serial.map(key).sort());
      });
    }
  });

  describe('parallel aggregate spill + parallel join match serial', () => {
    const saved = {
      aggThr: Config.parallelAggThreshold,
      joinThr: Config.parallelJoinThreshold,
      spill: Config.aggSpillGroups,
      mem: Config.parallelAggMemoryBytes,
    };
    afterEach(() => {
      Config.parallelAggThreshold = saved.aggThr;
      Config.parallelJoinThreshold = saved.joinThr;
      Config.aggSpillGroups = saved.spill;
      Config.parallelAggMemoryBytes = saved.mem;
    });

    function factEngine() {
      const k = [], a = [];
      for (let i = 0; i < 3000; i++) { k.push(i % 250); a.push(i % 19 === 0 ? null : (i % 200) - 100); }
      const tSchema = [{ name: 'k', dataType: 'INT32' }, { name: 'a', dataType: 'INT32' }];
      const dSchema = [{ name: 'dk', dataType: 'INT32' }, { name: 'w', dataType: 'INT32' }];
      const dk = [], w = [];
      for (let i = 0; i < 250; i++) { dk.push(i); w.push((i % 40) - 20); }
      const catalog = new Catalog();
      registerMockTable(catalog, 'T', tSchema, [makeChunk([{ type: 'INT32', values: k }, { type: 'INT32', values: a }])]);
      registerMockTable(catalog, 'D', dSchema, [makeChunk([{ type: 'INT32', values: dk }, { type: 'INT32', values: w }])]);
      return new QueryEngine(catalog);
    }

    const key = r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]]));

    it('high-cardinality GROUP BY with forced spill matches serial', async () => {
      const sql = 'SELECT k AS g, COUNT(*) AS c, SUM(a) AS s, AVG(a) AS av, MIN(a) AS mn, MAX(a) AS mx FROM T GROUP BY k';
      const serial = (await factEngine().run(sql)).rows;

      const par = factEngine();
      const enabled = await par.enableParallel();
      if (!enabled || !par.fragmentPool) { par.close(); return; }
      Config.parallelAggThreshold = 0;
      Config.parallelAggMemoryBytes = 1 << 30;
      Config.aggSpillGroups = 8;
      const parallel = (await par.run(sql)).rows;
      await par.shutdown();

      expect(parallel.map(key).sort()).toEqual(serial.map(key).sort());
    });

    it('parallel hash join matches serial', async () => {
      const sql = 'SELECT t.k AS k, COUNT(*) AS c, SUM(d.w) AS s FROM T t JOIN D d ON t.k = d.dk GROUP BY t.k';
      const serial = (await factEngine().run(sql)).rows;

      const par = factEngine();
      const enabled = await par.enableParallel();
      if (!enabled || !par.fragmentPool) { par.close(); return; }
      Config.parallelAggThreshold = 0;
      Config.parallelJoinThreshold = 0;
      const parallel = (await par.run(sql)).rows;
      await par.shutdown();

      expect(parallel.map(key).sort()).toEqual(serial.map(key).sort());
    });
  });

  describe('WASM/SIMD ungrouped aggregate correctness', () => {
    function negEngine(aVals, bVals) {
      const schema = [{ name: 'a', dataType: 'INT32' }, { name: 'b', dataType: 'FLOAT64' }];
      const catalog = new Catalog();
      registerMockTable(catalog, 'N', schema, [makeChunk([
        { type: 'INT32', values: aVals }, { type: 'FLOAT64', values: bVals },
      ])]);
      return new QueryEngine(catalog);
    }

    it('MAX/MIN over all-negative columns (WASM seed bug)', async () => {
      const engine = negEngine([-3, -7, -1, -9], [-3.5, -7.5, -1.5, -9.5]);
      const enabled = await engine.enableParallel();
      const r = (await engine.run('SELECT MAX(a) AS mxa, MIN(a) AS mna, MAX(b) AS mxb, MIN(b) AS mnb FROM N')).rows;
      if (enabled) await engine.shutdown(); else engine.close();
      expect(r[0]).toEqual({ mxa: -1, mna: -9, mxb: -1.5, mnb: -9.5 });
    });

    it('MAX/MIN/SUM/AVG over a nullable column ignore NULLs', async () => {
      const engine = negEngine([-5, null, -2, null, -8], [-5.0, null, -2.0, null, -8.0]);
      const enabled = await engine.enableParallel();
      const r = (await engine.run('SELECT MAX(a) AS mx, MIN(a) AS mn, SUM(a) AS s, AVG(a) AS av, COUNT(a) AS c FROM N')).rows;
      if (enabled) await engine.shutdown(); else engine.close();
      expect(r[0].mx).toBe(-2);
      expect(r[0].mn).toBe(-8);
      expect(r[0].s).toBe(-15);
      expect(r[0].av).toBeCloseTo(-5);
      expect(Number(r[0].c)).toBe(3);
    });

    it('aggregate over an all-NULL column returns NULL (not 0)', async () => {
      const engine = negEngine([null, null], [null, null]);
      const enabled = await engine.enableParallel();
      const r = (await engine.run('SELECT MAX(a) AS mx, SUM(b) AS s, AVG(b) AS av, COUNT(a) AS c FROM N')).rows;
      if (enabled) await engine.shutdown(); else engine.close();
      expect(r[0].mx).toBeNull();
      expect(r[0].s).toBeNull();
      expect(r[0].av).toBeNull();
      expect(Number(r[0].c)).toBe(0);
    });
  });

  describe('SELECT without FROM', () => {
    it('evaluates constant expressions over a single row', async () => {
      const engine = new QueryEngine(new Catalog());
      const result = await engine.run("SELECT 1 + 2 AS x, UPPER('ab') AS u, CAST('42' AS INTEGER) + 1 AS n");
      expect(result.rows).toEqual([{ x: 3, u: 'AB', n: 43 }]);
      engine.close();
    });

    it('evaluates a CASE expression without FROM', async () => {
      const engine = new QueryEngine(new Catalog());
      const result = await engine.run("SELECT CASE WHEN 3 > 2 THEN 'yes' ELSE 'no' END AS c");
      expect(result.rows).toEqual([{ c: 'yes' }]);
      engine.close();
    });
  });

  describe('window functions', () => {
    function engineWith(rows) {
      const schema = [{ name: 'id', dataType: 'INT32' }, { name: 'g', dataType: 'INT32' }, { name: 'v', dataType: 'INT32' }];
      const catalog = new Catalog();
      registerMockTable(catalog, 'T', schema, [makeChunk([
        { type: 'INT32', values: rows.map(r => r[0]) },
        { type: 'INT32', values: rows.map(r => r[1]) },
        { type: 'INT32', values: rows.map(r => r[2]) },
      ])]);
      return new QueryEngine(catalog);
    }

    it('AVG OVER (PARTITION BY) computes per-partition averages', async () => {
      const engine = engineWith([[0, 0, 4], [1, 0, 6], [2, 1, 2], [3, 1, 8]]);
      const rows = await engine.run('SELECT id, AVG(v) OVER (PARTITION BY g) AS w FROM T');
      const byId = Object.fromEntries(rows.rows.map(r => [r.id, r.w]));
      expect(byId).toEqual({ 0: 5, 1: 5, 2: 5, 3: 5 });
      engine.close();
    });

    it('SUM OVER a partition of all-NULL values is NULL, not 0', async () => {
      const engine = engineWith([[0, 0, null], [1, 0, null], [2, 1, 7]]);
      const rows = await engine.run('SELECT id, SUM(v) OVER (PARTITION BY g) AS w FROM T');
      const byId = Object.fromEntries(rows.rows.map(r => [r.id, r.w]));
      expect(byId).toEqual({ 0: null, 1: null, 2: 7 });
      engine.close();
    });

    it('ORDER BY DESC in a window keeps NULLs last (matching ORDER BY)', async () => {
      const engine = engineWith([[0, 0, 5], [1, 0, null], [2, 0, 8]]);
      const rows = await engine.run('SELECT id, ROW_NUMBER() OVER (ORDER BY v DESC, id ASC) AS w FROM T');
      const byId = Object.fromEntries(rows.rows.map(r => [r.id, r.w]));
      expect(byId).toEqual({ 2: 1, 0: 2, 1: 3 });
      engine.close();
    });
  });

  describe('subquery correctness', () => {
    function makeEngine() {
      const catalog = new Catalog();
      registerMockTable(catalog, 'T1',
        [{ name: 'id', dataType: 'INT32' }, { name: 'a', dataType: 'INT32' }, { name: 'g', dataType: 'INT32' }],
        [makeChunk([
          { type: 'INT32', values: [0, 1, 2, 3, 4] },
          { type: 'INT32', values: [0, 1, null, 2, 2] },
          { type: 'INT32', values: [2, 1, 2, 0, 1] },
        ])]);
      registerMockTable(catalog, 'T2',
        [{ name: 'x', dataType: 'INT32' }, { name: 'y', dataType: 'INT32' }, { name: 'h', dataType: 'INT32' }],
        [makeChunk([
          { type: 'INT32', values: [null, 2, 1, 2, 2, 3] },
          { type: 'INT32', values: [4, 3, 4, 4, 0, null] },
          { type: 'INT32', values: [1, 1, 2, 2, 0, 1] },
        ])]);
      return new QueryEngine(catalog);
    }

    it('correlated EXISTS does not swap the asymmetric SEMI join sides', async () => {
      const engine = makeEngine();
      const rows = await engine.run('SELECT id FROM T1 WHERE EXISTS (SELECT 1 FROM T2 WHERE T2.h = T1.g AND T2.x = T1.a)');
      expect(rows.rows.map(r => r.id).sort()).toEqual([3, 4]);
      engine.close();
    });

    it('correlated IN keeps subquery columns needed by the correlation', async () => {
      const catalog = new Catalog();
      registerMockTable(catalog, 'T1',
        [{ name: 'id', dataType: 'INT32' }, { name: 'a', dataType: 'INT32' }, { name: 'g', dataType: 'INT32' }],
        [makeChunk([
          { type: 'INT32', values: [0, 1, 2] },
          { type: 'INT32', values: [2, 3, 9] },
          { type: 'INT32', values: [0, 1, 1] },
        ])]);
      registerMockTable(catalog, 'T2',
        [{ name: 'y', dataType: 'INT32' }, { name: 'h', dataType: 'INT32' }],
        [makeChunk([
          { type: 'INT32', values: [2, 3] },
          { type: 'INT32', values: [0, 1] },
        ])]);
      const engine = new QueryEngine(catalog);
      const rows = await engine.run('SELECT id FROM T1 WHERE a IN (SELECT y FROM T2 WHERE T2.h = T1.g)');
      expect(rows.rows.map(r => r.id).sort()).toEqual([0, 1]);
      engine.close();
    });

    it('NOT IN (subquery) with a NULL value yields UNKNOWN (3VL)', async () => {
      const catalog = new Catalog();
      registerMockTable(catalog, 'T1',
        [{ name: 'id', dataType: 'INT32' }, { name: 'a', dataType: 'INT32' }],
        [makeChunk([{ type: 'INT32', values: [0, 1, 2] }, { type: 'INT32', values: [2, 3, null] }])]);
      registerMockTable(catalog, 'TN', [{ name: 'y', dataType: 'INT32' }],
        [makeChunk([{ type: 'INT32', values: [2, null] }])]);
      const engine = new QueryEngine(catalog);
      const rows = await engine.run('SELECT id FROM T1 WHERE a NOT IN (SELECT y FROM TN)');
      expect(rows.rows).toEqual([]);
      engine.close();
    });
  });

  describe('CAST result typing', () => {
    it('CAST AS INTEGER yields a number, not a stringified value', async () => {
      const schema = [{ name: 'id', dataType: 'INT32' }, { name: 's', dataType: 'VARCHAR' }];
      const catalog = new Catalog();
      registerMockTable(catalog, 'T', schema, [makeChunk([
        { type: 'INT32', values: [1, 2] },
        { type: 'VARCHAR', values: ['7', '42'] },
      ])]);
      const engine = new QueryEngine(catalog);
      const rows = (await engine.run('SELECT CAST(s AS INTEGER) AS ci FROM T ORDER BY id')).rows;
      expect(rows).toEqual([{ ci: 7 }, { ci: 42 }]);
      expect(typeof rows[0].ci).toBe('number');
      engine.close();
    });

    it('CAST AS INTEGER then arithmetic stays numeric', async () => {
      const schema = [{ name: 'id', dataType: 'INT32' }, { name: 's', dataType: 'VARCHAR' }];
      const catalog = new Catalog();
      registerMockTable(catalog, 'T', schema, [makeChunk([
        { type: 'INT32', values: [1] },
        { type: 'VARCHAR', values: ['10'] },
      ])]);
      const engine = new QueryEngine(catalog);
      const rows = (await engine.run('SELECT CAST(s AS INTEGER) + 5 AS n FROM T')).rows;
      expect(rows).toEqual([{ n: 15 }]);
      engine.close();
    });
  });

  describe('engine correctness regressions', () => {
    it('projecting a column out of a DISTINCT keeps distinct on the full row', async () => {
      const schema = [{ name: 'a', dataType: 'INT32' }, { name: 'k', dataType: 'INT32' }];
      const catalog = new Catalog();
      registerMockTable(catalog, 'T', schema, [makeChunk([
        { type: 'INT32', values: [0, 1, 2] },
        { type: 'INT32', values: [2, 2, 3] },
      ])]);
      const engine = new QueryEngine(catalog);
      const result = await engine.run('SELECT k FROM (SELECT DISTINCT a, k FROM T) x');
      expect(result.rows.map(r => r.k).sort()).toEqual([2, 2, 3]);
      engine.close();
    });

    it('join keys that are NULL never match', async () => {
      const sl = [{ name: 'k', dataType: 'INT32' }, { name: 'lv', dataType: 'VARCHAR' }];
      const sr = [{ name: 'k', dataType: 'INT32' }, { name: 'rv', dataType: 'VARCHAR' }];
      const catalog = new Catalog();
      registerMockTable(catalog, 'L', sl, [makeChunk([
        { type: 'INT32', values: [0, 1] }, { type: 'VARCHAR', values: ['L0', 'L1'] },
      ])]);
      registerMockTable(catalog, 'R', sr, [makeChunk([
        { type: 'INT32', values: [0, null] }, { type: 'VARCHAR', values: ['R0', 'Rn'] },
      ])]);
      const engine = new QueryEngine(catalog);
      const result = await engine.run('SELECT L.k, lv, rv FROM L JOIN R ON L.k = R.k');
      expect(result.rows).toEqual([{ k: 0, lv: 'L0', rv: 'R0' }]);
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

describe('LEFT/FULL join outer-side semantics (HASH path)', () => {
  // Regression: a LEFT join must preserve only the LEFT side. A bug emitted unmatched
  // BUILD-side (right/inner) rows too (FULL semantics) whenever the HASH strategy was used.
  function engine(tRows, dRows) {
    const tSchema = [{ name: 'k', dataType: 'INT32' }, { name: 'tv', dataType: 'INT32' }];
    const dSchema = [{ name: 'dk', dataType: 'INT32' }, { name: 'w', dataType: 'INT32' }];
    const catalog = new Catalog();
    registerMockTable(catalog, 'L', tSchema, [makeChunk([
      { type: 'INT32', values: tRows.map(r => r[0]) }, { type: 'INT32', values: tRows.map(r => r[1]) },
    ])]);
    registerMockTable(catalog, 'R', dSchema, [makeChunk([
      { type: 'INT32', values: dRows.map(r => r[0]) }, { type: 'INT32', values: dRows.map(r => r[1]) },
    ])]);
    return new QueryEngine(catalog);
  }

  it('LEFT join drops unmatched right rows and keeps unmatched left rows', async () => {
    // L keys 0..49 (200 rows), R keys 0..24 + 200..224 (250 rows). R keys 200..224 are unmatched.
    const tRows = [], dRows = [];
    for (let i = 0; i < 200; i++) tRows.push([i % 50, i]);
    for (let i = 0; i < 200; i++) dRows.push([i % 25, i]);
    for (let i = 0; i < 50; i++) dRows.push([200 + (i % 25), i]); // unmatched right keys
    const e = engine(tRows, dRows);
    const rows = (await e.run('SELECT l.k AS k, r.w AS w FROM L l LEFT JOIN R r ON l.k = r.dk')).rows;
    // no output row may have a key from R-only (>=200): all output keys come from L (0..49)
    expect(rows.every(r => r.k !== null && r.k < 50)).toBe(true);
    // every L row appears at least once (matched fan-out or null-filled)
    const lKeys = new Set(rows.map(r => r.k));
    for (let k = 0; k < 50; k++) expect(lKeys.has(k)).toBe(true);
    // L keys 25..49 are unmatched -> appear exactly once each with null w
    const unmatched = rows.filter(r => r.k >= 25 && r.k < 50);
    expect(unmatched.every(r => r.w === null)).toBe(true);
    expect(unmatched.length).toBe(100); // 25 keys * 4 L rows each
  });

  it('FULL join keeps unmatched rows from both sides', async () => {
    const tRows = [], dRows = [];
    for (let i = 0; i < 60; i++) tRows.push([i % 30, i]);   // L keys 0..29
    for (let i = 0; i < 60; i++) dRows.push([15 + (i % 30), i]); // R keys 15..44
    const e = engine(tRows, dRows);
    const rows = (await e.run('SELECT l.k AS lk, r.dk AS rk FROM L l FULL OUTER JOIN R r ON l.k = r.dk')).rows;
    // L-only keys 0..14 present with null rk; R-only keys 30..44 present with null lk
    expect(rows.some(r => r.lk !== null && r.lk < 15 && r.rk === null)).toBe(true);
    expect(rows.some(r => r.rk !== null && r.rk >= 30 && r.lk === null)).toBe(true);
  });
});

describe('bind parameters', () => {
  function ordersEngine() {
    const schema = [
      { name: 'region', dataType: 'VARCHAR' },
      { name: 'status', dataType: 'VARCHAR' },
      { name: 'amount', dataType: 'INT32' },
    ];
    const catalog = new Catalog();
    registerMockTable(catalog, 'orders', schema, [
      makeChunk([
        { type: 'VARCHAR', values: ['US', 'US', 'US', 'EU', 'EU'] },
        { type: 'VARCHAR', values: ['active', 'inactive', 'active', 'active', 'active'] },
        { type: 'INT32', values: [100, 50, 200, 999, 40] },
      ]),
    ]);
    return new QueryEngine(catalog);
  }

  it('binds $N placeholders in a schema-qualified conditional aggregate', async () => {
    const engine = ordersEngine();
    const result = await engine.run(
      'SELECT orders.region AS region, SUM(CASE WHEN orders.status = $1 THEN orders.amount END) AS revenue '
      + 'FROM public.orders AS orders WHERE orders.region = $2 GROUP BY orders.region',
      ['active', 'US'],
    );
    expect(result.rows).toEqual([{ region: 'US', revenue: 300 }]);
    engine.close();
  });

  it('substitutes the same value everywhere a placeholder repeats', async () => {
    const engine = ordersEngine();
    const result = await engine.run(
      'SELECT SUM(CASE WHEN status = $1 THEN amount END) AS revenue, '
      + 'COUNT(CASE WHEN status = $1 THEN 1 END) AS cnt FROM orders',
      ['active'],
    );
    expect(result.rows[0].revenue).toBe(1339);
    expect(result.rows[0].cnt).toBe(4);
    engine.close();
  });

  it('binds numeric placeholders with inferred type', async () => {
    const engine = ordersEngine();
    const result = await engine.run(
      'SELECT SUM(amount) AS total FROM orders WHERE amount > $1',
      [60],
    );
    expect(result.rows[0].total).toBe(1299);
    engine.close();
  });

  it('accepts the :N colon placeholder syntax', async () => {
    const engine = ordersEngine();
    const result = await engine.run('SELECT SUM(amount) AS total FROM orders WHERE region = :1', ['EU']);
    expect(result.rows[0].total).toBe(1039);
    engine.close();
  });

  it('throws when a placeholder has no supplied value', async () => {
    const engine = ordersEngine();
    await expect(
      engine.run('SELECT region FROM orders WHERE region = $2', ['US']),
    ).rejects.toThrow('Missing value for parameter $2');
    engine.close();
  });
});
