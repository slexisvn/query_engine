import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  HashAggregateOperator,
  SumAccumulator,
  CountAccumulator,
  CountStarAccumulator,
  AvgAccumulator,
  MinAccumulator,
  MaxAccumulator,
  DistinctAccumulator,
  AvgFinalAccumulator,
  getAccumulatorFactory,
  hashGroupKey,
} from '../../../src/execution/operators/hash-aggregate.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { DataType } from '../../../src/storage/data-type.js';
import { SpillManager } from '../../../src/storage/spill-manager/spill-manager.js';
import { MemoryStorage } from '../../../src/storage/spill-manager/memory-storage.js';
import { captureMemoryLimit, limitResidentRows } from '../../helpers/memory-limits.js';

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

function aggDef(name, extractIdx, resultType = 'FLOAT64') {
  const factory = getAccumulatorFactory(name);
  return {
    name,
    resultType,
    extractValue: (chunk, row) => chunk.columns[extractIdx].get(row),
    createAccumulator: factory,
  };
}

function countStarDef() {
  return {
    name: 'COUNT_STAR',
    resultType: 'INT32',
    extractValue: () => 1,
    createAccumulator: getAccumulatorFactory('COUNT_STAR'),
  };
}

describe('Accumulators', () => {
  describe('SumAccumulator', () => {
    it('sums numeric values', () => {
      const acc = new SumAccumulator();
      acc.add(10); acc.add(20); acc.add(30);
      expect(acc.result()).toBe(60);
    });

    it('returns null when no values added', () => {
      const acc = new SumAccumulator();
      expect(acc.result()).toBeNull();
    });

    it('skips null values', () => {
      const acc = new SumAccumulator();
      acc.add(10); acc.add(null); acc.add(20);
      expect(acc.result()).toBe(30);
    });
  });

  describe('CountAccumulator', () => {
    it('counts non-null values', () => {
      const acc = new CountAccumulator();
      acc.add(1); acc.add(null); acc.add(3);
      expect(acc.result()).toBe(2);
    });

    it('returns 0 when no values added', () => {
      const acc = new CountAccumulator();
      expect(acc.result()).toBe(0);
    });
  });

  describe('CountStarAccumulator', () => {
    it('counts all calls including nulls', () => {
      const acc = new CountStarAccumulator();
      acc.add(1); acc.add(null); acc.add(undefined);
      expect(acc.result()).toBe(3);
    });
  });

  describe('AvgAccumulator', () => {
    it('computes average of numeric values', () => {
      const acc = new AvgAccumulator();
      acc.add(10); acc.add(20); acc.add(30);
      expect(acc.result()).toBe(20);
    });

    it('returns null when no values', () => {
      const acc = new AvgAccumulator();
      expect(acc.result()).toBeNull();
    });

    it('skips nulls in average', () => {
      const acc = new AvgAccumulator();
      acc.add(10); acc.add(null); acc.add(30);
      expect(acc.result()).toBe(20);
    });
  });

  describe('MinAccumulator', () => {
    it('finds minimum value', () => {
      const acc = new MinAccumulator();
      acc.add(30); acc.add(10); acc.add(20);
      expect(acc.result()).toBe(10);
    });

    it('returns null when no values', () => {
      const acc = new MinAccumulator();
      expect(acc.result()).toBeNull();
    });

    it('skips nulls', () => {
      const acc = new MinAccumulator();
      acc.add(null); acc.add(5); acc.add(null);
      expect(acc.result()).toBe(5);
    });
  });

  describe('MaxAccumulator', () => {
    it('finds maximum value', () => {
      const acc = new MaxAccumulator();
      acc.add(10); acc.add(30); acc.add(20);
      expect(acc.result()).toBe(30);
    });

    it('returns null when no values', () => {
      const acc = new MaxAccumulator();
      expect(acc.result()).toBeNull();
    });
  });

  describe('DistinctAccumulator', () => {
    it('counts distinct non-null values', () => {
      const acc = new DistinctAccumulator(() => new CountAccumulator());
      acc.add(1); acc.add(2); acc.add(1); acc.add(3); acc.add(2);
      expect(acc.result()).toBe(3);
    });

    it('ignores nulls', () => {
      const acc = new DistinctAccumulator(() => new CountAccumulator());
      acc.add(1); acc.add(null); acc.add(1);
      expect(acc.result()).toBe(1);
    });

    it('sums each distinct value once', () => {
      const acc = getAccumulatorFactory('SUM', true)();
      acc.add(3); acc.add(3); acc.add(4);
      expect(acc.result()).toBe(7);
    });

    it('averages over distinct values only', () => {
      const acc = getAccumulatorFactory('AVG', true)();
      acc.add(1); acc.add(1); acc.add(1); acc.add(5);
      expect(acc.result()).toBe(3);
    });
  });

  describe('getAccumulatorFactory', () => {
    it('returns a DistinctAccumulator for COUNT with distinct flag', () => {
      expect(getAccumulatorFactory('COUNT', true)()).toBeInstanceOf(DistinctAccumulator);
    });

    it('returns a DistinctAccumulator for SUM and AVG with distinct flag', () => {
      expect(getAccumulatorFactory('SUM', true)()).toBeInstanceOf(DistinctAccumulator);
      expect(getAccumulatorFactory('AVG', true)()).toBeInstanceOf(DistinctAccumulator);
    });

    it('ignores the distinct flag for MIN and MAX', () => {
      expect(getAccumulatorFactory('MIN', true)()).not.toBeInstanceOf(DistinctAccumulator);
      expect(getAccumulatorFactory('MAX', true)()).not.toBeInstanceOf(DistinctAccumulator);
    });

    it('throws for unknown aggregate', () => {
      expect(() => getAccumulatorFactory('UNKNOWN')).toThrow('Unknown aggregate');
    });
  });
});

