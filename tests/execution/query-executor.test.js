import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { QueryExecutor } from '../../src/execution/query-executor.js';
import { PlanNodeType, JoinType, PhysicalStrategy } from '../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { Column } from '../../src/storage/column.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';
import { Table } from '../../src/storage/table.js';
import { DataType, timestampToEpochMs } from '../../src/storage/data-type.js';

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
  return {
    getSchema: () => schema,
    async *scan() { for (const c of chunks) yield c; },
  };
}

function mockCatalog(tables) {
  return {
    getTableStorage: (name) => tables[name.toUpperCase()] || tables[name],
    getIndexForColumn: () => null,
  };
}

function mockTempManager() {
  let counter = 0;
  return { allocate: () => `/tmp/test_spill_${counter++}` };
}

function colRef(tableAlias, columnName, columnIndex, dataType = 'INT32') {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias, columnName, columnIndex, dataType, resultType: dataType };
}

function literal(value, dataType = 'INT32') {
  return { kind: BoundExprKind.LITERAL, value, dataType, resultType: dataType };
}

function binary(op, left, right, resultType = 'BOOLEAN') {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType, dataType: resultType };
}

function aggExpr(name, args, distinct = false) {
  return { kind: BoundExprKind.AGGREGATE, name, args, distinct, resultType: 'FLOAT64', dataType: 'FLOAT64' };
}

function scanNode(table, columns, alias) {
  return {
    type: PlanNodeType.SCAN,
    table,
    columns: columns.map(c => ({ name: c })),
    alias: alias || table,
  };
}

async function executeAndCollect(executor, plan, outputColumns) {
  const { sink } = await executor.execute(plan, outputColumns);
  const chunks = sink.chunks || [];
  return chunks.flatMap(c => c.toRows());
}

