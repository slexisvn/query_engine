import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SortOperator, LimitOperator, nullsFirstFor } from '../../../src/execution/operators/sort.js';
import { SpillManager } from '../../../src/storage/spill-manager/spill-manager.js';
import { MemoryStorage } from '../../../src/storage/spill-manager/memory-storage.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { Config } from '../../../src/config.js';
import { captureMemoryLimit, limitResidentRows } from '../../helpers/memory-limits.js';
import { DataType } from '../../../src/storage/data-type.js';

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

function memSpill() {
  return new SpillManager(new MemoryStorage());
}

function ascKey(colIdx) {
  return { eval: (chunk, row) => chunk.columns[colIdx].get(row), direction: 'ASC' };
}

function descKey(colIdx) {
  return { eval: (chunk, row) => chunk.columns[colIdx].get(row), direction: 'DESC' };
}

function allRows(chunks) {
  return chunks.flatMap(c => c.toRows());
}

async function sorted(op) {
  const chunks = [];
  for await (const chunk of op.stream()) chunks.push(chunk);
  return allRows(chunks);
}

describe('SortOperator', () => {
  describe('wide integer sorts agree with a comparison sort', () => {
    const ROWS = Config.radixSortMinRows * 2;

    function keyed(colIdx, direction, nullsFirst) {
      return { eval: (chunk, row) => chunk.columns[colIdx].get(row), direction, nullsFirst };
    }

    function reference(values, direction, nullsFirst) {
      return values
        .map((value, index) => ({ value, index }))
        .sort((a, b) => {
          const aNull = a.value === null;
          const bNull = b.value === null;
          if (aNull || bNull) {
            if (aNull && bNull) return a.index - b.index;
            return (aNull ? -1 : 1) * (nullsFirst ? 1 : -1);
          }
          if (a.value < b.value) return direction === 'DESC' ? 1 : -1;
          if (a.value > b.value) return direction === 'DESC' ? -1 : 1;
          return a.index - b.index;
        })
        .map(entry => entry.index);
    }

    async function runSort(values, type, direction, nullsFirst) {
      const op = new SortOperator([keyed(0, direction, nullsFirst)], null, 0, memSpill());
      await op.consume(makeChunk([
        { type, values },
        { type: 'INT32', values: values.map((_, i) => i) },
      ]));
      return (await sorted(op)).map(r => r[1]);
    }

    for (const direction of ['ASC', 'DESC']) {
      for (const nullsFirst of [true, false]) {
        it(`orders signed integers ${direction} with nulls ${nullsFirst ? 'first' : 'last'}`, async () => {
          const values = [];
          for (let i = 0; i < ROWS; i++) {
            values.push(i % 11 === 0 ? null : ((i * 2654435761) % 2000001) - 1000000);
          }
          expect(await runSort(values, 'INT32', direction, nullsFirst))
            .toEqual(reference(values, direction, nullsFirst));
        });
      }
    }

    it('keeps rows with equal keys in the order they arrived', async () => {
      const values = new Array(ROWS).fill(0).map((_, i) => i % 4);
      const order = await runSort(values, 'INT32', 'ASC', false);

      const firstBucket = order.slice(0, ROWS / 4);
      expect(firstBucket).toEqual([...firstBucket].sort((a, b) => a - b));
    });

    it('keeps ties in arrival order when sorting descending too', async () => {
      const values = new Array(ROWS).fill(0).map((_, i) => i % 4);
      const order = await runSort(values, 'INT32', 'DESC', false);

      const firstBucket = order.slice(0, ROWS / 4);
      expect(firstBucket).toEqual([...firstBucket].sort((a, b) => a - b));
    });

    it('orders integers that do not fit a 32-bit key', async () => {
      const values = new Array(ROWS).fill(0).map((_, i) => (i % 2 === 0 ? i : -i) * 1e12);
      expect(await runSort(values, 'FLOAT64', 'ASC', false))
        .toEqual(reference(values, 'ASC', false));
    });

    it('orders fractional values', async () => {
      const values = new Array(ROWS).fill(0).map((_, i) => ((i * 7919) % 1000) / 8);
      expect(await runSort(values, 'FLOAT64', 'ASC', false))
        .toEqual(reference(values, 'ASC', false));
    });

    it('orders strings', async () => {
      const values = new Array(ROWS).fill(0).map((_, i) => `k${(i * 7919) % 1000}`);
      expect(await runSort(values, 'VARCHAR', 'ASC', false))
        .toEqual(reference(values, 'ASC', false));
    });

    it('orders a column that is entirely null', async () => {
      const values = new Array(ROWS).fill(null);
      expect(await runSort(values, 'INT32', 'ASC', true)).toHaveLength(ROWS);
    });
  });

  describe('in-memory sort', () => {
    it('sorts ascending by single key', async () => {
      const op = new SortOperator([ascKey(0)], null, 0, memSpill());
      await op.consume(makeChunk([
        { type: 'INT32', values: [30, 10, 20] },
        { type: 'VARCHAR', values: ['c', 'a', 'b'] },
      ]));

      const result = await sorted(op);

      expect(result.map(r => r[0])).toEqual([10, 20, 30]);
      expect(result.map(r => r[1])).toEqual(['a', 'b', 'c']);
    });

    it('sorts descending', async () => {
      const op = new SortOperator([descKey(0)], null, 0, memSpill());
      await op.consume(makeChunk([{ type: 'INT32', values: [1, 3, 2] }]));

      const result = await sorted(op);

      expect(result.map(r => r[0])).toEqual([3, 2, 1]);
    });

    it('sorts by multiple keys (secondary tiebreaker)', async () => {
      const op = new SortOperator([ascKey(0), descKey(1)], null, 0, memSpill());
      await op.consume(makeChunk([
        { type: 'INT32', values: [1, 1, 2] },
        { type: 'INT32', values: [10, 20, 5] },
      ]));

      const result = await sorted(op);

      expect(result[0]).toEqual([1, 20]);
      expect(result[1]).toEqual([1, 10]);
      expect(result[2]).toEqual([2, 5]);
    });

    it('places nulls last in ascending order', async () => {
      const op = new SortOperator([ascKey(0)], null, 0, memSpill());
      await op.consume(makeChunk([{ type: 'INT32', values: [3, null, 1, null, 2] }]));

      const result = await sorted(op);

      expect(result.map(r => r[0])).toEqual([1, 2, 3, null, null]);
    });

    it('handles string sorting', async () => {
      const op = new SortOperator([ascKey(0)], null, 0, memSpill());
      await op.consume(makeChunk([{ type: 'VARCHAR', values: ['banana', 'apple', 'cherry'] }]));

      const result = await sorted(op);

      expect(result.map(r => r[0])).toEqual(['apple', 'banana', 'cherry']);
    });
  });

  describe('topN optimization', () => {
    it('returns only limit rows', async () => {
      const op = new SortOperator([ascKey(0)], 3, 0, memSpill());
      await op.consume(makeChunk([{ type: 'INT32', values: [50, 40, 30, 20, 10] }]));

      const result = await sorted(op);

      expect(result.length).toBe(3);
      expect(result.map(r => r[0])).toEqual([10, 20, 30]);
    });

    it('applies offset before limit', async () => {
      const op = new SortOperator([ascKey(0)], 2, 2, memSpill());
      await op.consume(makeChunk([{ type: 'INT32', values: [5, 4, 3, 2, 1] }]));

      const result = await sorted(op);

      expect(result.length).toBe(2);
      expect(result.map(r => r[0])).toEqual([3, 4]);
    });

    it('handles offset beyond data size', async () => {
      const op = new SortOperator([ascKey(0)], 5, 100, memSpill());
      await op.consume(makeChunk([{ type: 'INT32', values: [1, 2, 3] }]));

      const result = await sorted(op);

      expect(result.length).toBe(0);
    });
  });

  describe('multi-chunk consume', () => {
    it('accumulates and sorts across multiple chunks', async () => {
      const op = new SortOperator([ascKey(0)], null, 0, memSpill());
      await op.consume(makeChunk([{ type: 'INT32', values: [30, 10] }]));
      await op.consume(makeChunk([{ type: 'INT32', values: [20, 5] }]));

      const result = await sorted(op);

      expect(result.map(r => r[0])).toEqual([5, 10, 20, 30]);
    });
  });

  describe('spill path (external merge sort)', () => {
    const INT_SCHEMA = [DataType.INT32];
    let restoreMemoryLimit;

    beforeEach(() => { restoreMemoryLimit = captureMemoryLimit(); });
    afterEach(() => { restoreMemoryLimit(); });

    it('produces correctly sorted output after spilling to runs', async () => {
      limitResidentRows(INT_SCHEMA, 5);

      const op = new SortOperator([ascKey(0)], null, 0, memSpill());
      for (let i = 20; i >= 1; i--) {
        await op.consume(makeChunk([{ type: 'INT32', values: [i] }]));
      }

      expect(op.runCount).toBeGreaterThan(0);

      const result = await sorted(op);

      expect(result.length).toBe(20);
      for (let i = 0; i < 20; i++) {
        expect(result[i][0]).toBe(i + 1);
      }
    });

    it('spill sort with limit returns correct top rows', async () => {
      limitResidentRows(INT_SCHEMA, 5);

      const op = new SortOperator([ascKey(0)], 3, 0, memSpill());
      for (let i = 15; i >= 1; i--) {
        await op.consume(makeChunk([{ type: 'INT32', values: [i] }]));
      }

      const result = await sorted(op);

      expect(result.length).toBe(3);
      expect(result.map(r => r[0])).toEqual([1, 2, 3]);
    });

    it('spill sort with offset skips rows correctly', async () => {
      limitResidentRows(INT_SCHEMA, 3);

      const op = new SortOperator([ascKey(0)], 2, 3, memSpill());
      for (let i = 10; i >= 1; i--) {
        await op.consume(makeChunk([{ type: 'INT32', values: [i] }]));
      }

      const result = await sorted(op);

      expect(result.map(r => r[0])).toEqual([4, 5]);
    });

    it('refills memory between spills so runs scale with the budget, not the chunk count', async () => {
      const budgetRows = 100;
      const chunkRows = 10;
      const chunkCount = 40;
      limitResidentRows(INT_SCHEMA, budgetRows);

      const op = new SortOperator([ascKey(0)], null, 0, memSpill());
      for (let c = 0; c < chunkCount; c++) {
        const values = Array.from({ length: chunkRows }, (_, i) => (c * chunkRows + i) * 7919 % 401);
        await op.consume(makeChunk([{ type: 'INT32', values }]));
      }

      const totalRows = chunkRows * chunkCount;
      expect(op.runCount).toBeGreaterThan(1);
      expect(op.runCount).toBeLessThanOrEqual(Math.ceil(totalRows / budgetRows) + 1);

      const result = await sorted(op);

      expect(result.length).toBe(totalRows);
      for (let i = 1; i < result.length; i++) {
        expect(result[i][0]).toBeGreaterThanOrEqual(result[i - 1][0]);
      }
    });

    it('merges multiple spill runs preserving sort order', async () => {
      limitResidentRows(INT_SCHEMA, 4);

      const op = new SortOperator([descKey(0)], null, 0, memSpill());
      const values = [3, 7, 1, 9, 5, 2, 8, 4, 6, 10];
      for (const v of values) {
        await op.consume(makeChunk([{ type: 'INT32', values: [v] }]));
      }

      expect(op.runCount).toBeGreaterThan(1);

      const result = await sorted(op);

      expect(result.map(r => r[0])).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    });
  });

  describe('empty input', () => {
    it('returns empty for no consumed chunks', async () => {
      const op = new SortOperator([ascKey(0)], null, 0, memSpill());
      expect(await sorted(op)).toEqual([]);
    });
  });
});