describe('HashAggregateOperator', () => {
  describe('ungrouped aggregation', () => {
    it('computes SUM across all rows', async () => {
      const op = new HashAggregateOperator([], [], [aggDef('SUM', 0)]);
      await op.consume(makeChunk([{ type: 'FLOAT64', values: [10, 20, 30] }]));

      const result = await op.finalize();

      expect(result.length).toBe(1);
      expect(result[0].size).toBe(1);
      expect(result[0].getValue(0, 0)).toBe(60);
    });

    it('computes COUNT across all rows', async () => {
      const op = new HashAggregateOperator([], [], [aggDef('COUNT', 0, 'INT32')]);
      await op.consume(makeChunk([{ type: 'INT32', values: [1, null, 3] }]));

      const result = await op.finalize();

      expect(result[0].getValue(0, 0)).toBe(2);
    });

    it('returns default accumulator result when no input', async () => {
      const op = new HashAggregateOperator([], [], [countStarDef()]);

      const result = await op.finalize();

      expect(result[0].size).toBe(1);
      expect(result[0].getValue(0, 0)).toBe(0);
    });

    it('handles multiple aggregates at once', async () => {
      const op = new HashAggregateOperator([], [], [
        aggDef('SUM', 0),
        aggDef('MIN', 0),
        aggDef('MAX', 0),
      ]);
      await op.consume(makeChunk([{ type: 'FLOAT64', values: [5, 15, 10] }]));

      const result = await op.finalize();

      expect(result[0].getValue(0, 0)).toBe(30);
      expect(result[0].getValue(0, 1)).toBe(5);
      expect(result[0].getValue(0, 2)).toBe(15);
    });
  });

  describe('grouped aggregation', () => {
    it('groups by single column and aggregates', async () => {
      const op = new HashAggregateOperator(
        [(chunk, row) => chunk.columns[0].get(row)],
        ['VARCHAR'],
        [aggDef('SUM', 1)]
      );
      await op.consume(makeChunk([
        { type: 'VARCHAR', values: ['a', 'b', 'a', 'b', 'a'] },
        { type: 'FLOAT64', values: [10, 20, 30, 40, 50] },
      ]));

      const result = await op.finalize();

      expect(result[0].size).toBe(2);
      const rows = result[0].toRows();
      const map = new Map(rows.map(r => [r[0], r[1]]));
      expect(map.get('a')).toBe(90);
      expect(map.get('b')).toBe(60);
    });

    it('keeps multi-column groups apart when a key value contains a separator character', async () => {
      const op = new HashAggregateOperator(
        [
          (chunk, row) => chunk.columns[0].get(row),
          (chunk, row) => chunk.columns[1].get(row),
        ],
        ['VARCHAR', 'VARCHAR'],
        [aggDef('SUM', 2)]
      );
      await op.consume(makeChunk([
        { type: 'VARCHAR', values: ['a|b', 'a'] },
        { type: 'VARCHAR', values: ['c', 'b|c'] },
        { type: 'FLOAT64', values: [1, 10] },
      ]));

      const rows = (await op.finalize())[0].toRows();

      expect(rows.length).toBe(2);
      expect(rows.map(r => r[2]).sort((x, y) => x - y)).toEqual([1, 10]);
    });

    it('keeps a null group key apart from the text that spells it', async () => {
      const op = new HashAggregateOperator(
        [
          (chunk, row) => chunk.columns[0].get(row),
          (chunk, row) => chunk.columns[1].get(row),
        ],
        ['VARCHAR', 'VARCHAR'],
        [aggDef('SUM', 2)]
      );
      await op.consume(makeChunk([
        { type: 'VARCHAR', values: [null, 'null'] },
        { type: 'VARCHAR', values: ['x', 'x'] },
        { type: 'FLOAT64', values: [1, 10] },
      ]));

      const rows = (await op.finalize())[0].toRows();

      expect(rows.length).toBe(2);
      expect(rows.map(r => r[2]).sort((x, y) => x - y)).toEqual([1, 10]);
    });

    it('groups by multiple columns', async () => {
      const op = new HashAggregateOperator(
        [
          (chunk, row) => chunk.columns[0].get(row),
          (chunk, row) => chunk.columns[1].get(row),
        ],
        ['VARCHAR', 'INT32'],
        [countStarDef()]
      );
      await op.consume(makeChunk([
        { type: 'VARCHAR', values: ['a', 'a', 'b', 'a'] },
        { type: 'INT32', values: [1, 2, 1, 1] },
        { type: 'FLOAT64', values: [0, 0, 0, 0] },
      ]));

      const result = await op.finalize();

      expect(result[0].size).toBe(3);
      const rows = result[0].toRows();
      const map = new Map(rows.map(r => [`${r[0]}|${r[1]}`, r[2]]));
      expect(map.get('a|1')).toBe(2);
      expect(map.get('a|2')).toBe(1);
      expect(map.get('b|1')).toBe(1);
    });

    it('returns empty when no input and has group-by', async () => {
      const op = new HashAggregateOperator(
        [(chunk, row) => chunk.columns[0].get(row)],
        ['INT32'],
        [countStarDef()]
      );

      const result = await op.finalize();

      expect(result).toEqual([]);
    });
  });

  describe('multi-chunk consumption', () => {
    it('accumulates across multiple consume calls', async () => {
      const op = new HashAggregateOperator([], [], [aggDef('SUM', 0)]);
      await op.consume(makeChunk([{ type: 'FLOAT64', values: [10, 20] }]));
      await op.consume(makeChunk([{ type: 'FLOAT64', values: [30, 40] }]));

      const result = await op.finalize();

      expect(result[0].getValue(0, 0)).toBe(100);
    });

    it('merges groups across chunks', async () => {
      const op = new HashAggregateOperator(
        [(chunk, row) => chunk.columns[0].get(row)],
        ['VARCHAR'],
        [aggDef('SUM', 1)]
      );
      await op.consume(makeChunk([
        { type: 'VARCHAR', values: ['a', 'b'] },
        { type: 'FLOAT64', values: [10, 20] },
      ]));
      await op.consume(makeChunk([
        { type: 'VARCHAR', values: ['a', 'c'] },
        { type: 'FLOAT64', values: [30, 40] },
      ]));

      const result = await op.finalize();

      const rows = result[0].toRows();
      const map = new Map(rows.map(r => [r[0], r[1]]));
      expect(map.get('a')).toBe(40);
      expect(map.get('b')).toBe(20);
      expect(map.get('c')).toBe(40);
    });
  });

  describe('selection vector input', () => {
    it('respects selection vector when consuming', async () => {
      const op = new HashAggregateOperator([], [], [aggDef('SUM', 0)]);
      const col = new Column('FLOAT64', 5);
      [10, 20, 30, 40, 50].forEach((v, i) => col.set(i, v));
      col.length = 5;
      const chunk = new DataChunk([col], 3);
      chunk.setSelectionVector(new Uint32Array([0, 2, 4]), 3);
      await op.consume(chunk);

      const result = await op.finalize();

      expect(result[0].getValue(0, 0)).toBe(90);
    });
  });

  describe('AVG aggregation', () => {
    it('computes correct average', async () => {
      const op = new HashAggregateOperator([], [], [aggDef('AVG', 0)]);
      await op.consume(makeChunk([{ type: 'FLOAT64', values: [10, 20, 30] }]));

      const result = await op.finalize();

      expect(result[0].getValue(0, 0)).toBe(20);
    });
  });
});