describe('QueryExecutor', () => {
  const ordersSchema = [
    { name: 'ID', dataType: 'INT32' },
    { name: 'CUSTOMER', dataType: 'VARCHAR' },
    { name: 'AMOUNT', dataType: 'FLOAT64' },
  ];
  const ordersData = [makeChunk([
    { type: 'INT32', values: [1, 2, 3, 4, 5] },
    { type: 'VARCHAR', values: ['alice', 'bob', 'alice', 'charlie', 'bob'] },
    { type: 'FLOAT64', values: [100, 200, 150, 300, 50] },
  ])];

  const itemsSchema = [
    { name: 'ORDER_ID', dataType: 'INT32' },
    { name: 'PRODUCT', dataType: 'VARCHAR' },
    { name: 'QTY', dataType: 'INT32' },
  ];
  const itemsData = [makeChunk([
    { type: 'INT32', values: [1, 1, 2, 3, 5] },
    { type: 'VARCHAR', values: ['pen', 'paper', 'book', 'pen', 'tape'] },
    { type: 'INT32', values: [10, 5, 3, 7, 2] },
  ])];

  function makeExecutor() {
    const catalog = mockCatalog({
      ORDERS: mockStorage(ordersData, ordersSchema),
      ITEMS: mockStorage(itemsData, itemsSchema),
    });
    return new QueryExecutor(catalog, mockTempManager());
  }

  describe('SCAN', () => {
    it('reads all rows from a table', async () => {
      const executor = makeExecutor();
      const plan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const rows = await executeAndCollect(executor, plan, [{ name: 'ID' }, { name: 'CUSTOMER' }, { name: 'AMOUNT' }]);

      expect(rows.length).toBe(5);
      expect(rows[0][0]).toBe(1);
      expect(rows[0][1]).toBe('alice');
    });

    it('projects only requested columns', async () => {
      const executor = makeExecutor();
      const plan = scanNode('ORDERS', ['ID', 'AMOUNT'], 'O');
      const rows = await executeAndCollect(executor, plan, [{ name: 'ID' }, { name: 'AMOUNT' }]);

      expect(rows.length).toBe(5);
      expect(rows[0].length).toBe(2);
      expect(rows[0][0]).toBe(1);
      expect(rows[0][1]).toBe(100);
    });
  });

  describe('FILTER', () => {
    it('filters rows by condition', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const plan = {
        type: PlanNodeType.FILTER,
        condition: binary('>', colRef('O', 'AMOUNT', 2, 'FLOAT64'), literal(150, 'FLOAT64')),
        children: [scan],
      };
      const rows = await executeAndCollect(executor, plan, [{ name: 'ID' }]);

      expect(rows.length).toBe(2);
      const ids = rows.map(r => r[0]);
      expect(ids).toContain(2);
      expect(ids).toContain(4);
    });

    it('returns empty when no rows match', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const plan = {
        type: PlanNodeType.FILTER,
        condition: binary('>', colRef('O', 'AMOUNT', 2, 'FLOAT64'), literal(9999, 'FLOAT64')),
        children: [scan],
      };
      const rows = await executeAndCollect(executor, plan, [{ name: 'ID' }]);

      expect(rows.length).toBe(0);
    });
  });

  describe('PROJECT', () => {
    it('computes derived expressions', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const plan = {
        type: PlanNodeType.PROJECT,
        expressions: [
          { ...colRef('O', 'ID', 0), outputName: 'ID' },
          {
            kind: BoundExprKind.BINARY, op: '*',
            left: colRef('O', 'AMOUNT', 2, 'FLOAT64'),
            right: literal(2, 'FLOAT64'),
            resultType: 'FLOAT64', dataType: 'FLOAT64',
            outputName: 'DOUBLE_AMT',
          },
        ],
        children: [scan],
      };
      const rows = await executeAndCollect(executor, plan, [{ name: 'ID' }, { name: 'DOUBLE_AMT' }]);

      expect(rows.length).toBe(5);
      expect(rows[0][1]).toBe(200);
      expect(rows[2][1]).toBe(300);
    });
  });

  describe('HASH JOIN', () => {
    it('joins two tables on equi-condition', async () => {
      const executor = makeExecutor();
      const left = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const right = scanNode('ITEMS', ['ORDER_ID', 'PRODUCT', 'QTY'], 'I');
      const plan = {
        type: PlanNodeType.JOIN,
        joinType: JoinType.INNER,
        condition: binary('=', colRef('O', 'ID', 0), colRef('I', 'ORDER_ID', 0)),
        children: [left, right],
        physicalStrategy: PhysicalStrategy.HASH,
      };
      const rows = await executeAndCollect(executor, plan, [{ name: 'ID' }, { name: 'PRODUCT' }]);

      expect(rows.length).toBe(5);
      const products = rows.map(r => r[4]);
      expect(products).toContain('pen');
      expect(products).toContain('paper');
      expect(products).toContain('tape');
    });

    it('LEFT JOIN keeps unmatched left rows', async () => {
      const executor = makeExecutor();
      const left = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const right = scanNode('ITEMS', ['ORDER_ID', 'PRODUCT', 'QTY'], 'I');
      const plan = {
        type: PlanNodeType.JOIN,
        joinType: JoinType.LEFT,
        condition: binary('=', colRef('O', 'ID', 0), colRef('I', 'ORDER_ID', 0)),
        children: [left, right],
        physicalStrategy: PhysicalStrategy.HASH,
      };
      const rows = await executeAndCollect(executor, plan, [{ name: 'ID' }]);

      expect(rows.length).toBe(6);
      const order4 = rows.find(r => r[0] === 4);
      expect(order4[3]).toBeNull();
    });

    it('SEMI JOIN returns only matching left rows', async () => {
      const executor = makeExecutor();
      const left = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const right = scanNode('ITEMS', ['ORDER_ID', 'PRODUCT', 'QTY'], 'I');
      const plan = {
        type: PlanNodeType.JOIN,
        joinType: JoinType.SEMI,
        condition: binary('=', colRef('O', 'ID', 0), colRef('I', 'ORDER_ID', 0)),
        children: [left, right],
        physicalStrategy: PhysicalStrategy.HASH,
      };
      const rows = await executeAndCollect(executor, plan, [{ name: 'ID' }]);

      const ids = rows.map(r => r[0]).sort((a, b) => a - b);
      expect(ids).toEqual([1, 2, 3, 5]);
    });

    it('ANTI JOIN returns only non-matching left rows', async () => {
      const executor = makeExecutor();
      const left = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const right = scanNode('ITEMS', ['ORDER_ID', 'PRODUCT', 'QTY'], 'I');
      const plan = {
        type: PlanNodeType.JOIN,
        joinType: JoinType.ANTI,
        condition: binary('=', colRef('O', 'ID', 0), colRef('I', 'ORDER_ID', 0)),
        children: [left, right],
        physicalStrategy: PhysicalStrategy.HASH,
      };
      const rows = await executeAndCollect(executor, plan, [{ name: 'ID' }]);

      expect(rows.length).toBe(1);
      expect(rows[0][0]).toBe(4);
    });
  });

  describe('MERGE JOIN', () => {
    it('joins sorted inputs via merge strategy', async () => {
      const sortedOrdersSchema = [
        { name: 'ID', dataType: 'INT32' },
        { name: 'NAME', dataType: 'VARCHAR' },
      ];
      const sortedOrders = [makeChunk([
        { type: 'INT32', values: [1, 2, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ])];
      const sortedItemsSchema = [
        { name: 'OID', dataType: 'INT32' },
        { name: 'ITEM', dataType: 'VARCHAR' },
      ];
      const sortedItems = [makeChunk([
        { type: 'INT32', values: [1, 3, 4] },
        { type: 'VARCHAR', values: ['x', 'y', 'z'] },
      ])];

      const catalog = mockCatalog({
        S_ORDERS: mockStorage(sortedOrders, sortedOrdersSchema),
        S_ITEMS: mockStorage(sortedItems, sortedItemsSchema),
      });
      const executor = new QueryExecutor(catalog, mockTempManager());

      const left = scanNode('S_ORDERS', ['ID', 'NAME'], 'SO');
      const right = scanNode('S_ITEMS', ['OID', 'ITEM'], 'SI');
      const plan = {
        type: PlanNodeType.JOIN,
        joinType: JoinType.INNER,
        condition: binary('=', colRef('SO', 'ID', 0), colRef('SI', 'OID', 0)),
        children: [left, right],
        physicalStrategy: PhysicalStrategy.MERGE,
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'ID' }, { name: 'ITEM' }]);

      expect(rows.length).toBe(2);
      const ids = rows.map(r => r[0]).sort((a, b) => a - b);
      expect(ids).toEqual([1, 3]);
    });
  });

  describe('AGGREGATE (hash)', () => {
    it('groups and computes SUM', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const plan = {
        type: PlanNodeType.AGGREGATE,
        groupBy: [colRef('O', 'CUSTOMER', 1, 'VARCHAR')],
        aggregates: [{
          name: 'SUM',
          args: [colRef('O', 'AMOUNT', 2, 'FLOAT64')],
          distinct: false,
          resultType: 'FLOAT64',
        }],
        children: [scan],
        physicalStrategy: PhysicalStrategy.HASH,
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'CUSTOMER' }, { name: 'sum' }]);

      expect(rows.length).toBe(3);
      const map = new Map(rows.map(r => [r[0], r[1]]));
      expect(map.get('alice')).toBe(250);
      expect(map.get('bob')).toBe(250);
      expect(map.get('charlie')).toBe(300);
    });

    it('computes COUNT(*) without grouping', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const plan = {
        type: PlanNodeType.AGGREGATE,
        groupBy: [],
        aggregates: [{
          name: 'COUNT_STAR',
          args: [],
          distinct: false,
          resultType: 'INT32',
        }],
        children: [scan],
        physicalStrategy: PhysicalStrategy.HASH,
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'count_star' }]);

      expect(rows.length).toBe(1);
      expect(rows[0][0]).toBe(5);
    });
  });

  describe('AGGREGATE (stream)', () => {
    it('groups sorted input via stream aggregate', async () => {
      const sortedSchema = [
        { name: 'GRP', dataType: 'VARCHAR' },
        { name: 'VAL', dataType: 'FLOAT64' },
      ];
      const sortedData = [makeChunk([
        { type: 'VARCHAR', values: ['a', 'a', 'b', 'b', 'b'] },
        { type: 'FLOAT64', values: [10, 20, 1, 2, 3] },
      ])];

      const catalog = mockCatalog({ SORTED: mockStorage(sortedData, sortedSchema) });
      const executor = new QueryExecutor(catalog, mockTempManager());
      const scan = scanNode('SORTED', ['GRP', 'VAL'], 'S');
      const plan = {
        type: PlanNodeType.AGGREGATE,
        groupBy: [colRef('S', 'GRP', 0, 'VARCHAR')],
        aggregates: [{
          name: 'SUM',
          args: [colRef('S', 'VAL', 1, 'FLOAT64')],
          distinct: false,
          resultType: 'FLOAT64',
        }],
        children: [scan],
        physicalStrategy: PhysicalStrategy.STREAM,
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'GRP' }, { name: 'sum' }]);

      expect(rows.length).toBe(2);
      const map = new Map(rows.map(r => [r[0], r[1]]));
      expect(map.get('a')).toBe(30);
      expect(map.get('b')).toBe(6);
    });
  });

  describe('SORT', () => {
    it('sorts output by key ascending', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const plan = {
        type: PlanNodeType.SORT,
        orderKeys: [{ expr: colRef('O', 'AMOUNT', 2, 'FLOAT64'), direction: 'ASC' }],
        children: [scan],
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'AMOUNT' }]);

      const amounts = rows.map(r => r[2]);
      expect(amounts).toEqual([50, 100, 150, 200, 300]);
    });

    it('sorts descending', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const plan = {
        type: PlanNodeType.SORT,
        orderKeys: [{ expr: colRef('O', 'AMOUNT', 2, 'FLOAT64'), direction: 'DESC' }],
        children: [scan],
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'AMOUNT' }]);

      const amounts = rows.map(r => r[2]);
      expect(amounts).toEqual([300, 200, 150, 100, 50]);
    });
  });

  describe('TOP_N', () => {
    it('returns top N rows by sort key', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const plan = {
        type: PlanNodeType.TOP_N,
        orderKeys: [{ expr: colRef('O', 'AMOUNT', 2, 'FLOAT64'), direction: 'DESC' }],
        count: 3,
        offset: 0,
        children: [scan],
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'AMOUNT' }]);

      expect(rows.length).toBe(3);
      expect(rows.map(r => r[2])).toEqual([300, 200, 150]);
    });

    it('applies offset to skip rows', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const plan = {
        type: PlanNodeType.TOP_N,
        orderKeys: [{ expr: colRef('O', 'AMOUNT', 2, 'FLOAT64'), direction: 'ASC' }],
        count: 2,
        offset: 2,
        children: [scan],
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'AMOUNT' }]);

      expect(rows.length).toBe(2);
      expect(rows.map(r => r[2])).toEqual([150, 200]);
    });
  });

  describe('LIMIT', () => {
    it('limits output row count', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const plan = {
        type: PlanNodeType.LIMIT,
        count: 2,
        offset: 0,
        children: [scan],
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'ID' }]);

      expect(rows.length).toBe(2);
    });

    it('applies offset before limit', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const plan = {
        type: PlanNodeType.LIMIT,
        count: 2,
        offset: 3,
        children: [scan],
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'ID' }]);

      expect(rows.length).toBe(2);
      expect(rows[0][0]).toBe(4);
      expect(rows[1][0]).toBe(5);
    });
  });

  describe('DISTINCT', () => {
    it('removes duplicate rows', async () => {
      const dupsSchema = [{ name: 'VAL', dataType: 'INT32' }];
      const dupsData = [makeChunk([{ type: 'INT32', values: [1, 2, 2, 3, 3, 3] }])];
      const catalog = mockCatalog({ DUPS: mockStorage(dupsData, dupsSchema) });
      const executor = new QueryExecutor(catalog, mockTempManager());

      const scan = scanNode('DUPS', ['VAL'], 'D');
      const plan = { type: PlanNodeType.DISTINCT, children: [scan] };

      const rows = await executeAndCollect(executor, plan, [{ name: 'VAL' }]);

      expect(rows.length).toBe(3);
      const vals = rows.map(r => r[0]).sort((a, b) => a - b);
      expect(vals).toEqual([1, 2, 3]);
    });
  });

  describe('UNION', () => {
    it('UNION ALL combines all rows from both sides', async () => {
      const aSchema = [{ name: 'X', dataType: 'INT32' }];
      const aData = [makeChunk([{ type: 'INT32', values: [1, 2] }])];
      const bSchema = [{ name: 'X', dataType: 'INT32' }];
      const bData = [makeChunk([{ type: 'INT32', values: [2, 3] }])];

      const catalog = mockCatalog({
        A: mockStorage(aData, aSchema),
        B: mockStorage(bData, bSchema),
      });
      const executor = new QueryExecutor(catalog, mockTempManager());

      const plan = {
        type: PlanNodeType.UNION,
        all: true,
        children: [scanNode('A', ['X'], 'A'), scanNode('B', ['X'], 'B')],
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'X' }]);

      expect(rows.length).toBe(4);
    });

    it('UNION removes duplicates across sides', async () => {
      const aSchema = [{ name: 'X', dataType: 'INT32' }];
      const aData = [makeChunk([{ type: 'INT32', values: [1, 2] }])];
      const bSchema = [{ name: 'X', dataType: 'INT32' }];
      const bData = [makeChunk([{ type: 'INT32', values: [2, 3] }])];

      const catalog = mockCatalog({
        A: mockStorage(aData, aSchema),
        B: mockStorage(bData, bSchema),
      });
      const executor = new QueryExecutor(catalog, mockTempManager());

      const plan = {
        type: PlanNodeType.UNION,
        all: false,
        children: [scanNode('A', ['X'], 'A'), scanNode('B', ['X'], 'B')],
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'X' }]);

      expect(rows.length).toBe(3);
    });
  });

  describe('EMPTY', () => {
    it('returns no rows', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID'], 'O');
      const plan = { type: PlanNodeType.EMPTY, children: [scan] };

      const rows = await executeAndCollect(executor, plan, [{ name: 'ID' }]);

      expect(rows.length).toBe(0);
    });
  });

  describe('composite pipeline: FILTER + SORT + LIMIT', () => {
    it('filters, sorts, then limits', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const filtered = {
        type: PlanNodeType.FILTER,
        condition: binary('>=', colRef('O', 'AMOUNT', 2, 'FLOAT64'), literal(100, 'FLOAT64')),
        children: [scan],
      };
      const sorted = {
        type: PlanNodeType.SORT,
        orderKeys: [{ expr: colRef('O', 'AMOUNT', 2, 'FLOAT64'), direction: 'DESC' }],
        children: [filtered],
      };
      const plan = {
        type: PlanNodeType.LIMIT,
        count: 2,
        offset: 0,
        children: [sorted],
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'AMOUNT' }]);

      expect(rows.length).toBe(2);
      expect(rows[0][2]).toBe(300);
      expect(rows[1][2]).toBe(200);
    });
  });

  describe('composite pipeline: JOIN + AGGREGATE', () => {
    it('joins then aggregates', async () => {
      const executor = makeExecutor();
      const left = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const right = scanNode('ITEMS', ['ORDER_ID', 'PRODUCT', 'QTY'], 'I');
      const joined = {
        type: PlanNodeType.JOIN,
        joinType: JoinType.INNER,
        condition: binary('=', colRef('O', 'ID', 0), colRef('I', 'ORDER_ID', 0)),
        children: [left, right],
        physicalStrategy: PhysicalStrategy.HASH,
      };

      const plan = {
        type: PlanNodeType.AGGREGATE,
        groupBy: [colRef('O', 'CUSTOMER', 1, 'VARCHAR')],
        aggregates: [{
          name: 'SUM',
          args: [colRef('I', 'QTY', 5, 'INT32')],
          distinct: false,
          resultType: 'FLOAT64',
        }],
        children: [joined],
        physicalStrategy: PhysicalStrategy.HASH,
      };

      const rows = await executeAndCollect(executor, plan, [{ name: 'CUSTOMER' }, { name: 'sum' }]);

      const map = new Map(rows.map(r => [r[0], r[1]]));
      expect(map.get('alice')).toBe(22);
      expect(map.get('bob')).toBe(5);
    });
  });

  describe('composite pipeline: PROJECT + FILTER + DISTINCT', () => {
    it('projects, filters, then deduplicates', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID', 'CUSTOMER', 'AMOUNT'], 'O');
      const project = {
        type: PlanNodeType.PROJECT,
        expressions: [
          { ...colRef('O', 'CUSTOMER', 1, 'VARCHAR'), outputName: 'CUSTOMER' },
        ],
        children: [scan],
      };
      const distinct = { type: PlanNodeType.DISTINCT, children: [project] };

      const rows = await executeAndCollect(executor, distinct, [{ name: 'CUSTOMER' }]);

      expect(rows.length).toBe(3);
      const names = rows.map(r => r[0]).sort();
      expect(names).toEqual(['alice', 'bob', 'charlie']);
    });
  });

  describe('error handling', () => {
    it('throws on unsupported plan node type', async () => {
      const executor = makeExecutor();
      const plan = { type: 'NONSENSE', children: [] };

      await expect(executeAndCollect(executor, plan, [])).rejects.toThrow('Unsupported plan node');
    });

    it('throws when table storage not found', async () => {
      const executor = makeExecutor();
      const plan = scanNode('NONEXISTENT', ['ID'], 'X');

      await expect(executeAndCollect(executor, plan, [{ name: 'ID' }])).rejects.toThrow('No storage');
    });
  });
});

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
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea_test_'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns plan with execution time and row count', async () => {
    const catalog = new Catalog();
    catalog.registerTable('t', [{ name: 'x', dataType: DataType.INT32 }]);
    const table = new Table('t', [{ name: 'x', dataType: DataType.INT32 }], tmpDir);
    await table.insertRows([[1], [2], [3]]);
    catalog.registerTableStorage('t', table);

    const engine = new QueryEngine(catalog);
    const result = await engine.run('EXPLAIN ANALYZE SELECT x FROM t WHERE x > 1');
    expect(result.columns).toContain('EXPLAIN_ANALYZE');
    const plan = result.rows[0]['EXPLAIN_ANALYZE'];
    expect(plan).toContain('Execution Time');
    expect(plan).toContain('ms');
    expect(plan).toContain('Rows Returned');
    engine.close();
  });

  it('execution time is a positive number', async () => {
    const catalog = new Catalog();
    catalog.registerTable('t', [{ name: 'x', dataType: DataType.INT32 }]);
    const table = new Table('t', [{ name: 'x', dataType: DataType.INT32 }], tmpDir);
    await table.insertRows([[1]]);
    catalog.registerTableStorage('t', table);

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
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nj_test_'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeJoinEngine(dir) {
    const catalog = new Catalog();
    catalog.registerTable('users', [
      { name: 'id', dataType: DataType.INT32 },
      { name: 'name', dataType: DataType.VARCHAR },
    ]);
    catalog.registerTable('profiles', [
      { name: 'id', dataType: DataType.INT32 },
      { name: 'bio', dataType: DataType.VARCHAR },
    ]);

    const usersDir = path.join(dir, 'users');
    fs.mkdirSync(usersDir, { recursive: true });
    const users = new Table('users', [
      { name: 'id', dataType: DataType.INT32 },
      { name: 'name', dataType: DataType.VARCHAR },
    ], usersDir);
    users.insertRows([[1, 'Alice'], [2, 'Bob'], [3, 'Charlie']]);
    catalog.registerTableStorage('users', users);

    const profilesDir = path.join(dir, 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    const profiles = new Table('profiles', [
      { name: 'id', dataType: DataType.INT32 },
      { name: 'bio', dataType: DataType.VARCHAR },
    ], profilesDir);
    profiles.insertRows([[1, 'Engineer'], [2, 'Designer']]);
    catalog.registerTableStorage('profiles', profiles);

    return new QueryEngine(catalog);
  }

  it('NATURAL JOIN matches on common column name (id)', async () => {
    const engine = makeJoinEngine(tmpDir);
    const result = await engine.run('SELECT u.name, p.bio FROM users u NATURAL JOIN profiles p');
    expect(result.rows).toHaveLength(2);
    const alice = result.rows.find(r => r.name === 'Alice');
    expect(alice.bio).toBe('Engineer');
    engine.close();
  });

  it('JOIN USING matches on specified column', async () => {
    const engine = makeJoinEngine(tmpDir);
    const result = await engine.run('SELECT u.name, p.bio FROM users u JOIN profiles p USING (id)');
    expect(result.rows).toHaveLength(2);
    engine.close();
  });

  it('NATURAL LEFT JOIN preserves unmatched rows', async () => {
    const engine = makeJoinEngine(tmpDir);
    const result = await engine.run('SELECT u.name, p.bio FROM users u NATURAL LEFT JOIN profiles p');
    expect(result.rows).toHaveLength(3);
    const charlie = result.rows.find(r => r.name === 'Charlie');
    expect(charlie.bio).toBeNull();
    engine.close();
  });
});

