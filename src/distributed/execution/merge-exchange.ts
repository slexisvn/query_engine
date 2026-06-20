import { Config } from '../../config.js';
import { DataChunk, DEFAULT_CHUNK_SIZE } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';
import { isFixedWidth } from '../../storage/data-type.js';
import { setBit, clearBit, testBit, setBitRange } from '../../utils/bitmap.js';
import { ChunkCodec } from '../transport/chunk-codec.js';
import type { Transport } from '../transport/transport.js';
import type {
  NodeId,
  ChannelId,
  DistributedOrderKey,
  MergeExchangeOptions,
} from '../distributed-types.js';

interface ReadableChunk extends DataChunk {
  _readIdx?: number;
}

interface HeapEntry {
  nodeId: NodeId;
  chunk: ReadableChunk;
  rowIdx: number;
}

type EntryComparator = (a: HeapEntry, b: HeapEntry) => number;

export class MergeExchangeOperator {
  _transport: Transport;
  _sourceNodes: NodeId[];
  _orderKeys: DistributedOrderKey[];
  _limit: number | null;
  _channelId: ChannelId;
  _codec: ChunkCodec;
  _buffers: Map<NodeId, ReadableChunk[]>;
  _exhausted: Set<NodeId>;
  _resolveWaiter: (() => void) | null;
  _error: Error | null;
  _listening: boolean;

  constructor(transport: Transport, sourceNodes: NodeId[], options: Partial<MergeExchangeOptions> = {}) {
    this._transport = transport;
    this._sourceNodes = sourceNodes;
    this._orderKeys = options.orderKeys || [];
    this._limit = options.limit || null;
    this._channelId = options.channelId || `merge-exchange-${Date.now()}`;
    this._codec = new ChunkCodec();
    this._buffers = new Map();
    this._exhausted = new Set();
    this._resolveWaiter = null;
    this._error = null;
    this._listening = false;
  }

  get channelId(): ChannelId {
    return this._channelId;
  }

  async init(): Promise<void> {
    if (this._listening) return;
    this._listening = true;

    for (const nodeId of this._sourceNodes) {
      this._buffers.set(nodeId, []);
    }

    this._transport.onChunkReceived(this._channelId, (sourceNodeId: NodeId, encodedChunk: Buffer) => {
      this._handleChunk(sourceNodeId, encodedChunk);
    });
  }

  async *generate(): AsyncGenerator<DataChunk, void, void> {
    const heap = new MinHeap(this._compareEntries.bind(this));
    let emitted = 0;

    await this._ensureAllStreamsHaveData();

    for (const [nodeId] of this._buffers) {
      const entry = this._nextEntry(nodeId);
      if (entry) heap.push(entry);
    }

    let outputCols: Column[] | null = null;
    let outputCount = 0;

    while (heap.size > 0) {
      if (this._limit && emitted >= this._limit) break;
      if (this._error) throw this._error;

      const top = heap.pop()!;

      const runLen = this._computeRunLength(top, heap);
      const maxCopy = this._limit ? Math.min(runLen, this._limit - emitted) : runLen;

      let copied = 0;
      while (copied < maxCopy) {
        if (!outputCols) {
          outputCols = top.chunk.columns.map(c => new Column(c.dataType, DEFAULT_CHUNK_SIZE));
        }

        const space = DEFAULT_CHUNK_SIZE - outputCount;
        const batch = Math.min(maxCopy - copied, space);
        const srcStart = top.rowIdx + copied;

        this._bulkCopy(top.chunk, srcStart, outputCols, outputCount, batch);
        outputCount += batch;
        copied += batch;
        emitted += batch;

        if (outputCount >= DEFAULT_CHUNK_SIZE) {
          for (const col of outputCols) col.length = outputCount;
          yield new DataChunk(outputCols, outputCount);
          outputCols = null;
          outputCount = 0;
        }
      }

      const nextRow = top.rowIdx + maxCopy;
      if (nextRow < top.chunk.size) {
        top.chunk._readIdx = nextRow + 1;
        heap.push({ nodeId: top.nodeId, chunk: top.chunk, rowIdx: nextRow });
      } else {
        top.chunk._readIdx = top.chunk.size;
        const nextEntry = this._nextEntry(top.nodeId);
        if (nextEntry) {
          heap.push(nextEntry);
        } else if (!this._exhausted.has(top.nodeId)) {
          await this._waitForData(top.nodeId);
          const entry = this._nextEntry(top.nodeId);
          if (entry) heap.push(entry);
        }
      }
    }

    if (outputCount > 0 && outputCols) {
      for (const col of outputCols) col.length = outputCount;
      yield new DataChunk(outputCols, outputCount);
    }
  }

  _computeRunLength(top: HeapEntry, heap: MinHeap): number {
    const remaining = top.chunk.size - top.rowIdx;
    if (heap.size === 0) return remaining;

    const runnerUp = heap.peek()!;
    let run = 1;

    for (let i = top.rowIdx + 1; i < top.chunk.size; i++) {
      if (this._compareRowAgainst(top.chunk, i, runnerUp) > 0) break;
      run++;
    }

    return run;
  }

  _compareRowAgainst(chunk: ReadableChunk, rowIdx: number, entry: HeapEntry): number {
    for (const key of this._orderKeys) {
      const colIdx = key.columnIndex !== undefined ? key.columnIndex : 0;
      const valA = chunk.columns[colIdx]?.get(rowIdx);
      const valB = entry.chunk.columns[colIdx]?.get(entry.rowIdx);

      if (valA === null && valB === null) continue;
      if (valA === null) return key.direction === 'DESC' ? -1 : 1;
      if (valB === null) return key.direction === 'DESC' ? 1 : -1;

      if ((valA as number) < (valB as number)) return key.direction === 'DESC' ? 1 : -1;
      if ((valA as number) > (valB as number)) return key.direction === 'DESC' ? -1 : 1;
    }
    return 0;
  }