describe('partial export/absorb (parallel combine contract)', () => {
  const groupEval = (chunk, row) => chunk.columns[0].get(row);

  function makeOp(defs) {
    return new HashAggregateOperator([groupEval], ['VARCHAR'], defs);
  }

  function defs() {
    return [
      aggDef('SUM', 1),
      aggDef('AVG', 1),
      aggDef('MIN', 1),
      aggDef('MAX', 1),
      aggDef('COUNT', 1),
      countStarDef(),
    ];
  }

  async function finalizeRows(op) {
    const chunks = await op.finalize();
    const rows = [];
    for (const chunk of chunks) for (const row of chunk.toRows()) rows.push(row);
    return rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }

  it('absorbing partials from split consumers equals one consumer over all rows', async () => {
    const rows = [];
    for (let i = 0; i < 90; i++) rows.push([`g${i % 7}`, i % 9 === 0 ? null : i]);
    const chunkOf = (slice) => makeChunk([
      { type: 'VARCHAR', values: slice.map(r => r[0]) },
      { type: 'FLOAT64', values: slice.map(r => r[1]) },
    ]);

    const whole = makeOp(defs());
    await whole.consume(chunkOf(rows));

    const final = makeOp(defs());
    for (const slice of [rows.slice(0, 30), rows.slice(30, 60), rows.slice(60)]) {
      const part = makeOp(defs());
      await part.consume(chunkOf(slice));
      for (const partition of part.exportPartials(8)) {
        final.absorbPartials(partition);
      }
    }

    expect(await finalizeRows(final)).toEqual(await finalizeRows(whole));
  });

  it('AVG merges sum and count, not averages of averages', () => {
    const a = new AvgAccumulator();
    a.add(1); a.add(2);
    const b = new AvgAccumulator();
    b.add(3);
    const merged = new AvgAccumulator();
    merged.mergeState(a.exportState());
    merged.mergeState(b.exportState());
    expect(merged.result()).toBe(2);
  });

  it('MIN/MAX merge ignores empty partials and keeps null seed semantics', () => {
    const min = new MinAccumulator();
    min.mergeState(new MinAccumulator().exportState());
    expect(min.result()).toBeNull();
    min.mergeState(-5);
    min.mergeState(3);
    expect(min.result()).toBe(-5);

    const max = new MaxAccumulator();
    max.mergeState(null);
    max.mergeState(-7);
    max.mergeState(-9);
    expect(max.result()).toBe(-7);
  });

  it('SUM merge over all-null partials stays null', () => {
    const sum = new SumAccumulator();
    sum.mergeState(null);
    sum.mergeState(null);
    expect(sum.result()).toBeNull();
    sum.mergeState(4);
    expect(sum.result()).toBe(4);
  });

  it('COUNT DISTINCT merge unions values across partials', () => {
    const makeAcc = getAccumulatorFactory('COUNT', true);
    const a = makeAcc();
    a.add(1); a.add(2);
    const b = makeAcc();
    b.add(2); b.add(3);
    const merged = makeAcc();
    merged.mergeState(a.exportState());
    merged.mergeState(b.exportState());
    expect(merged.result()).toBe(3);
  });

  it('SUM DISTINCT merge unions values across partials', () => {
    const makeAcc = getAccumulatorFactory('SUM', true);
    const a = makeAcc();
    a.add(1); a.add(2);
    const b = makeAcc();
    b.add(2); b.add(3);
    const merged = makeAcc();
    merged.mergeState(a.exportState());
    merged.mergeState(b.exportState());
    expect(merged.result()).toBe(6);
  });

  it('routes the same key to the same radix partition across instances', async () => {
    const ops = [makeOp([countStarDef()]), makeOp([countStarDef()])];
    for (const op of ops) {
      await op.consume(makeChunk([
        { type: 'VARCHAR', values: ['x', 'y', 'z'] },
        { type: 'FLOAT64', values: [1, 2, 3] },
      ]));
    }
    const partitionOf = (partitions, key) =>
      partitions.findIndex(part => part.some(p => p.key === key));
    const [pa, pb] = ops.map(op => op.exportPartials(16));
    for (const key of ['x', 'y', 'z']) {
      expect(partitionOf(pa, key)).toBe(partitionOf(pb, key));
      expect(partitionOf(pa, key)).toBeGreaterThanOrEqual(0);
    }
  });

  it('hashGroupKey is type-aware and stable for numbers, strings, bigints and null', () => {
    expect(hashGroupKey(null)).toBe(0);
    expect(hashGroupKey(42)).toBe(hashGroupKey(42));
    expect(hashGroupKey('42')).toBe(hashGroupKey('42'));
    expect(hashGroupKey(42n)).toBe(hashGroupKey(42n));
    expect(hashGroupKey(-0)).toBe(hashGroupKey(-0));
    expect(typeof hashGroupKey('xin chào')).toBe('number');
  });

  it('single-key groups use raw values: null group does not collide with the string "null"', async () => {
    const op = makeOp([countStarDef()]);
    await op.consume(makeChunk([
      { type: 'VARCHAR', values: ['null', null, 'null', null, null] },
      { type: 'FLOAT64', values: [1, 2, 3, 4, 5] },
    ]));
    const rows = (await op.finalize()).flatMap(c => c.toRows());
    const byKey = new Map(rows.map(r => [r[0], r[1]]));
    expect(byKey.get('null')).toBe(2);
    expect(byKey.get(null)).toBe(3);
    expect(rows.length).toBe(2);
  });
});

