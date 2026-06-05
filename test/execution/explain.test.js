import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QueryEngine } from '../../src/index.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { Table } from '../../src/storage/table.js';
import { Column } from '../../src/storage/column.js';
import { TempDirectoryManager } from '../../src/storage/temp-directory-manager.js';

describe('EXPLAIN Support', () => {
  let engine;
  let tempManager;

  beforeEach(() => {
    tempManager = new TempDirectoryManager();
    const catalog = new Catalog();
    const schema = [
      { name: 'id', dataType: 'INT32' },
      { name: 'val', dataType: 'INT32' }
    ];
    const tStorage = new Table('t', schema, tempManager.allocate('buffer', 't'));
    catalog.registerTable('t', schema);
    catalog.registerTableStorage('t', tStorage);

    const c1 = new Column('INT32', 1);
    c1.set(0, 1);
    c1.length = 1;
    const c2 = new Column('INT32', 1);
    c2.set(0, 10);
    c2.length = 1;
    
    // We don't even need to add data because EXPLAIN shouldn't execute anything!
    
    engine = new QueryEngine(catalog);
  });

  afterEach(() => {
    tempManager.cleanup();
  });

  it('should format a basic SELECT query plan', async () => {
    const result = await engine.run('EXPLAIN SELECT * FROM t WHERE id = 1');
    
    expect(result.columns).toEqual(['EXPLAIN_PLAN']);
    expect(result.rows).toHaveLength(1);
    
    const plan = result.rows[0].EXPLAIN_PLAN;
    expect(plan).toContain('-> Project (T.id, T.val)');
    expect(plan).toContain('-> Filter (condition: (T.id = 1))');
    expect(plan).toContain('-> Seq Scan on T as T');
  });

  it('should format a JOIN query plan', async () => {
    const result = await engine.run(`
      EXPLAIN SELECT t1.id, t2.val 
      FROM t t1 
      JOIN t t2 ON t1.id = t2.id
    `);
    
    const plan = result.rows[0].EXPLAIN_PLAN;
    expect(plan).toContain('-> Project (T1.id, T2.val)');
    expect(plan).toContain('Join (condition: (T1.id = T2.id))');
    expect(plan).toContain('-> Seq Scan on T as T1');
    expect(plan).toContain('-> Seq Scan on T as T2');
  });

  it('should format an AGGREGATE query plan', async () => {
    const result = await engine.run('EXPLAIN SELECT id, SUM(val) FROM t GROUP BY id');
    
    const plan = result.rows[0].EXPLAIN_PLAN;
    expect(plan).toContain('-> Project (T.id, SUM(T.val))');
    expect(plan).toContain('Aggregate (group by: T.id) (aggs: SUM(T.val))');
  });

  it('should expose aggregate physical strategies', async () => {
    const result = await engine.run('EXPLAIN SELECT SUM(val) FROM t');
    const plan = result.rows[0].EXPLAIN_PLAN;
    expect(plan).toContain('Ungrouped Aggregate');
  });
});
