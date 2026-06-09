import { describe, it, expect, beforeEach } from 'vitest';
import { ExchangeSender, ExchangeReceiver } from '../../../src/distributed/execution/exchange-operator.js';
import { ChunkCodec } from '../../../src/distributed/transport/chunk-codec.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { Column } from '../../../src/storage/column.js';
import { DataType } from '../../../src/storage/data-type.js';
import { murmur3 } from '../../../src/distributed/partition/partition-strategy.js';

function makeIntChunk(values) {
  const col = new Column(DataType.INT32, values.length);
  for (let i = 0; i < values.length; i++) col.set(i, values[i]);
  col.length = values.length;
  return new DataChunk([col], values.length);
}

class MockTransport {
  constructor() {
    this._listeners = new Map();
    this._sent = [];
  }

  async sendChunk(targetNodeId, channelId, encodedChunk) {
    this._sent.push({ targetNodeId, channelId, data: encodedChunk });
    const listener = this._listeners.get(channelId);
    if (listener) {
      listener(targetNodeId, encodedChunk);
    }
  }

  onChunkReceived(channelId, callback) {
    this._listeners.set(channelId, callback);
  }

  removeChunkListener(channelId) {
    this._listeners.delete(channelId);
  }
}

describe('ExchangeSender', () => {
  let transport;
  const codec = new ChunkCodec();

  beforeEach(() => {
    transport = new MockTransport();
  });

  it('sends chunks via gather to first target node only', async () => {
    const sender = new ExchangeSender(transport, ['node-1', 'node-2'], {
      exchangeType: 'gather',
      channelId: 'ch-1',
    });

    await sender.consume(makeIntChunk([1, 2, 3]));
    expect(transport._sent.length).toBe(1);
    expect(transport._sent[0].targetNodeId).toBe('node-1');

    const decoded = codec.decode(transport._sent[0].data);
    expect(decoded.size).toBe(3);
    expect(decoded.columns[0].get(0)).toBe(1);
    expect(decoded.columns[0].get(2)).toBe(3);
  });

  it('broadcasts chunks to all target nodes with identical data', async () => {
    const sender = new ExchangeSender(transport, ['node-1', 'node-2', 'node-3'], {
      exchangeType: 'broadcast',
      channelId: 'ch-2',
    });

    await sender.consume(makeIntChunk([10, 20]));
    expect(transport._sent.length).toBe(3);

    const targets = new Set(transport._sent.map(s => s.targetNodeId));
    expect(targets.size).toBe(3);
    expect(targets.has('node-1')).toBe(true);
    expect(targets.has('node-2')).toBe(true);
    expect(targets.has('node-3')).toBe(true);

    for (const msg of transport._sent) {
      const decoded = codec.decode(msg.data);
      expect(decoded.size).toBe(2);
      expect(decoded.columns[0].get(0)).toBe(10);
      expect(decoded.columns[0].get(1)).toBe(20);
    }
  });

  it('hash-shuffle sends each row to the correct target based on hash', async () => {
    const sender = new ExchangeSender(transport, ['node-0', 'node-1'], {
      exchangeType: 'hash_shuffle',
      keyExtractors: [(chunk, row) => chunk.columns[0].get(row)],
      partitionCount: 2,
      channelId: 'ch-3',
    });

    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    await sender.consume(makeIntChunk(values));

    let totalRows = 0;
    const rowsByNode = { 'node-0': [], 'node-1': [] };

    for (const msg of transport._sent) {
      const decoded = codec.decode(msg.data);
      totalRows += decoded.size;
      for (let i = 0; i < decoded.size; i++) {
        rowsByNode[msg.targetNodeId].push(decoded.columns[0].get(i));
      }
    }

    expect(totalRows).toBe(8);
    expect(new Set([...rowsByNode['node-0'], ...rowsByNode['node-1']]).size).toBe(8);

    for (const val of rowsByNode['node-0']) {
      const expectedTarget = (murmur3(String(val), 0x9747b28c) % 2) % 2;
      expect(expectedTarget).toBe(0);
    }
    for (const val of rowsByNode['node-1']) {
      const expectedTarget = (murmur3(String(val), 0x9747b28c) % 2) % 2;
      expect(expectedTarget).toBe(1);
    }
  });

  it('shuffle with more partitions than nodes wraps around', async () => {
    const sender = new ExchangeSender(transport, ['n0', 'n1'], {
      exchangeType: 'hash_shuffle',
      keyExtractors: [(chunk, row) => chunk.columns[0].get(row)],
      partitionCount: 4,
      channelId: 'ch-wrap',
    });

    await sender.consume(makeIntChunk(Array.from({ length: 20 }, (_, i) => i)));

    let totalRows = 0;
    for (const msg of transport._sent) {
      totalRows += codec.decode(msg.data).size;
    }
    expect(totalRows).toBe(20);
  });

  it('sends end markers to all targets on finalize', async () => {
    const sender = new ExchangeSender(transport, ['node-1', 'node-2'], {
      exchangeType: 'gather',
      channelId: 'ch-4',
    });

    await sender.finalize();
    expect(transport._sent.length).toBe(2);

    for (const msg of transport._sent) {
      const decoded = codec.decode(msg.data);
      expect(decoded.size).toBe(0);
      expect(decoded.columns.length).toBe(0);
    }
  });

  it('skips empty chunks', async () => {
    const sender = new ExchangeSender(transport, ['node-1'], {
      exchangeType: 'gather',
      channelId: 'ch-5',
    });

    await sender.consume(new DataChunk([], 0));
    expect(transport._sent.length).toBe(0);
  });
});