describe('AvgFinalAccumulator (distributed AVG combine)', () => {
  it('combines (sum,count) partials into a weighted average, not average-of-averages', () => {
    const acc = new AvgFinalAccumulator();
    // three workers with uneven partition sizes: sums 1650/1620/1631 over counts 67/67/66
    acc.add([1650, 67]);
    acc.add([1620, 67]);
    acc.add([1631, 66]);
    expect(acc.result()).toBeCloseTo((1650 + 1620 + 1631) / (67 + 67 + 66), 9);
    // average-of-averages would be ((1650/67)+(1620/67)+(1631/66))/3 — different value
    const avgOfAvg = (1650 / 67 + 1620 / 67 + 1631 / 66) / 3;
    expect(acc.result()).not.toBeCloseTo(avgOfAvg, 4);
  });

  it('returns null when total count is zero (all-null partitions)', () => {
    const acc = new AvgFinalAccumulator();
    acc.add([null, 0]);
    acc.add([null, 0]);
    expect(acc.result()).toBeNull();
  });

  it('factory maps AVG_FINAL to the sum/count combiner', () => {
    const acc = getAccumulatorFactory('AVG_FINAL')();
    expect(acc).toBeInstanceOf(AvgFinalAccumulator);
    acc.add([10, 2]);
    acc.add([20, 3]);
    expect(acc.result()).toBeCloseTo(30 / 5, 9);
  });
});

