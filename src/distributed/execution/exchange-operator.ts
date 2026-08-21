import { Config } from '../../config.js';
import { ExchangeType } from '../planner/fragment.js';
import { ChunkCodec } from '../transport/chunk-codec.js';
import { DataChunk } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';
import { murmur3 } from '../partition/partition-strategy.js';
import { hashKeyValues } from '../../execution/hash-table.js';
import type { EvalValue } from '../../execution/execution-types.js';
import type { Transport } from '../transport/transport.js';
import type {
  NodeId,
  ChannelId,
  KeyExtractor,
  ExchangeType as ExchangeTypeEnum,
  ExchangeSenderOptions,
  ExchangeReceiverOptions,
  PartitionId,
} from '../distributed-types.js';

export class ExchangeSender {
  _transport: Transport;
  _targetNodes: NodeId[];
  _exchangeType: ExchangeTypeEnum;
  _keyExtractors: KeyExtractor[];
  _partitionCount: number;
  _channelId: ChannelId;
  _codec: ChunkCodec;
  _batchSize: number;
  _closed: boolean;

  constructor(transport: Transport, targetNodes: NodeId[], options: Partial<ExchangeSenderOptions> = {}) {
    this._transport = transport;
    this._targetNodes = targetNodes;
    this._exchangeType = options.exchangeType || ExchangeType.GATHER;
    this._keyExtractors = options.keyExtractors || [];
    this._partitionCount = options.partitionCount || targetNodes.length;
    this._channelId = options.channelId || `exchange-${Date.now()}`;
    this._codec = new ChunkCodec();
    this._batchSize = Config.exchangeBatchSize;
    this._closed = false;
  }

  get channelId(): ChannelId {
    return this._channelId;
  }

  async init(): Promise<void> {}

  async consume(chunk: DataChunk): Promise<void> {
    if (this._closed || !chunk || chunk.size === 0) return;

    switch (this._exchangeType) {
      case ExchangeType.GATHER:
        await this._sendGather(chunk);
        break;
      case ExchangeType.BROADCAST:
        await this._sendBroadcast(chunk);
        break;
      case ExchangeType.HASH_SHUFFLE:
        await this._sendShuffle(chunk);
        break;
      default:
        await this._sendGather(chunk);
    }
  }

  async finalize(): Promise<void> {
    this._closed = true;
    const endMarker = this._codec.encode(new DataChunk([], 0));
    const promises = this._targetNodes.map(nodeId =>
      this._transport.sendChunk(nodeId, this._channelId, endMarker)
    );
    await Promise.all(promises);
  }

  async _sendGather(chunk: DataChunk): Promise<void> {
    const encoded = this._codec.encode(chunk);
    const targetNode = this._targetNodes[0];
    await this._transport.sendChunk(targetNode, this._channelId, encoded);
  }

  async _sendBroadcast(chunk: DataChunk): Promise<void> {
    const encoded = this._codec.encode(chunk);
    const promises = this._targetNodes.map(nodeId =>
      this._transport.sendChunk(nodeId, this._channelId, encoded)
    );
    await Promise.all(promises);
  }

  async _sendShuffle(chunk: DataChunk): Promise<void> {
    const partitioned = this._partitionByKey(chunk);
    const promises: Promise<void>[] = [];

    for (const [partitionId, partChunk] of partitioned) {
      const targetIdx = partitionId % this._targetNodes.length;
      const targetNode = this._targetNodes[targetIdx];
      const encoded = this._codec.encode(partChunk);
      promises.push(this._transport.sendChunk(targetNode, this._channelId, encoded));
    }

    await Promise.all(promises);
  }

  _partitionByKey(chunk: DataChunk): Map<PartitionId, DataChunk> {
    const size = chunk.size;
    const partCount = this._partitionCount;
    const buckets = new Map<PartitionId, number[]>();
    const keyParts: EvalValue[] = new Array(this._keyExtractors.length);

    for (let i = 0; i < size; i++) {
      const rowIdx = chunk.selectionVector ? chunk.selectionVector[i] : i;
      for (let k = 0; k < this._keyExtractors.length; k++) keyParts[k] = this._keyExtractors[k](chunk, rowIdx);
      const pid = hashKeyValues(keyParts, keyParts.length) % partCount;

      let rows = buckets.get(pid);
      if (!rows) {
        rows = [];
        buckets.set(pid, rows);
      }
      rows.push(rowIdx);
    }

    const result = new Map<PartitionId, DataChunk>();
    for (const [pid, rowIndices] of buckets) {
      const cols = chunk.columns.map(srcCol => {
        const newCol = new Column(srcCol.dataType, rowIndices.length);
        for (let j = 0; j < rowIndices.length; j++) {
          newCol.set(j, srcCol.get(rowIndices[j]));
        }
        newCol.length = rowIndices.length;
        return newCol;
      });
      result.set(pid, new DataChunk(cols, rowIndices.length));
    }

    return result;
  }
}

export class ExchangeReceiver {
  _transport: Transport;
  _sourceNodes: NodeId[];
  _channelId: ChannelId;
  _codec: ChunkCodec;
  _bufferCapacity: number;
  _buffer: DataChunk[];
  _completedSources: Set<NodeId>;
  _resolveWaiter: (() => void) | null;
  _done: boolean;
  _error: Error | null;
  _listening: boolean;

  constructor(transport: Transport, sourceNodes: NodeId[], options: Partial<ExchangeReceiverOptions> = {}) {
    this._transport = transport;
    this._sourceNodes = sourceNodes;
    this._channelId = options.channelId || `exchange-${Date.now()}`;
    this._codec = new ChunkCodec();
    this._bufferCapacity = Config.exchangeBufferCapacity;
    this._buffer = [];
    this._completedSources = new Set();
    this._resolveWaiter = null;
    this._done = false;
    this._error = null;
    this._listening = false;
  }

  get channelId(): ChannelId {
    return this._channelId;
  }

  async init(): Promise<void> {
    if (this._listening) return;
    this._listening = true;
    this._transport.onChunkReceived(this._channelId, (sourceNodeId, encodedChunk) => {
      this._handleChunk(sourceNodeId, encodedChunk);
    });
  }

  async *generate(): AsyncGenerator<DataChunk, void, void> {
    while (true) {
      if (this._buffer.length > 0) {
        yield this._buffer.shift()!;
        continue;
      }

      if (this._error) throw this._error;

      if (this._done) break;

      if (this._completedSources.size >= this._sourceNodes.length) {
        this._done = true;
        break;
      }

      await new Promise<void>(resolve => {
        this._resolveWaiter = resolve;
      });
    }
  }

  cleanup(): void {
    this._done = true;
    this._transport.removeChunkListener(this._channelId);
    if (this._resolveWaiter) {
      this._resolveWaiter();
      this._resolveWaiter = null;
    }
  }

  _handleChunk(sourceNodeId: NodeId, encodedChunk: Buffer): void {
    try {
      const chunk = this._codec.decode(encodedChunk);

      if (chunk.size === 0 && chunk.columns.length === 0) {
        this._completedSources.add(sourceNodeId);
        if (this._completedSources.size >= this._sourceNodes.length) {
          this._done = true;
        }
        this._wake();
        return;
      }

      this._buffer.push(chunk);
      this._wake();
    } catch (err) {
      this._error = err as Error;
      this._wake();
    }
  }

  _wake(): void {
    if (this._resolveWaiter) {
      const resolve = this._resolveWaiter;
      this._resolveWaiter = null;
      resolve();
    }
  }
}
