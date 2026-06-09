import { describe, it, expect } from 'vitest';
import { MergeExchangeOperator, MinHeap } from '../../../src/distributed/execution/merge-exchange.js';
import { ChunkCodec } from '../../../src/distributed/transport/chunk-codec.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { Column } from '../../../src/storage/column.js';
import { DataType } from '../../../src/storage/data-type.js';

function makeIntChunk(values) {
  const col = new Column(DataType.INT32, values.length);
  for (let i = 0; i < values.length; i++) col.set(i, values[i]);
  col.length = values.length;
  return new DataChunk([col], values.length);
}

function makeTwoColChunk(ids, vals) {
  const idCol = new Column(DataType.INT32, ids.length);
  const valCol = new Column(DataType.FLOAT64, vals.length);
  for (let i = 0; i < ids.length; i++) {
    idCol.set(i, ids[i]);
    valCol.set(i, vals[i]);
  }
  idCol.length = ids.length;
  valCol.length = vals.length;
  return new DataChunk([idCol, valCol], ids.length);
}

class MockTransport {
  constructor() {
    this._listeners = new Map();
  }
  onChunkReceived(channelId, callback) { this._listeners.set(channelId, callback); }
  removeChunkListener(channelId) { this._listeners.delete(channelId); }
}

function feedSorted(merge, nodeId, values, codec, chunkSize = 1024) {
  for (let off = 0; off < values.length; off += chunkSize) {
    const slice = values.slice(off, off + chunkSize);
    merge._handleChunk(nodeId, codec.encode(makeIntChunk(slice)));
  }
  merge._handleChunk(nodeId, codec.encode(new DataChunk([], 0)));
}

async function collectAll(gen) {
  const values = [];
  for await (const chunk of gen) {
    for (let i = 0; i < chunk.size; i++) values.push(chunk.columns[0].get(i));
  }
  return values;
}

function isSorted(arr) {
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < arr[i - 1]) return false;
  }
  return true;
}

describe('MinHeap', () => {
  it('pops elements in sorted order', () => {
    const heap = new MinHeap((a, b) => a - b);
    heap.push(5);
    heap.push(3);
    heap.push(8);
    heap.push(1);
    heap.push(4);

    const result = [];
    while (heap.size > 0) {
      result.push(heap.pop());
    }
    expect(result).toEqual([1, 3, 4, 5, 8]);
  });

  it('handles single element', () => {
    const heap = new MinHeap((a, b) => a - b);
    heap.push(42);
    expect(heap.pop()).toBe(42);
    expect(heap.size).toBe(0);
  });

  it('handles duplicate values', () => {
    const heap = new MinHeap((a, b) => a - b);
    heap.push(3);
    heap.push(3);
    heap.push(1);
    heap.push(3);

    expect(heap.pop()).toBe(1);
    expect(heap.pop()).toBe(3);
    expect(heap.pop()).toBe(3);
    expect(heap.pop()).toBe(3);
  });

  it('peek returns smallest without removing', () => {
    const heap = new MinHeap((a, b) => a - b);
    heap.push(5);
    heap.push(2);
    heap.push(8);

    expect(heap.peek()).toBe(2);
    expect(heap.size).toBe(3);
  });

  it('returns null on pop from empty heap', () => {
    const heap = new MinHeap((a, b) => a - b);
    expect(heap.pop()).toBeNull();
  });

  it('works with object comparator', () => {
    const heap = new MinHeap((a, b) => a.key - b.key);
    heap.push({ key: 10, label: 'b' });
    heap.push({ key: 5, label: 'a' });
    heap.push({ key: 20, label: 'c' });

    expect(heap.pop().label).toBe('a');
    expect(heap.pop().label).toBe('b');
    expect(heap.pop().label).toBe('c');
  });

  it('handles large number of elements', () => {
    const heap = new MinHeap((a, b) => a - b);
    const values = Array.from({ length: 1000 }, (_, i) => 1000 - i);
    for (const v of values) heap.push(v);

    let prev = -Infinity;
    while (heap.size > 0) {
      const val = heap.pop();
      expect(val).toBeGreaterThanOrEqual(prev);
      prev = val;
    }
  });

  it('maintains heap property after interleaved push/pop', () => {
    const heap = new MinHeap((a, b) => a - b);
    heap.push(10);
    heap.push(5);
    expect(heap.pop()).toBe(5);

    heap.push(3);
    heap.push(7);
    expect(heap.pop()).toBe(3);

    heap.push(1);
    expect(heap.pop()).toBe(1);
    expect(heap.pop()).toBe(7);
    expect(heap.pop()).toBe(10);
  });
});

