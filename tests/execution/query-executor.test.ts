import { describe, it, expect } from 'vitest';
import { QueryExecutor } from '../../src/execution/query-executor.js';
import { PlanNodeType, JoinType, SetOpType } from '../../src/planner/logical-plan.js';
import { PhysicalPlanner } from '../../src/execution/physical-planner.js';
import { PhysicalNodeType } from '../../src/execution/physical-plan.js';
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

async function collectRows(executor, plan, columnNames) {
  const { sink } = await executor.execute(plan, columnNames.map(n => ({ name: n })));
  const chunks = await sink.collect();
  const rawRows = chunks.flatMap(c => c.toRows());
  return rawRows.map(row => {
    const obj = {};
    for (let i = 0; i < columnNames.length; i++) {
      obj[columnNames[i]] = row[i];
    }
    return obj;
  });
}

async function collectRaw(executor, plan) {
  const { sink } = await executor.execute(plan, []);
  const chunks = await sink.collect();
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
      const rows = await collectRows(executor, plan, ['ID', 'CUSTOMER', 'AMOUNT']);

      expect(rows.length).toBe(5);
      expect(rows[0].ID).toBe(1);
      expect(rows[0].CUSTOMER).toBe('alice');
    });

    it('projects only requested columns', async () => {
      const executor = makeExecutor();
      const plan = scanNode('ORDERS', ['ID', 'AMOUNT'], 'O');
      const rows = await collectRows(executor, plan, ['ID', 'AMOUNT']);

      expect(rows.length).toBe(5);
      expect(rows[0].ID).toBe(1);
      expect(rows[0].AMOUNT).toBe(100);
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
      const rows = await collectRows(executor, plan, ['ID', 'CUSTOMER', 'AMOUNT']);

      expect(rows.length).toBe(2);
      const ids = rows.map(r => r.ID);
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
      const rows = await collectRaw(executor, plan);

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
      const rows = await collectRows(executor, plan, ['ID', 'DOUBLE_AMT']);

      expect(rows.length).toBe(5);
      expect(rows[0].DOUBLE_AMT).toBe(200);
      expect(rows[2].DOUBLE_AMT).toBe(300);
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
      };
      const rows = await collectRaw(executor, plan);

      expect(rows.length).toBe(5);
      const allValues = rows.flat();
      expect(allValues).toContain('pen');
      expect(allValues).toContain('paper');
      expect(allValues).toContain('tape');
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
      };
      const rows = await collectRaw(executor, plan);

      expect(rows.length).toBe(6);
      const unmatchedRow = rows.find(r => r.includes(4) && r.includes('charlie'));
      expect(unmatchedRow).toBeDefined();
      const nullCount = unmatchedRow.filter(v => v === null).length;
      expect(nullCount).toBeGreaterThanOrEqual(3);
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
      };
      const rows = await collectRaw(executor, plan);

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
      };
      const rows = await collectRaw(executor, plan);

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

      const left = {
        type: PlanNodeType.SORT,
        orderKeys: [{ expr: colRef('SO', 'ID', 0), direction: 'ASC' }],
        children: [scanNode('S_ORDERS', ['ID', 'NAME'], 'SO')],
      };
      const right = {
        type: PlanNodeType.SORT,
        orderKeys: [{ expr: colRef('SI', 'OID', 0), direction: 'ASC' }],
        children: [scanNode('S_ITEMS', ['OID', 'ITEM'], 'SI')],
      };
      const plan = {
        type: PlanNodeType.JOIN,
        joinType: JoinType.INNER,
        condition: binary('=', colRef('SO', 'ID', 0), colRef('SI', 'OID', 0)),
        children: [left, right],
      };

      expect(new PhysicalPlanner().plan(plan).type).toBe(PhysicalNodeType.MERGE_JOIN);

      const rows = await collectRaw(executor, plan);

      expect(rows.length).toBe(2);
      const allValues = rows.flat();
      expect(allValues).toContain(1);
      expect(allValues).toContain(3);
      expect(allValues).not.toContain(2);
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
      };

      const rows = await collectRows(executor, plan, ['CUSTOMER', 'SUM']);

      expect(rows.length).toBe(3);
      const map = new Map(rows.map(r => [r.CUSTOMER, r.SUM]));
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
      };

      const rows = await collectRows(executor, plan, ['COUNT']);

      expect(rows.length).toBe(1);
      expect(rows[0].COUNT).toBe(5);
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
      const scan = {
        type: PlanNodeType.SORT,
        orderKeys: [{ expr: colRef('S', 'GRP', 0, 'VARCHAR'), direction: 'ASC' }],
        children: [scanNode('SORTED', ['GRP', 'VAL'], 'S')],
      };
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
      };

      expect(new PhysicalPlanner().plan(plan).type).toBe(PhysicalNodeType.STREAM_AGGREGATE);

      const rows = await collectRows(executor, plan, ['GRP', 'SUM']);

      expect(rows.length).toBe(2);
      const map = new Map(rows.map(r => [r.GRP, r.SUM]));
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

      const rows = await collectRows(executor, plan, ['ID', 'CUSTOMER', 'AMOUNT']);

      const amounts = rows.map(r => r.AMOUNT);
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

      const rows = await collectRows(executor, plan, ['ID', 'CUSTOMER', 'AMOUNT']);

      const amounts = rows.map(r => r.AMOUNT);
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

      const rows = await collectRows(executor, plan, ['ID', 'CUSTOMER', 'AMOUNT']);

      expect(rows.length).toBe(3);
      expect(rows.map(r => r.AMOUNT)).toEqual([300, 200, 150]);
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

      const rows = await collectRows(executor, plan, ['ID', 'CUSTOMER', 'AMOUNT']);

      expect(rows.length).toBe(2);
      expect(rows.map(r => r.AMOUNT)).toEqual([150, 200]);
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

      const rows = await collectRaw(executor, plan);

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

      const rows = await collectRows(executor, plan, ['ID', 'CUSTOMER', 'AMOUNT']);

      expect(rows.length).toBe(2);
      expect(rows[0].ID).toBe(4);
      expect(rows[1].ID).toBe(5);
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

      const rows = await collectRows(executor, plan, ['VAL']);

      expect(rows.length).toBe(3);
      const vals = rows.map(r => r.VAL).sort((a, b) => a - b);
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
        type: PlanNodeType.SET_OP,
        op: SetOpType.UNION,
        all: true,
        children: [scanNode('A', ['X'], 'A'), scanNode('B', ['X'], 'B')],
      };

      const rows = await collectRaw(executor, plan);

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
        type: PlanNodeType.SET_OP,
        op: SetOpType.UNION,
        all: false,
        children: [scanNode('A', ['X'], 'A'), scanNode('B', ['X'], 'B')],
      };

      const rows = await collectRaw(executor, plan);

      expect(rows.length).toBe(3);
    });
  });

  describe('EMPTY', () => {
    it('returns no rows', async () => {
      const executor = makeExecutor();
      const scan = scanNode('ORDERS', ['ID'], 'O');
      const plan = { type: PlanNodeType.EMPTY, children: [scan] };

      const rows = await collectRaw(executor, plan);

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

      const rows = await collectRows(executor, plan, ['ID', 'CUSTOMER', 'AMOUNT']);

      expect(rows.length).toBe(2);
      expect(rows[0].AMOUNT).toBe(300);
      expect(rows[1].AMOUNT).toBe(200);
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
      };

      const rows = await collectRows(executor, plan, ['CUSTOMER', 'SUM']);

      const map = new Map(rows.map(r => [r.CUSTOMER, r.SUM]));
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

      const rows = await collectRows(executor, distinct, ['CUSTOMER']);

      expect(rows.length).toBe(3);
      const names = rows.map(r => r.CUSTOMER).sort();
      expect(names).toEqual(['alice', 'bob', 'charlie']);
    });
  });

  describe('MERGE JOIN SEMI', () => {
    it('outputs only matching probe rows with probe-side columns', async () => {
      const leftSchema = [
        { name: 'ID', dataType: 'INT32' },
        { name: 'NAME', dataType: 'VARCHAR' },
      ];
      const leftData = [makeChunk([
        { type: 'INT32', values: [1, 2, 3, 4] },
        { type: 'VARCHAR', values: ['alice', 'bob', 'charlie', 'diana'] },
      ])];
      const rightSchema = [
        { name: 'RID', dataType: 'INT32' },
        { name: 'EXTRA', dataType: 'VARCHAR' },
      ];
      const rightData = [makeChunk([
        { type: 'INT32', values: [1, 3] },
        { type: 'VARCHAR', values: ['x', 'y'] },
      ])];

      const catalog = mockCatalog({
        L: mockStorage(leftData, leftSchema),
        R: mockStorage(rightData, rightSchema),
      });
      const executor = new QueryExecutor(catalog, mockTempManager());

      const left = scanNode('L', ['ID', 'NAME'], 'L');
      const right = scanNode('R', ['RID', 'EXTRA'], 'R');
      const plan = {
        type: PlanNodeType.JOIN,
        joinType: JoinType.SEMI,
        condition: binary('=', colRef('L', 'ID', 0), colRef('R', 'RID', 0)),
        children: [left, right],
      };

      const rows = await collectRows(executor, plan, ['ID', 'NAME']);

      expect(rows.length).toBe(2);
      expect(Object.keys(rows[0]).length).toBe(2);
      const names = rows.map(r => r.NAME).sort();
      expect(names).toEqual(['alice', 'charlie']);
    });
  });

  describe('MERGE JOIN ANTI', () => {
    it('outputs only non-matching probe rows with probe-side columns', async () => {
      const leftSchema = [
        { name: 'ID', dataType: 'INT32' },
        { name: 'VAL', dataType: 'VARCHAR' },
      ];
      const leftData = [makeChunk([
        { type: 'INT32', values: [1, 2, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ])];
      const rightSchema = [
        { name: 'RID', dataType: 'INT32' },
      ];
      const rightData = [makeChunk([
        { type: 'INT32', values: [1, 3] },
      ])];

      const catalog = mockCatalog({
        L: mockStorage(leftData, leftSchema),
        R: mockStorage(rightData, rightSchema),
      });
      const executor = new QueryExecutor(catalog, mockTempManager());

      const left = scanNode('L', ['ID', 'VAL'], 'L');
      const right = scanNode('R', ['RID'], 'R');
      const plan = {
        type: PlanNodeType.JOIN,
        joinType: JoinType.ANTI,
        condition: binary('=', colRef('L', 'ID', 0), colRef('R', 'RID', 0)),
        children: [left, right],
      };

      const rows = await collectRows(executor, plan, ['ID', 'VAL']);

      expect(rows.length).toBe(1);
      expect(rows[0].ID).toBe(2);
      expect(rows[0].VAL).toBe('b');
      expect(Object.keys(rows[0]).length).toBe(2);
    });
  });

  describe('MERGE JOIN MARK', () => {
    it('appends boolean mark column to probe rows', async () => {
      const leftSchema = [
        { name: 'ID', dataType: 'INT32' },
        { name: 'NAME', dataType: 'VARCHAR' },
      ];
      const leftData = [makeChunk([
        { type: 'INT32', values: [1, 2, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ])];
      const rightSchema = [
        { name: 'RID', dataType: 'INT32' },
      ];
      const rightData = [makeChunk([
        { type: 'INT32', values: [1, 3] },
      ])];

      const catalog = mockCatalog({
        L: mockStorage(leftData, leftSchema),
        R: mockStorage(rightData, rightSchema),
      });
      const executor = new QueryExecutor(catalog, mockTempManager());

      const left = scanNode('L', ['ID', 'NAME'], 'L');
      const right = scanNode('R', ['RID'], 'R');
      const plan = {
        type: PlanNodeType.JOIN,
        joinType: JoinType.MARK,
        condition: binary('=', colRef('L', 'ID', 0), colRef('R', 'RID', 0)),
        children: [left, right],
        markColumn: '__mark',
      };

      const rows = await collectRows(executor, plan, ['ID', 'NAME', '__mark']);

      expect(rows.length).toBe(3);
      expect(Object.keys(rows[0]).length).toBe(3);
      const marked = rows.find(r => r.ID === 1);
      expect(marked.__mark).toBe(true);
      const unmarked = rows.find(r => r.ID === 2);
      expect(unmarked.__mark).toBe(false);
    });
  });

  describe('LEFT JOIN with build-side swap', () => {
    it('preserves all left rows when physical build side differs from logical left', async () => {
      const leftSchema = [
        { name: 'ID', dataType: 'INT32' },
        { name: 'NAME', dataType: 'VARCHAR' },
        { name: 'FK', dataType: 'INT32' },
      ];
      const leftData = [makeChunk([
        { type: 'INT32', values: [1, 2, 3, 4] },
        { type: 'VARCHAR', values: ['w', 'x', 'y', 'z'] },
        { type: 'INT32', values: [10, 20, 10, 99] },
      ])];
      const rightSchema = [
        { name: 'SID', dataType: 'INT32' },
        { name: 'LABEL', dataType: 'VARCHAR' },
      ];
      const rightData = [makeChunk([
        { type: 'INT32', values: [10, 20] },
        { type: 'VARCHAR', values: ['alpha', 'beta'] },
      ])];

      const catalog = mockCatalog({
        L: mockStorage(leftData, leftSchema),
        R: mockStorage(rightData, rightSchema),
      });
      const executor = new QueryExecutor(catalog, mockTempManager());

      const left = scanNode('L', ['ID', 'NAME', 'FK'], 'L');
      const right = scanNode('R', ['SID', 'LABEL'], 'R');
      const plan = {
        type: PlanNodeType.JOIN,
        joinType: JoinType.LEFT,
        condition: binary('=', colRef('L', 'FK', 2), colRef('R', 'SID', 0)),
        children: [left, right],
        _buildSide: 'right',
      };

      const rows = await collectRaw(executor, plan);

      expect(rows.length).toBe(4);
      const unmatchedRow = rows.find(r => r.includes(4) && r.includes('z'));
      expect(unmatchedRow).toBeDefined();
      const nullCount = unmatchedRow.filter(v => v === null).length;
      expect(nullCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('NESTED LOOP JOIN with equi-key-only condition', () => {
    it('evaluates full condition instead of residual-only', async () => {
      const aSchema = [
        { name: 'K', dataType: 'INT32' },
        { name: 'V', dataType: 'VARCHAR' },
      ];
      const aData = [makeChunk([
        { type: 'INT32', values: [1, 2] },
        { type: 'VARCHAR', values: ['a1', 'a2'] },
      ])];
      const bSchema = [
        { name: 'K', dataType: 'INT32' },
        { name: 'V', dataType: 'VARCHAR' },
      ];
      const bData = [makeChunk([
        { type: 'INT32', values: [1, 3] },
        { type: 'VARCHAR', values: ['b1', 'b3'] },
      ])];

      const catalog = mockCatalog({
        A: mockStorage(aData, aSchema),
        B: mockStorage(bData, bSchema),
      });
      const executor = new QueryExecutor(catalog, mockTempManager());

      const left = scanNode('A', ['K', 'V'], 'A');
      const right = scanNode('B', ['K', 'V'], 'B');
      const plan = {
        type: PlanNodeType.JOIN,
        joinType: JoinType.INNER,
        condition: binary('=', colRef('A', 'K', 0), colRef('B', 'K', 0)),
        children: [left, right],
      };

      const rows = await collectRaw(executor, plan);

      expect(rows.length).toBe(1);
      const allValues = rows[0];
      expect(allValues).toContain(1);
      expect(allValues).toContain('a1');
      expect(allValues).toContain('b1');
    });
  });

  describe('error handling', () => {
    it('throws on unsupported plan node type', async () => {
      const executor = makeExecutor();
      const plan = { type: 'NONSENSE', children: [] };

      await expect(collectRaw(executor, plan)).rejects.toThrow('No physical operator');
    });

    it('throws when table storage not found', async () => {
      const executor = makeExecutor();
      const plan = scanNode('NONEXISTENT', ['ID'], 'X');

      await expect(collectRaw(executor, plan)).rejects.toThrow('No storage');
    });
  });
});
