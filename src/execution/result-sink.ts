import { Config } from '../config.js';
import type { DataChunk } from '../storage/chunk.js';
import type { Sink } from './execution-types.js';

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

  constructor(streaming: boolean = false) {
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
  }

  async init(): Promise<void> {}

  async consume(chunk: DataChunk): Promise<void> {
    if (!chunk || chunk.size === 0) return;
    if (this._error) throw this._error;

    this._totalRows += chunk.size;

    if (!this._streaming) {
      this._collected.push(chunk);
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

  get chunks(): DataChunk[] {
    return this._collected;
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
      let index = 0;
      const collected = this._collected;
      return {
        async next() {
          if (index < collected.length) {
            return { done: false, value: collected[index++] };
          }
          return { done: true, value: undefined };
        }
      };
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