describe('HashAggregateOperator spill path', () => {
  const GROUP_SCHEMA = [DataType.INT32, DataType.FLOAT64];
  let restoreMemoryLimit;

  beforeEach(() => { restoreMemoryLimit = captureMemoryLimit(); });
  afterEach(() => { restoreMemoryLimit(); });

  function memSpill() {
    return new SpillManager(new MemoryStorage());
  }

  function groupedOperator(spill) {
    return new HashAggregateOperator(
      [(chunk, row) => chunk.columns[0].get(row)],
      [DataType.INT32],
      [aggDef('SUM', 1), countStarDef()],
      spill,
    );
  }

  async function feed(op, groupCount, repeats) {
    for (let r = 0; r < repeats; r++) {
      const keys = [];
      const values = [];
      for (let g = 0; g < groupCount; g++) { keys.push(g); values.push(g + r); }
      await op.consume(makeChunk([
        { type: 'INT32', values: keys },
        { type: 'FLOAT64', values },
      ]));
    }
  }

  function resultRows(chunks) {
    const rows = [];
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.size; i++) {
        rows.push([chunk.getValue(i, 0), chunk.getValue(i, 1), chunk.getValue(i, 2)]);
      }
    }
    return rows.sort((a, b) => a[0] - b[0]);
  }

  it('spills once the group budget is exceeded', async () => {
    limitResidentRows(GROUP_SCHEMA, 4);
    const op = groupedOperator(memSpill());

    await feed(op, 40, 1);

    expect(op.spilledPartitions.size).toBeGreaterThan(0);
  });

  it('does not spill when everything fits in the budget', async () => {
    const op = groupedOperator(memSpill());

    await feed(op, 5, 2);

    expect(op.spilledPartitions.size).toBe(0);
  });

  it('never spills when no spill store is injected', async () => {
    limitResidentRows(GROUP_SCHEMA, 2);
    const op = groupedOperator(null);

    await feed(op, 40, 1);

    expect(op.spilledPartitions.size).toBe(0);
    expect(op.groups.size).toBe(40);
  });

  it('produces the same groups spilled as in memory', async () => {
    const inMemory = groupedOperator(memSpill());
    await feed(inMemory, 60, 4);
    const expected = resultRows(await inMemory.finalize());

    limitResidentRows(GROUP_SCHEMA, 4);
    const spilled = groupedOperator(memSpill());
    await feed(spilled, 60, 4);
    const actual = resultRows(await spilled.finalize());

    expect(actual).toEqual(expected);
  });

  it('merges partial states for a group split across several spills', async () => {
    limitResidentRows(GROUP_SCHEMA, 4);
    const op = groupedOperator(memSpill());

    await feed(op, 30, 6);
    const rows = resultRows(await op.finalize());

    expect(rows).toHaveLength(30);
    for (const [key, sum, count] of rows) {
      expect(count).toBe(6);
      expect(sum).toBe(key * 6 + (0 + 1 + 2 + 3 + 4 + 5));
    }
  });

  it('keeps every distinct group after spilling', async () => {
    limitResidentRows(GROUP_SCHEMA, 3);
    const op = groupedOperator(memSpill());

    await feed(op, 100, 3);
    const rows = resultRows(await op.finalize());

    expect(rows.map(r => r[0])).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('bounds resident groups while consuming far more than the budget', async () => {
    limitResidentRows(GROUP_SCHEMA, 5);
    const op = groupedOperator(memSpill());
    let peak = 0;

    for (let r = 0; r < 20; r++) {
      await op.consume(makeChunk([
        { type: 'INT32', values: Array.from({ length: 10 }, (_, i) => r * 10 + i) },
        { type: 'FLOAT64', values: Array.from({ length: 10 }, () => 1) },
      ]));
      peak = Math.max(peak, op.groups.size);
    }

    expect(peak).toBeLessThanOrEqual(15);
    expect((await op.finalize()).reduce((sum, c) => sum + c.size, 0)).toBe(200);
  });

  it('clears the spill store once finalized', async () => {
    limitResidentRows(GROUP_SCHEMA, 3);
    const spill = memSpill();
    const op = groupedOperator(spill);

    await feed(op, 40, 2);
    await op.finalize();

    for (let p = 0; p < op.spillPartitionCount; p++) {
      expect(spill.hasSpilled(op.partitionHandle(p))).toBe(false);
    }
  });

  it('handles a spilled aggregate whose group keys are strings', async () => {
    limitResidentRows(GROUP_SCHEMA, 3);
    const op = new HashAggregateOperator(
      [(chunk, row) => chunk.columns[0].get(row)],
      [DataType.VARCHAR],
      [countStarDef()],
      memSpill(),
    );

    for (let r = 0; r < 5; r++) {
      await op.consume(makeChunk([{ type: 'VARCHAR', values: Array.from({ length: 20 }, (_, i) => `g${i}`) }]));
    }

    const chunks = await op.finalize();
    expect(chunks.reduce((sum, c) => sum + c.size, 0)).toBe(20);
  });

  it('handles a spilled aggregate with a null group key', async () => {
    limitResidentRows(GROUP_SCHEMA, 2);
    const op = groupedOperator(memSpill());

    for (let r = 0; r < 4; r++) {
      await op.consume(makeChunk([
        { type: 'INT32', values: [null, 1, 2, 3, 4, 5, 6, 7] },
        { type: 'FLOAT64', values: [1, 1, 1, 1, 1, 1, 1, 1] },
      ]));
    }

    const rows = await op.finalize();
    const total = rows.reduce((sum, c) => sum + c.size, 0);
    expect(total).toBe(8);
  });
});
