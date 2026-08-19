import { describe, it, expect } from 'vitest';
import { QueryExecutor } from '../../src/execution/query-executor.js';
import { PlanNodeType} from '../../src/planner/logical-plan.js';
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

function aggExpr(name, args, distinct = false) {
  return { kind: BoundExprKind.AGGREGATE, name, func: name, args, distinct, resultType: 'FLOAT64', dataType: 'FLOAT64' };
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

describe('buildExchange', () => {
  it('passes data through in local mode (no distributed context)', async () => {
    const schema = [
      { name: 'ID', dataType: 'INT32' },
      { name: 'VAL', dataType: 'FLOAT64' },
    ];
    const chunk = makeChunk([
      { type: 'INT32', values: [1, 2, 3] },
      { type: 'FLOAT64', values: [10.0, 20.0, 30.0] },
    ]);
    const storage = mockStorage([chunk], schema);
    const catalog = mockCatalog({ ITEMS: storage });
    const executor = new QueryExecutor(catalog, mockTempManager());

    const plan = {
      type: PlanNodeType.EXCHANGE,
      exchangeType: 'hash_shuffle',
      partitionKeys: [],
      partitionCount: 4,
      children: [scanNode('ITEMS', ['ID', 'VAL'])],
    };

    const rows = await collectRows(executor, plan, ['ID', 'VAL']);
    expect(rows).toEqual([
      { ID: 1, VAL: 10.0 },
      { ID: 2, VAL: 20.0 },
      { ID: 3, VAL: 30.0 },
    ]);
  });

  it('preserves child schema through exchange', async () => {
    const schema = [{ name: 'X', dataType: 'INT32' }];
    const chunk = makeChunk([{ type: 'INT32', values: [42] }]);
    const storage = mockStorage([chunk], schema);
    const catalog = mockCatalog({ T: storage });
    const executor = new QueryExecutor(catalog, mockTempManager());

    const plan = {
      type: PlanNodeType.EXCHANGE,
      exchangeType: 'gather',
      partitionKeys: [],
      partitionCount: 0,
      children: [scanNode('T', ['X'])],
    };

    const compiled = await executor.buildLogicalPipeline(plan);
    expect(compiled.schema[0].name).toBe('X');
    expect(compiled.schema[0].dataType).toBe('INT32');
  });

  it('preserves columnMapping through exchange', async () => {
    const schema = [
      { name: 'A', dataType: 'INT32' },
      { name: 'B', dataType: 'VARCHAR' },
    ];
    const chunk = makeChunk([
      { type: 'INT32', values: [1] },
      { type: 'VARCHAR', values: ['hello'] },
    ]);
    const storage = mockStorage([chunk], schema);
    const catalog = mockCatalog({ TBL: storage });
    const executor = new QueryExecutor(catalog, mockTempManager());

    const plan = {
      type: PlanNodeType.EXCHANGE,
      exchangeType: 'broadcast',
      partitionKeys: [],
      partitionCount: 0,
      children: [scanNode('TBL', ['A', 'B'])],
    };

    const compiled = await executor.buildLogicalPipeline(plan);
    expect(compiled.columnMapping.get('A')).toBe(0);
    expect(compiled.columnMapping.get('B')).toBe(1);
  });
});

describe('buildPartialAggregate', () => {
  it('computes partial SUM correctly', async () => {
    const schema = [
      { name: 'GRP', dataType: 'VARCHAR' },
      { name: 'VAL', dataType: 'FLOAT64' },
    ];
    const chunk = makeChunk([
      { type: 'VARCHAR', values: ['a', 'b', 'a', 'b', 'a'] },
      { type: 'FLOAT64', values: [10, 20, 30, 40, 50] },
    ]);
    const storage = mockStorage([chunk], schema);
    const catalog = mockCatalog({ DATA: storage });
    const executor = new QueryExecutor(catalog, mockTempManager());

    const plan = {
      type: PlanNodeType.PARTIAL_AGGREGATE,
      groupBy: [colRef('DATA', 'GRP', 0, 'VARCHAR')],
      aggregates: [aggExpr('SUM', [colRef('DATA', 'VAL', 1, 'FLOAT64')])],
      children: [scanNode('DATA', ['GRP', 'VAL'])],
    };

    const rows = await collectRows(executor, plan, ['grp', 'sum']);
    const sorted = rows.sort((a, b) => a.grp < b.grp ? -1 : 1);
    expect(sorted).toEqual([
      { grp: 'a', sum: 90 },
      { grp: 'b', sum: 60 },
    ]);
  });

  it('computes partial COUNT correctly', async () => {
    const schema = [
      { name: 'GRP', dataType: 'VARCHAR' },
      { name: 'VAL', dataType: 'INT32' },
    ];
    const chunk = makeChunk([
      { type: 'VARCHAR', values: ['x', 'y', 'x', 'x'] },
      { type: 'INT32', values: [1, 2, 3, 4] },
    ]);
    const storage = mockStorage([chunk], schema);
    const catalog = mockCatalog({ TBL: storage });
    const executor = new QueryExecutor(catalog, mockTempManager());

    const plan = {
      type: PlanNodeType.PARTIAL_AGGREGATE,
      groupBy: [colRef('TBL', 'GRP', 0, 'VARCHAR')],
      aggregates: [aggExpr('COUNT', [colRef('TBL', 'VAL', 1, 'INT32')])],
      children: [scanNode('TBL', ['GRP', 'VAL'])],
    };

    const rows = await collectRows(executor, plan, ['grp', 'count']);
    const sorted = rows.sort((a, b) => a.grp < b.grp ? -1 : 1);
    expect(sorted).toEqual([
      { grp: 'x', count: 3 },
      { grp: 'y', count: 1 },
    ]);
  });

  it('handles ungrouped partial aggregate', async () => {
    const schema = [{ name: 'VAL', dataType: 'FLOAT64' }];
    const chunk = makeChunk([{ type: 'FLOAT64', values: [5, 15, 25] }]);
    const storage = mockStorage([chunk], schema);
    const catalog = mockCatalog({ S: storage });
    const executor = new QueryExecutor(catalog, mockTempManager());

    const plan = {
      type: PlanNodeType.PARTIAL_AGGREGATE,
      groupBy: [],
      aggregates: [aggExpr('SUM', [colRef('S', 'VAL', 0, 'FLOAT64')])],
      children: [scanNode('S', ['VAL'])],
    };

    const rows = await collectRows(executor, plan, ['sum']);
    expect(rows).toEqual([{ sum: 45 }]);
  });
});

describe('buildFinalAggregate', () => {
  it('merges partial SUM results', async () => {
    const schema = [
      { name: 'GRP', dataType: 'VARCHAR' },
      { name: 'SUM', dataType: 'FLOAT64' },
    ];
    const chunk1 = makeChunk([
      { type: 'VARCHAR', values: ['a', 'b'] },
      { type: 'FLOAT64', values: [30, 20] },
    ]);
    const chunk2 = makeChunk([
      { type: 'VARCHAR', values: ['a', 'b'] },
      { type: 'FLOAT64', values: [60, 40] },
    ]);
    const storage = mockStorage([chunk1, chunk2], schema);
    const catalog = mockCatalog({ PARTIALS: storage });
    const executor = new QueryExecutor(catalog, mockTempManager());

    const plan = {
      type: PlanNodeType.FINAL_AGGREGATE,
      groupBy: [colRef('PARTIALS', 'GRP', 0, 'VARCHAR')],
      aggregates: [{
        ...aggExpr('SUM', [colRef('PARTIALS', 'SUM', 1, 'FLOAT64')]),
        func: 'SUM',
        _originalIndex: 0,
      }],
      partialAggregates: [{ func: 'SUM' }],
      children: [scanNode('PARTIALS', ['GRP', 'SUM'])],
    };

    const rows = await collectRows(executor, plan, ['grp', 'sum']);
    const sorted = rows.sort((a, b) => a.grp < b.grp ? -1 : 1);
    expect(sorted).toEqual([
      { grp: 'a', sum: 90 },
      { grp: 'b', sum: 60 },
    ]);
  });

  it('merges partial COUNT via SUM', async () => {
    const schema = [
      { name: 'GRP', dataType: 'VARCHAR' },
      { name: 'COUNT', dataType: 'FLOAT64' },
    ];
    const chunk1 = makeChunk([
      { type: 'VARCHAR', values: ['x'] },
      { type: 'FLOAT64', values: [5] },
    ]);
    const chunk2 = makeChunk([
      { type: 'VARCHAR', values: ['x'] },
      { type: 'FLOAT64', values: [3] },
    ]);
    const storage = mockStorage([chunk1, chunk2], schema);
    const catalog = mockCatalog({ PARTIALS: storage });
    const executor = new QueryExecutor(catalog, mockTempManager());

    const plan = {
      type: PlanNodeType.FINAL_AGGREGATE,
      groupBy: [colRef('PARTIALS', 'GRP', 0, 'VARCHAR')],
      aggregates: [{
        ...aggExpr('SUM', [colRef('PARTIALS', 'COUNT', 1, 'FLOAT64')]),
        func: 'SUM',
        _originalIndex: 0,
      }],
      partialAggregates: [{ func: 'COUNT' }],
      children: [scanNode('PARTIALS', ['GRP', 'COUNT'])],
    };

    const rows = await collectRows(executor, plan, ['grp', 'sum']);
    expect(rows).toEqual([{ grp: 'x', sum: 8 }]);
  });

  it('handles ungrouped final aggregate', async () => {
    const schema = [{ name: 'SUM', dataType: 'FLOAT64' }];
    const chunk1 = makeChunk([{ type: 'FLOAT64', values: [100] }]);
    const chunk2 = makeChunk([{ type: 'FLOAT64', values: [200] }]);
    const storage = mockStorage([chunk1, chunk2], schema);
    const catalog = mockCatalog({ P: storage });
    const executor = new QueryExecutor(catalog, mockTempManager());

    const plan = {
      type: PlanNodeType.FINAL_AGGREGATE,
      groupBy: [],
      aggregates: [{
        ...aggExpr('SUM', [colRef('P', 'SUM', 0, 'FLOAT64')]),
        func: 'SUM',
        _originalIndex: 0,
      }],
      partialAggregates: [{ func: 'SUM' }],
      children: [scanNode('P', ['SUM'])],
    };

    const rows = await collectRows(executor, plan, ['sum']);
    expect(rows).toEqual([{ sum: 300 }]);
  });
});

describe('buildMergeExchange', () => {
  it('passes data through in local mode (no distributed context)', async () => {
    const schema = [{ name: 'ID', dataType: 'INT32' }];
    const chunk = makeChunk([{ type: 'INT32', values: [3, 1, 2] }]);
    const storage = mockStorage([chunk], schema);
    const catalog = mockCatalog({ T: storage });
    const executor = new QueryExecutor(catalog, mockTempManager());

    const plan = {
      type: PlanNodeType.MERGE_EXCHANGE,
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      limit: null,
      children: [scanNode('T', ['ID'])],
    };

    const rows = await collectRows(executor, plan, ['ID']);
    expect(rows).toEqual([
      { ID: 3 },
      { ID: 1 },
      { ID: 2 },
    ]);
  });

  it('preserves schema from child', async () => {
    const schema = [
      { name: 'A', dataType: 'INT32' },
      { name: 'B', dataType: 'VARCHAR' },
    ];
    const chunk = makeChunk([
      { type: 'INT32', values: [1] },
      { type: 'VARCHAR', values: ['x'] },
    ]);
    const storage = mockStorage([chunk], schema);
    const catalog = mockCatalog({ T: storage });
    const executor = new QueryExecutor(catalog, mockTempManager());

    const plan = {
      type: PlanNodeType.MERGE_EXCHANGE,
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      limit: null,
      children: [scanNode('T', ['A', 'B'])],
    };

    const compiled = await executor.buildLogicalPipeline(plan);
    expect(compiled.schema.length).toBe(2);
    expect(compiled.schema[0].name).toBe('A');
    expect(compiled.schema[1].name).toBe('B');
  });
});

describe('two-phase aggregate end-to-end', () => {
  it('PARTIAL_AGGREGATE -> EXCHANGE -> FINAL_AGGREGATE produces correct results in local mode', async () => {
    const schema = [
      { name: 'CATEGORY', dataType: 'VARCHAR' },
      { name: 'AMOUNT', dataType: 'FLOAT64' },
    ];
    const chunk = makeChunk([
      { type: 'VARCHAR', values: ['food', 'drink', 'food', 'drink', 'food'] },
      { type: 'FLOAT64', values: [10, 20, 30, 40, 50] },
    ]);
    const storage = mockStorage([chunk], schema);
    const catalog = mockCatalog({ SALES: storage });
    const executor = new QueryExecutor(catalog, mockTempManager());

    const groupByExpr = colRef('SALES', 'CATEGORY', 0, 'VARCHAR');
    const amountExpr = colRef('SALES', 'AMOUNT', 1, 'FLOAT64');

    const partialPlan = {
      type: PlanNodeType.PARTIAL_AGGREGATE,
      groupBy: [groupByExpr],
      aggregates: [aggExpr('SUM', [amountExpr])],
      children: [scanNode('SALES', ['CATEGORY', 'AMOUNT'])],
    };

    const exchangePlan = {
      type: PlanNodeType.EXCHANGE,
      exchangeType: 'hash_shuffle',
      partitionKeys: [groupByExpr],
      partitionCount: 2,
      children: [partialPlan],
    };

    const finalPlan = {
      type: PlanNodeType.FINAL_AGGREGATE,
      groupBy: [colRef('', 'CATEGORY', 0, 'VARCHAR')],
      aggregates: [{
        ...aggExpr('SUM', [colRef('', 'SUM', 1, 'FLOAT64')]),
        func: 'SUM',
        _originalIndex: 0,
      }],
      partialAggregates: [{ func: 'SUM' }],
      children: [exchangePlan],
    };

    const rows = await collectRows(executor, finalPlan, ['category', 'sum']);
    const sorted = rows.sort((a, b) => a.category < b.category ? -1 : 1);
    expect(sorted).toEqual([
      { category: 'drink', sum: 60 },
      { category: 'food', sum: 90 },
    ]);
  });

  it('handles MIN and MAX partial aggregates', async () => {
    const schema = [
      { name: 'GRP', dataType: 'VARCHAR' },
      { name: 'VAL', dataType: 'FLOAT64' },
    ];
    const chunk = makeChunk([
      { type: 'VARCHAR', values: ['a', 'a', 'b', 'b'] },
      { type: 'FLOAT64', values: [5, 15, 3, 20] },
    ]);
    const storage = mockStorage([chunk], schema);
    const catalog = mockCatalog({ T: storage });
    const executor = new QueryExecutor(catalog, mockTempManager());

    const plan = {
      type: PlanNodeType.PARTIAL_AGGREGATE,
      groupBy: [colRef('T', 'GRP', 0, 'VARCHAR')],
      aggregates: [
        aggExpr('MIN', [colRef('T', 'VAL', 1, 'FLOAT64')]),
        aggExpr('MAX', [colRef('T', 'VAL', 1, 'FLOAT64')]),
      ],
      children: [scanNode('T', ['GRP', 'VAL'])],
    };

    const rows = await collectRows(executor, plan, ['grp', 'min', 'max']);
    const sorted = rows.sort((a, b) => a.grp < b.grp ? -1 : 1);
    expect(sorted).toEqual([
      { grp: 'a', min: 5, max: 15 },
      { grp: 'b', min: 3, max: 20 },
    ]);
  });
});

describe('setDistributedContext', () => {
  it('stores distributed context on executor', () => {
    const catalog = mockCatalog({});
    const executor = new QueryExecutor(catalog, mockTempManager());
    const ctx = { role: 'receiver', transport: {} };
    executor.setDistributedContext(ctx);
    expect(executor._distributedContext).toBe(ctx);
  });
});