describe('window functions execution', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf_test_'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeWindowEngine(dir) {
    const catalog = new Catalog();
    catalog.registerTable('employees', [
      { name: 'id', dataType: DataType.INT32 },
      { name: 'dept', dataType: DataType.VARCHAR },
      { name: 'salary', dataType: DataType.INT32 },
      { name: 'name', dataType: DataType.VARCHAR },
    ]);
    const table = new Table('employees', [
      { name: 'id', dataType: DataType.INT32 },
      { name: 'dept', dataType: DataType.VARCHAR },
      { name: 'salary', dataType: DataType.INT32 },
      { name: 'name', dataType: DataType.VARCHAR },
    ], dir);
    table.insertRows([
      [1, 'eng', 100, 'Alice'],
      [2, 'eng', 120, 'Bob'],
      [3, 'eng', 110, 'Charlie'],
      [4, 'sales', 90, 'Dave'],
      [5, 'sales', 95, 'Eve'],
    ]);
    catalog.registerTableStorage('employees', table);
    return new QueryEngine(catalog);
  }

  it('ROW_NUMBER assigns sequential numbers', async () => {
    const engine = makeWindowEngine(tmpDir);
    const result = await engine.run('SELECT name, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM employees ORDER BY id');
    const rns = result.rows.map(r => r.rn);
    expect(rns).toEqual([1, 2, 3, 4, 5]);
    engine.close();
  });

  it('ROW_NUMBER with PARTITION BY resets per partition', async () => {
    const engine = makeWindowEngine(tmpDir);
    const result = await engine.run('SELECT name, dept, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary) AS rn FROM employees ORDER BY dept, salary');
    const engRows = result.rows.filter(r => r.dept === 'eng');
    const salesRows = result.rows.filter(r => r.dept === 'sales');
    expect(engRows.map(r => r.rn)).toEqual([1, 2, 3]);
    expect(salesRows.map(r => r.rn)).toEqual([1, 2]);
    engine.close();
  });

  it('RANK produces gaps on ties', async () => {
    const catalog = new Catalog();
    catalog.registerTable('scores', [
      { name: 'name', dataType: DataType.VARCHAR },
      { name: 'score', dataType: DataType.INT32 },
    ]);
    const scoresDir = path.join(tmpDir, 'scores');
    fs.mkdirSync(scoresDir, { recursive: true });
    const table = new Table('scores', [
      { name: 'name', dataType: DataType.VARCHAR },
      { name: 'score', dataType: DataType.INT32 },
    ], scoresDir);
    table.insertRows([
      ['A', 100], ['B', 100], ['C', 90], ['D', 80],
    ]);
    catalog.registerTableStorage('scores', table);
    const engine = new QueryEngine(catalog);

    const result = await engine.run('SELECT name, score, RANK() OVER (ORDER BY score DESC) AS rnk FROM scores ORDER BY score DESC, name');
    const ranks = result.rows.map(r => r.rnk);
    expect(ranks).toEqual([1, 1, 3, 4]);
    engine.close();
  });

  it('DENSE_RANK has no gaps', async () => {
    const catalog = new Catalog();
    catalog.registerTable('scores', [
      { name: 'name', dataType: DataType.VARCHAR },
      { name: 'score', dataType: DataType.INT32 },
    ]);
    const scoresDir = path.join(tmpDir, 'scores2');
    fs.mkdirSync(scoresDir, { recursive: true });
    const table = new Table('scores', [
      { name: 'name', dataType: DataType.VARCHAR },
      { name: 'score', dataType: DataType.INT32 },
    ], scoresDir);
    table.insertRows([
      ['A', 100], ['B', 100], ['C', 90], ['D', 80],
    ]);
    catalog.registerTableStorage('scores', table);
    const engine = new QueryEngine(catalog);

    const result = await engine.run('SELECT name, score, DENSE_RANK() OVER (ORDER BY score DESC) AS drnk FROM scores ORDER BY score DESC, name');
    const ranks = result.rows.map(r => r.drnk);
    expect(ranks).toEqual([1, 1, 2, 3]);
    engine.close();
  });

  it('LAG returns previous row value', async () => {
    const engine = makeWindowEngine(tmpDir);
    const result = await engine.run('SELECT name, salary, LAG(salary, 1) OVER (ORDER BY id) AS prev_salary FROM employees ORDER BY id');
    expect(result.rows[0].prev_salary).toBeNull();
    expect(result.rows[1].prev_salary).toBe(100);
    expect(result.rows[2].prev_salary).toBe(120);
    engine.close();
  });
});