describe('LimitOperator', () => {
  it('limits output rows', async () => {
    const op = new LimitOperator(2);
    await op.consume(makeChunk([{ type: 'INT32', values: [1, 2, 3, 4, 5] }]));

    const result = allRows(await op.finalize());

    expect(result.length).toBe(2);
    expect(result[0][0]).toBe(1);
    expect(result[1][0]).toBe(2);
  });

  it('skips offset rows before emitting', async () => {
    const op = new LimitOperator(2, 2);
    await op.consume(makeChunk([{ type: 'INT32', values: [10, 20, 30, 40, 50] }]));

    const result = allRows(await op.finalize());

    expect(result.length).toBe(2);
    expect(result[0][0]).toBe(30);
    expect(result[1][0]).toBe(40);
  });

  it('handles limit across multiple chunks', async () => {
    const op = new LimitOperator(3);
    await op.consume(makeChunk([{ type: 'INT32', values: [1, 2] }]));
    await op.consume(makeChunk([{ type: 'INT32', values: [3, 4] }]));
    await op.consume(makeChunk([{ type: 'INT32', values: [5, 6] }]));

    const result = allRows(await op.finalize());

    expect(result.length).toBe(3);
    expect(result.map(r => r[0])).toEqual([1, 2, 3]);
  });

  it('handles offset spanning multiple chunks', async () => {
    const op = new LimitOperator(2, 3);
    await op.consume(makeChunk([{ type: 'INT32', values: [1, 2] }]));
    await op.consume(makeChunk([{ type: 'INT32', values: [3, 4] }]));
    await op.consume(makeChunk([{ type: 'INT32', values: [5, 6] }]));

    const result = allRows(await op.finalize());

    expect(result.length).toBe(2);
    expect(result.map(r => r[0])).toEqual([4, 5]);
  });

  it('returns empty when offset exceeds total rows', async () => {
    const op = new LimitOperator(5, 100);
    await op.consume(makeChunk([{ type: 'INT32', values: [1, 2, 3] }]));

    const result = await op.finalize();

    expect(allRows(result).length).toBe(0);
  });

  it('stops consuming after limit is reached', async () => {
    const op = new LimitOperator(1);
    await op.consume(makeChunk([{ type: 'INT32', values: [1] }]));
    expect(op.done).toBe(true);

    await op.consume(makeChunk([{ type: 'INT32', values: [2, 3] }]));
    const result = allRows(await op.finalize());

    expect(result.length).toBe(1);
  });

  it('returns all rows when limit exceeds total', async () => {
    const op = new LimitOperator(100);
    await op.consume(makeChunk([{ type: 'INT32', values: [1, 2, 3] }]));

    const result = allRows(await op.finalize());

    expect(result.length).toBe(3);
  });
});

