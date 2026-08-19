import { Config } from '../config.js';
import { RowMemoryBudget } from './memory-budget.js';
import type { DataChunk } from '../storage/chunk.js';
import type { ChunkSpillStore } from '../storage/spill-manager/spill-manager.js';
import type { Sink } from './execution-types.js';

const MATERIALIZED_HANDLE = 'result';

export class ResultSink implements Sink {
  _streaming: boolean;
  _capacity: number;
  _queue: (DataChunk | undefined)[];
  _head: number;
  _tail: number;
  _count: number;
  _totalRows: number;
  _done: boolean;
  _error: Error | null;
  _producerResolve: (() => void) | null;
  _consumerResolve: (() => void) | null;
  _collected: DataChunk[];
  _spillStore: ChunkSpillStore | null;
  _memoryBudget: RowMemoryBudget;
  _spilledChunks: number;
  _spillWrites: Promise<void>;

  constructor(streaming: boolean = false, spillStore: ChunkSpillStore | null = null) {
    this._streaming = streaming;
    this._capacity = Config.sinkQueueCapacity;
    this._queue = new Array(this._capacity);
    this._head = 0;
    this._tail = 0;
    this._count = 0;
    this._totalRows = 0;
    this._done = false;
    this._error = null;
    this._producerResolve = null;
    this._consumerResolve = null;
    this._collected = [];
    this._spillStore = spillStore;
    this._memoryBudget = new RowMemoryBudget();
    this._spilledChunks = 0;
    this._spillWrites = Promise.resolve();
  }

  async init(): Promise<void> {}

  async consume(chunk: DataChunk): Promise<void> {
    if (!chunk || chunk.size === 0) return;
    if (this._error) throw this._error;

    this._totalRows += chunk.size;

    if (!this._streaming) {
      await this.collectChunk(chunk);
      return;
    }

    if (this._count === this._capacity) {
      await new Promise<void>(resolve => {
        this._producerResolve = resolve;
      });
    }

    if (this._error) throw this._error;

    this._queue[this._tail] = chunk;
    this._tail = (this._tail + 1) % this._capacity;
    this._count++;

    if (this._consumerResolve) {
      const resolve = this._consumerResolve;
      this._consumerResolve = null;
      resolve();
    }
  }

  async collectChunk(chunk: DataChunk): Promise<void> {
    if (this._collected.length === 0) {
      this._memoryBudget.adoptSchema(chunk.columns.map((column) => column.dataType));
    }

    this._collected.push(chunk);
    this._memoryBudget.admit(chunk.size);

    if (this._spillStore && this._memoryBudget.exceeded) {
      await this.spillCollected(this._spillStore);
    }
  }

  async spillCollected(spillStore: ChunkSpillStore): Promise<void> {
    const pending = this._collected;
    if (pending.length === 0) return;
    this._collected = [];
    this._memoryBudget.reset();
    this._spilledChunks += pending.length;

    const writes = this._spillWrites.then(async () => {
      for (const chunk of pending) await spillStore.appendChunk(MATERIALIZED_HANDLE, chunk);
    });
    this._spillWrites = writes;
    await writes;
  }

  get spilledChunkCount(): number {
    return this._spilledChunks;
  }

  async finalize(): Promise<void> {
    this._done = true;
    if (this._consumerResolve) {
      const resolve = this._consumerResolve;
      this._consumerResolve = null;
      resolve();
    }
  }

  error(err: Error): void {
    this._error = err;
    this._done = true;
    if (this._consumerResolve) {
      const resolve = this._consumerResolve;
      this._consumerResolve = null;
      resolve();
    }
    if (this._producerResolve) {
      const resolve = this._producerResolve;
      this._producerResolve = null;
      resolve();
    }
  }

  get totalRows(): number {
    return this._totalRows;
  }

  get residentChunks(): DataChunk[] {
    return this._collected;
  }

  materializedIterator(): AsyncIterator<DataChunk> {
    const sink = this;
    const drain = async function* (): AsyncGenerator<DataChunk> {
      await sink._spillWrites;
      if (sink._spillStore && sink._spilledChunks > 0) {
        for await (const chunk of sink._spillStore.readChunks(MATERIALIZED_HANDLE)) yield chunk;
      }
      for (const chunk of sink._collected) yield chunk;
      if (sink._spillStore && sink._spilledChunks > 0) await sink._spillStore.clearAll();
    };
    return drain()[Symbol.asyncIterator]();
  }

  _dequeue(): DataChunk | undefined {
    const chunk = this._queue[this._head];
    this._queue[this._head] = undefined;
    this._head = (this._head + 1) % this._capacity;
    this._count--;

    if (this._producerResolve) {
      const resolve = this._producerResolve;
      this._producerResolve = null;
      resolve();
    }

    return chunk;
  }

  [Symbol.asyncIterator](): AsyncIterator<DataChunk> {
    if (!this._streaming) {
      return this.materializedIterator();
    }

    const sink = this;
    return {
      async next() {
        while (sink._count === 0) {
          if (sink._error) throw sink._error;
          if (sink._done) return { done: true, value: undefined };
          await new Promise<void>(resolve => {
            sink._consumerResolve = resolve;
          });
        }

        if (sink._error) throw sink._error;

        return { done: false, value: sink._dequeue()! };
      }
    };
  }

  async collect(): Promise<DataChunk[]> {
    const chunks: DataChunk[] = [];
    for await (const chunk of this) {
      chunks.push(chunk);
    }
    return chunks;
  }
}