describe('ExchangeReceiver', () => {
  let transport;
  const codec = new ChunkCodec();

  beforeEach(() => {
    transport = new MockTransport();
  });

  it('receives and yields chunks in order', async () => {
    const channelId = 'recv-1';
    const receiver = new ExchangeReceiver(transport, ['node-1'], { channelId });
    await receiver.init();

    const chunk1 = makeIntChunk([10, 20, 30]);
    const chunk2 = makeIntChunk([40, 50]);

    receiver._handleChunk('node-1', codec.encode(chunk1));
    receiver._handleChunk('node-1', codec.encode(chunk2));
    receiver._handleChunk('node-1', codec.encode(new DataChunk([], 0)));

    const received = [];
    for await (const chunk of receiver.generate()) {
      for (let i = 0; i < chunk.size; i++) {
        received.push(chunk.columns[0].get(i));
      }
    }

    expect(received).toEqual([10, 20, 30, 40, 50]);
  });

  it('waits for end markers from all source nodes', async () => {
    const channelId = 'recv-multi';
    const receiver = new ExchangeReceiver(transport, ['n1', 'n2'], { channelId });
    await receiver.init();

    receiver._handleChunk('n1', codec.encode(makeIntChunk([1])));
    receiver._handleChunk('n1', codec.encode(new DataChunk([], 0)));
    receiver._handleChunk('n2', codec.encode(makeIntChunk([2])));
    receiver._handleChunk('n2', codec.encode(new DataChunk([], 0)));

    const values = [];
    for await (const chunk of receiver.generate()) {
      for (let i = 0; i < chunk.size; i++) values.push(chunk.columns[0].get(i));
    }

    expect(values.sort()).toEqual([1, 2]);
  });

  it('cleans up transport listener on cleanup()', async () => {
    const receiver = new ExchangeReceiver(transport, ['node-1'], { channelId: 'recv-2' });
    await receiver.init();

    expect(transport._listeners.has('recv-2')).toBe(true);
    receiver.cleanup();
    expect(transport._listeners.has('recv-2')).toBe(false);
  });

  it('propagates decode errors', async () => {
    const receiver = new ExchangeReceiver(transport, ['n1'], { channelId: 'recv-err' });
    await receiver.init();

    receiver._handleChunk('n1', Buffer.from([0xDE, 0xAD]));

    let caught = false;
    try {
      for await (const _ of receiver.generate()) {}
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
  });
});