  _bulkCopy(srcChunk: ReadableChunk, srcStart: number, destCols: Column[], destStart: number, count: number): void {
    for (let c = 0; c < srcChunk.columns.length; c++) {
      const src = srcChunk.columns[c] as Column;
      const dest = destCols[c];

      if (isFixedWidth(src.dataType) && src.data) {
        (dest.data! as Float64Array).set(src.data.subarray(srcStart, srcStart + count) as Float64Array, destStart);
      } else {
        for (let i = 0; i < count; i++) {
          dest.set(destStart + i, src.get(srcStart + i));
        }
        continue;
      }

      if (src.hasNulls) {
        dest.hasNulls = true;
        for (let i = 0; i < count; i++) {
          if (testBit(src.nullBitmap, srcStart + i)) {
            setBit(dest.nullBitmap, destStart + i);
          } else {
            clearBit(dest.nullBitmap, destStart + i);
          }
        }
      } else {
        setBitRange(dest.nullBitmap, destStart, destStart + count);
      }
    }
  }

  cleanup(): void {
    this._transport.removeChunkListener(this._channelId);
  }

  _handleChunk(sourceNodeId: NodeId, encodedChunk: Buffer): void {
    try {
      const chunk = this._codec.decode(encodedChunk);

      if (chunk.size === 0 && chunk.columns.length === 0) {
        this._exhausted.add(sourceNodeId);
        this._wake();
        return;
      }

      const buffer = this._buffers.get(sourceNodeId);
      if (buffer) {
        buffer.push(chunk);
        this._wake();
      }
    } catch (err) {
      this._error = err as Error;
      this._wake();
    }
  }

  _nextEntry(nodeId: NodeId): HeapEntry | null {
    const buffer = this._buffers.get(nodeId);
    if (!buffer || buffer.length === 0) return null;

    const chunk = buffer[0];
    if (chunk._readIdx === undefined) chunk._readIdx = 0;

    if (chunk._readIdx >= chunk.size) {
      buffer.shift();
      return this._nextEntry(nodeId);
    }

    const entry: HeapEntry = { nodeId, chunk, rowIdx: chunk._readIdx };
    chunk._readIdx++;
    return entry;
  }

  async _ensureAllStreamsHaveData(): Promise<void> {
    for (const nodeId of this._sourceNodes) {
      if (this._buffers.get(nodeId)!.length === 0 && !this._exhausted.has(nodeId)) {
        await this._waitForData(nodeId);
      }
    }
  }

  async _waitForData(nodeId: NodeId): Promise<void> {
    const maxWait = Config.coordinatorTimeoutMs;
    const start = Date.now();

    while (true) {
      const buffer = this._buffers.get(nodeId);
      if ((buffer && buffer.length > 0) || this._exhausted.has(nodeId)) return;
      if (Date.now() - start > maxWait) {
        throw new Error(`Timeout waiting for data from node ${nodeId}`);
      }
      await new Promise<void>(resolve => {
        this._resolveWaiter = resolve;
        setTimeout(resolve, 100);
      });
    }
  }

  _wake(): void {
    if (this._resolveWaiter) {
      const resolve = this._resolveWaiter;
      this._resolveWaiter = null;
      resolve();
    }
  }

  _compareEntries(a: HeapEntry, b: HeapEntry): number {
    for (const key of this._orderKeys) {
      const colIdx = key.columnIndex !== undefined ? key.columnIndex : 0;
      const valA = a.chunk.columns[colIdx]?.get(a.rowIdx);
      const valB = b.chunk.columns[colIdx]?.get(b.rowIdx);

      if (valA === null && valB === null) continue;
      if (valA === null) return key.direction === 'DESC' ? -1 : 1;
      if (valB === null) return key.direction === 'DESC' ? 1 : -1;

      if ((valA as number) < (valB as number)) return key.direction === 'DESC' ? 1 : -1;
      if ((valA as number) > (valB as number)) return key.direction === 'DESC' ? -1 : 1;
    }
    return 0;
  }
}

class MinHeap {
  _data: HeapEntry[];
  _compare: EntryComparator;

  constructor(comparator: EntryComparator) {
    this._data = [];
    this._compare = comparator;
  }

  get size(): number {
    return this._data.length;
  }

  push(item: HeapEntry): void {
    this._data.push(item);
    this._bubbleUp(this._data.length - 1);
  }

  pop(): HeapEntry | null {
    if (this._data.length === 0) return null;
    const top = this._data[0];
    const last = this._data.pop()!;
    if (this._data.length > 0) {
      this._data[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  peek(): HeapEntry | null {
    return this._data[0] || null;
  }

  _bubbleUp(idx: number): void {
    while (idx > 0) {
      const parent = (idx - 1) >>> 1;
      if (this._compare(this._data[idx], this._data[parent]) >= 0) break;
      this._swap(idx, parent);
      idx = parent;
    }
  }

  _sinkDown(idx: number): void {
    const length = this._data.length;
    while (true) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;

      if (left < length && this._compare(this._data[left], this._data[smallest]) < 0) {
        smallest = left;
      }
      if (right < length && this._compare(this._data[right], this._data[smallest]) < 0) {
        smallest = right;
      }

      if (smallest === idx) break;
      this._swap(idx, smallest);
      idx = smallest;
    }
  }

  _swap(i: number, j: number): void {
    const tmp = this._data[i];
    this._data[i] = this._data[j];
    this._data[j] = tmp;
  }
}

export { MinHeap };