describe('nullsFirstFor', () => {
  it('defaults ascending keys to nulls last', () => {
    expect(nullsFirstFor('ASC', null)).toBe(false);
  });

  it('defaults descending keys to nulls first', () => {
    expect(nullsFirstFor('DESC', null)).toBe(true);
  });

  it('defaults a missing direction to ascending', () => {
    expect(nullsFirstFor(null, null)).toBe(false);
  });

  it('lets an explicit null order win over the direction default', () => {
    expect(nullsFirstFor('DESC', 'LAST')).toBe(false);
    expect(nullsFirstFor('ASC', 'FIRST')).toBe(true);
  });
});

describe('SortOperator null placement', () => {
  function key(colIdx, direction, nullsFirst) {
    return { eval: (chunk, row) => chunk.columns[colIdx].get(row), direction, nullsFirst };
  }

  async function sortValues(sortKey) {
    const op = new SortOperator([sortKey], null, 0, memSpill());
    await op.consume(makeChunk([{ type: DataType.INT32, values: [3, null, 1, null, 2] }]));
    const chunks = [];
    for await (const chunk of op.stream()) chunks.push(chunk);
    return allRows(chunks).map(row => row[0]);
  }

  it('puts nulls last when nullsFirst is false', async () => {
    expect(await sortValues(key(0, 'ASC', false))).toEqual([1, 2, 3, null, null]);
  });

  it('puts nulls first when nullsFirst is true', async () => {
    expect(await sortValues(key(0, 'ASC', true))).toEqual([null, null, 1, 2, 3]);
  });

  it('keeps null placement independent of direction', async () => {
    expect(await sortValues(key(0, 'DESC', false))).toEqual([3, 2, 1, null, null]);
    expect(await sortValues(key(0, 'DESC', true))).toEqual([null, null, 3, 2, 1]);
  });
});

describe('LimitOperator.takeChunks', () => {
  it('hands out buffered chunks exactly once', async () => {
    const op = new LimitOperator(10);
    await op.consume(makeChunk([{ type: DataType.INT32, values: [1, 2] }]));

    expect(allRows(op.takeChunks()).length).toBe(2);
    expect(op.takeChunks()).toEqual([]);
  });

  it('never emits more than the limit across repeated drains', async () => {
    const op = new LimitOperator(3);
    await op.consume(makeChunk([{ type: DataType.INT32, values: [1, 2, 3] }]));
    const first = allRows(op.takeChunks());
    await op.consume(makeChunk([{ type: DataType.INT32, values: [4, 5, 6] }]));
    const second = allRows(op.takeChunks());

    expect(first.length + second.length).toBe(3);
  });
});