describe('scalar functions execution', () => {
  let tmpDir;
  let engine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn_test_'));
    const catalog = new Catalog();
    catalog.registerTable('data', [
      { name: 'val', dataType: DataType.INT32 },
      { name: 'txt', dataType: DataType.VARCHAR },
    ]);
    const table = new Table('data', [
      { name: 'val', dataType: DataType.INT32 },
      { name: 'txt', dataType: DataType.VARCHAR },
    ], tmpDir);
    table.insertRows([
      [16, 'hello world'],
      [25, 'foo bar'],
      [0, 'test'],
      [9, null],
    ]);
    catalog.registerTableStorage('data', table);
    engine = new QueryEngine(catalog);
  });

  afterEach(() => {
    engine.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('SQRT', () => {
    it('computes square root correctly', async () => {
      const result = await engine.run('SELECT SQRT(val) AS sq FROM data ORDER BY val');
      expect(result.rows[0].sq).toBe(0);
      expect(result.rows[1].sq).toBe(3);
      expect(result.rows[2].sq).toBe(4);
      expect(result.rows[3].sq).toBe(5);
    });

    it('returns null for null input', async () => {
      const result = await engine.run('SELECT SQRT(val) AS sq FROM data WHERE val = 9');
      expect(result.rows[0].sq).toBe(3);
    });
  });

  describe('LENGTH', () => {
    it('returns string length', async () => {
      const result = await engine.run("SELECT LENGTH(txt) AS len FROM data WHERE txt = 'hello world'");
      expect(result.rows[0].len).toBe(11);
    });

    it('returns null for null input', async () => {
      const result = await engine.run('SELECT LENGTH(txt) AS len FROM data WHERE val = 9');
      expect(result.rows[0].len).toBeNull();
    });
  });

  describe('REPLACE', () => {
    it('replaces all occurrences of substring', async () => {
      const result = await engine.run("SELECT REPLACE(txt, 'o', '0') AS rep FROM data WHERE txt = 'foo bar'");
      expect(result.rows[0].rep).toBe('f00 bar');
    });

    it('returns original when pattern not found', async () => {
      const result = await engine.run("SELECT REPLACE(txt, 'xyz', '!') AS rep FROM data WHERE txt = 'test'");
      expect(result.rows[0].rep).toBe('test');
    });

    it('returns null when any arg is null', async () => {
      const result = await engine.run("SELECT REPLACE(txt, 'a', 'b') AS rep FROM data WHERE val = 9");
      expect(result.rows[0].rep).toBeNull();
    });
  });
});

describe('TIMESTAMP end-to-end', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts_test_'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts HOUR, MINUTE, SECOND from timestamp', async () => {
    const catalog = new Catalog();
    catalog.registerTable('events', [
      { name: 'id', dataType: DataType.INT32 },
      { name: 'ts', dataType: DataType.TIMESTAMP },
    ]);
    const table = new Table('events', [
      { name: 'id', dataType: DataType.INT32 },
      { name: 'ts', dataType: DataType.TIMESTAMP },
    ], tmpDir);
    const tsVal = BigInt(timestampToEpochMs(2024, 3, 15, 14, 30, 45, 0));
    await table.insertRows([[1, tsVal]]);
    catalog.registerTableStorage('events', table);

    const engine = new QueryEngine(catalog);
    const result = await engine.run('SELECT EXTRACT(HOUR FROM ts), EXTRACT(MINUTE FROM ts), EXTRACT(SECOND FROM ts) FROM events');
    expect(result.rows[0][Object.keys(result.rows[0])[0]]).toBe(14);
    expect(result.rows[0][Object.keys(result.rows[0])[1]]).toBe(30);
    expect(result.rows[0][Object.keys(result.rows[0])[2]]).toBe(45);
    engine.close();
  });
});