describe('MergeExchangeOperator', () => {
  const codec = new ChunkCodec();

  it('merges 2 sorted streams into globally sorted output', async () => {
    const transport = new MockTransport();
    const merge = new MergeExchangeOperator(transport, ['n0', 'n1'], {
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      channelId: 'merge-2way',
    });
    await merge.init();

    feedSorted(merge, 'n0', [1, 3, 5, 7, 9], codec);
    feedSorted(merge, 'n1', [2, 4, 6, 8, 10], codec);

    const result = await collectAll(merge.generate());
    merge.cleanup();

    expect(result).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('merges 4 sorted streams preserving global order', async () => {
    const transport = new MockTransport();
    const nodes = ['n0', 'n1', 'n2', 'n3'];
    const merge = new MergeExchangeOperator(transport, nodes, {
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      channelId: 'merge-4way',
    });
    await merge.init();

    feedSorted(merge, 'n0', [1, 5, 9, 13], codec);
    feedSorted(merge, 'n1', [2, 6, 10, 14], codec);
    feedSorted(merge, 'n2', [3, 7, 11, 15], codec);
    feedSorted(merge, 'n3', [4, 8, 12, 16], codec);

    const result = await collectAll(merge.generate());
    merge.cleanup();

    expect(result).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it('emits exactly the right number of rows (no duplicates)', async () => {
    const transport = new MockTransport();
    const merge = new MergeExchangeOperator(transport, ['n0', 'n1'], {
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      channelId: 'merge-count',
    });
    await merge.init();

    const n = 5000;
    feedSorted(merge, 'n0', Array.from({ length: n }, (_, i) => i * 2), codec);
    feedSorted(merge, 'n1', Array.from({ length: n }, (_, i) => i * 2 + 1), codec);

    const result = await collectAll(merge.generate());
    merge.cleanup();

    expect(result.length).toBe(n * 2);
    expect(isSorted(result)).toBe(true);
    expect(new Set(result).size).toBe(n * 2);
  });

  it('handles multi-chunk streams correctly (no row loss at chunk boundaries)', async () => {
    const transport = new MockTransport();
    const merge = new MergeExchangeOperator(transport, ['n0', 'n1'], {
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      channelId: 'merge-multichunk',
    });
    await merge.init();

    const perNode = 3000;
    feedSorted(merge, 'n0', Array.from({ length: perNode }, (_, i) => i * 2), codec, 512);
    feedSorted(merge, 'n1', Array.from({ length: perNode }, (_, i) => i * 2 + 1), codec, 512);

    const result = await collectAll(merge.generate());
    merge.cleanup();

    expect(result.length).toBe(perNode * 2);
    expect(isSorted(result)).toBe(true);
  });

  it('respects LIMIT and stops early', async () => {
    const transport = new MockTransport();
    const merge = new MergeExchangeOperator(transport, ['n0', 'n1'], {
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      limit: 5,
      channelId: 'merge-limit',
    });
    await merge.init();

    feedSorted(merge, 'n0', [1, 3, 5, 7, 9, 11], codec);
    feedSorted(merge, 'n1', [2, 4, 6, 8, 10, 12], codec);

    const result = await collectAll(merge.generate());
    merge.cleanup();

    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles DESC ordering', async () => {
    const transport = new MockTransport();
    const merge = new MergeExchangeOperator(transport, ['n0', 'n1'], {
      orderKeys: [{ columnIndex: 0, direction: 'DESC' }],
      channelId: 'merge-desc',
    });
    await merge.init();

    feedSorted(merge, 'n0', [10, 7, 4, 1], codec);
    feedSorted(merge, 'n1', [9, 6, 3, 0], codec);

    const result = await collectAll(merge.generate());
    merge.cleanup();

    expect(result).toEqual([10, 9, 7, 6, 4, 3, 1, 0]);
  });

  it('handles one empty stream', async () => {
    const transport = new MockTransport();
    const merge = new MergeExchangeOperator(transport, ['n0', 'n1'], {
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      channelId: 'merge-empty',
    });
    await merge.init();

    feedSorted(merge, 'n0', [1, 2, 3], codec);
    merge._handleChunk('n1', codec.encode(new DataChunk([], 0)));

    const result = await collectAll(merge.generate());
    merge.cleanup();

    expect(result).toEqual([1, 2, 3]);
  });

  it('handles all empty streams', async () => {
    const transport = new MockTransport();
    const merge = new MergeExchangeOperator(transport, ['n0', 'n1'], {
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      channelId: 'merge-allempty',
    });
    await merge.init();

    merge._handleChunk('n0', codec.encode(new DataChunk([], 0)));
    merge._handleChunk('n1', codec.encode(new DataChunk([], 0)));

    const result = await collectAll(merge.generate());
    merge.cleanup();

    expect(result).toEqual([]);
  });

  it('handles duplicate values across streams', async () => {
    const transport = new MockTransport();
    const merge = new MergeExchangeOperator(transport, ['n0', 'n1'], {
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      channelId: 'merge-dups',
    });
    await merge.init();

    feedSorted(merge, 'n0', [1, 2, 3, 5, 5], codec);
    feedSorted(merge, 'n1', [1, 3, 5, 7, 9], codec);

    const result = await collectAll(merge.generate());
    merge.cleanup();

    expect(result).toEqual([1, 1, 2, 3, 3, 5, 5, 5, 7, 9]);
    expect(isSorted(result)).toBe(true);
  });

  it('handles single source (k=1)', async () => {
    const transport = new MockTransport();
    const merge = new MergeExchangeOperator(transport, ['n0'], {
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      channelId: 'merge-single',
    });
    await merge.init();

    feedSorted(merge, 'n0', [10, 20, 30, 40, 50], codec);

    const result = await collectAll(merge.generate());
    merge.cleanup();

    expect(result).toEqual([10, 20, 30, 40, 50]);
  });

  it('8-way merge with interleaved values', async () => {
    const transport = new MockTransport();
    const k = 8;
    const nodes = Array.from({ length: k }, (_, i) => `n${i}`);
    const merge = new MergeExchangeOperator(transport, nodes, {
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      channelId: 'merge-8way',
    });
    await merge.init();

    const perNode = 1000;
    for (let n = 0; n < k; n++) {
      const values = Array.from({ length: perNode }, (_, i) => n + i * k);
      feedSorted(merge, nodes[n], values, codec);
    }

    const result = await collectAll(merge.generate());
    merge.cleanup();

    expect(result.length).toBe(k * perNode);
    expect(isSorted(result)).toBe(true);
    expect(new Set(result).size).toBe(k * perNode);

    for (let i = 0; i < k * perNode; i++) {
      expect(result[i]).toBe(i);
    }
  });

  it('LIMIT with k=4 returns correct top-N', async () => {
    const transport = new MockTransport();
    const nodes = ['n0', 'n1', 'n2', 'n3'];
    const merge = new MergeExchangeOperator(transport, nodes, {
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      limit: 10,
      channelId: 'merge-limit-4',
    });
    await merge.init();

    for (let n = 0; n < 4; n++) {
      feedSorted(merge, nodes[n], Array.from({ length: 100 }, (_, i) => n + i * 4), codec);
    }

    const result = await collectAll(merge.generate());
    merge.cleanup();

    expect(result).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('cleans up transport listener', async () => {
    const transport = new MockTransport();
    const merge = new MergeExchangeOperator(transport, ['n0'], {
      channelId: 'merge-cleanup',
    });
    await merge.init();

    expect(transport._listeners.has('merge-cleanup')).toBe(true);
    merge.cleanup();
    expect(transport._listeners.has('merge-cleanup')).toBe(false);
  });

  it('sets error on invalid data', async () => {
    const transport = new MockTransport();
    const merge = new MergeExchangeOperator(transport, ['n0'], {
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      channelId: 'merge-err',
    });
    await merge.init();

    merge._handleChunk('n0', Buffer.from([0xDE, 0xAD]));

    expect(merge._error).not.toBeNull();
  });

  it('preserves multiple columns during merge', async () => {
    const transport = new MockTransport();
    const merge = new MergeExchangeOperator(transport, ['n0', 'n1'], {
      orderKeys: [{ columnIndex: 0, direction: 'ASC' }],
      channelId: 'merge-multicol',
    });
    await merge.init();

    const c0 = makeTwoColChunk([1, 3, 5], [10.0, 30.0, 50.0]);
    const c1 = makeTwoColChunk([2, 4, 6], [20.0, 40.0, 60.0]);

    merge._handleChunk('n0', codec.encode(c0));
    merge._handleChunk('n0', codec.encode(new DataChunk([], 0)));
    merge._handleChunk('n1', codec.encode(c1));
    merge._handleChunk('n1', codec.encode(new DataChunk([], 0)));

    const ids = [];
    const vals = [];
    for await (const chunk of merge.generate()) {
      for (let i = 0; i < chunk.size; i++) {
        ids.push(chunk.columns[0].get(i));
        vals.push(chunk.columns[1].get(i));
      }
    }
    merge.cleanup();

    expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
    expect(vals).toEqual([10.0, 20.0, 30.0, 40.0, 50.0, 60.0]);
  });
});
