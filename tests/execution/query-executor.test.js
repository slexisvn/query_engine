import { describe, it, expect } from 'vitest';
import { QueryExecutor } from '../../src/execution/query-executor.js';
import { PlanNodeType, JoinType, PhysicalStrategy } from '../../src/planner/logical-plan.js';
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
