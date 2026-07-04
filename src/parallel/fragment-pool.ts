import { Worker } from 'worker_threads';
import { promises as fs } from 'fs';
import { Config, DEFAULT_CHUNK_SIZE } from '../config.js';
import type { DataChunk } from '../storage/chunk.js';
import { SabArena } from '../storage/sab-arena.js';
import { MorselScheduler } from './morsel-scheduler.js';
import { shareChunk, encodeChunkSet, transportBytes, ChunkSetReader } from './chunk-transport.js';
import { instantiateAggregate } from '../execution/fragment-spec.js';
import type { FragmentSpec, JoinSpec } from '../execution/fragment-spec.js';
import { probeJoinRows, emitsOnUnmatchedProbe, buildJoinOutputChunk } from '../execution/operators/join-core.js';
import type { JoinType } from '../planner/logical-plan.js';
import type { ColumnValue } from '../storage/data-type.js';
import type {
  EncodedChunkSet,
  PartialGroupRecord,
  SpillRef,
  JoinOutputTypes,
  FragmentAggregateRequest,
  FragmentCombineRequest,
  FragmentJoinPartitionRequest,
  FragmentJoinProbeRequest,
  FragmentReplyMessage,
  FragmentSuccessMessage,
} from './worker-messages.js';
import { FragmentTaskType } from './worker-messages.js';

interface SettledValue<T> {
  value: T;
  error?: undefined;
}

interface SettledError {
  value?: undefined;
  error: Error;
}

type Settled<T> = SettledValue<T> | SettledError;

async function* completionOrder<T>(promises: Promise<T>[]): AsyncGenerator<T> {
  const queue: Settled<T>[] = [];
  let notify: (() => void) | null = null;
  for (const promise of promises) {
    promise.then(
      (value: T) => { queue.push({ value }); notify?.(); },
      (error: Error) => { queue.push({ error }); notify?.(); },
    );
  }
  let settled = 0;
  while (settled < promises.length) {
    if (queue.length === 0) {
      await new Promise<void>(resolve => { notify = resolve; });
      notify = null;
    }
    while (queue.length > 0) {
      const item = queue.shift()!;
      settled++;
      if (item.error) throw item.error;
      yield item.value!;
    }
  }
}

interface EncodedTransport {
  shared: DataChunk[];
  encoded: EncodedChunkSet;
}

interface DictBlobEntry {
  lengths: Uint32Array;
  count: number;
  blob: Uint8Array;
  totalBytes: number;
}

function encodeForTransport(chunks: DataChunk[], columnIndexes: number[], arena: SabArena): EncodedTransport {
  const dictCache = new Map<string[], DictBlobEntry>();
  let shared = chunks.map(chunk => shareChunk(chunk, columnIndexes, arena));
  let encoded = encodeChunkSet(shared, columnIndexes, arena, dictCache);
  if (encoded.buffers.length > Config.transportMaxBuffers) {
    shared = chunks.map(chunk => shareChunk(chunk, columnIndexes, arena, true));
    encoded = encodeChunkSet(shared, columnIndexes, arena, dictCache);
  }
  return { shared, encoded };
}

function concatRefs(refArrays: Uint32Array[]): Uint32Array {
  let total = 0;
  for (const refs of refArrays) total += refs.length;
  const merged = new Uint32Array(total);
  let offset = 0;
  for (const refs of refArrays) {
    merged.set(refs, offset);
    offset += refs.length;
  }
  return merged;
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

interface WorkerEntry {
  worker: Worker;
  slot: number;
}

interface PendingRequest {
  expected: number;
  replies: FragmentSuccessMessage[];
  resolve: (replies: FragmentSuccessMessage[]) => void;
  reject: (error: Error) => void;
}

interface RunAggregateOptions {
  byteLimit?: number;
  spillDir?: string | null;
}

interface JoinStreamSide {
  chunks: DataChunk[];
  columnIndexes: number[] | null;
}

interface PoolStats {
  spillFiles: number;
}

export class FragmentPool {
  workerCount: number;
  morselRows: number;
  workers: WorkerEntry[];
  pending: Map<number, PendingRequest>;
  nextReqId: number;
  closed: boolean;
  spillSeq?: number;
  stats?: PoolStats;

  constructor(workerCount = Config.parallelWorkers, morselRows = Config.aggMorselRows) {
    this.workerCount = Math.max(1, workerCount);
    this.morselRows = Math.max(1, morselRows);
    this.workers = [];
    this.pending = new Map();
    this.nextReqId = 1;
    this.closed = false;
  }

  _ensure(): void {
    if (this.closed) throw new Error('FragmentPool is closed');
    while (this.workers.length < this.workerCount) {
      this.workers.push(this._spawn(this.workers.length));
    }
  }

  _spawn(slot: number): WorkerEntry {
    const worker = new Worker(new URL('./fragment-worker.js', import.meta.url));
    const entry: WorkerEntry = { worker, slot };
    worker.on('message', (msg: FragmentReplyMessage) => this._onMessage(msg));
    worker.on('error', (err: Error) => this._failAll(err));
    worker.on('exit', (code: number) => {
      if (this.closed) return;
      this._failAll(new Error(`Fragment worker exited with code ${code}`));
      this.workers[slot] = this._spawn(slot);
    });
    worker.unref();
    return entry;
  }

  _updateRefs(): void {
    const active = this.pending.size > 0;
    for (const entry of this.workers) {
      if (active) entry.worker.ref();
      else entry.worker.unref();
    }
  }

  _settle(reqId: number, settle: () => void): void {
    this.pending.delete(reqId);
    this._updateRefs();
    settle();
  }

  _onMessage(msg: FragmentReplyMessage): void {
    const pending = this.pending.get(msg.reqId);
    if (!pending) return;
    if (msg.ok === false) {
      this._settle(msg.reqId, () => pending.reject(new Error(msg.error)));
      return;
    }
    pending.replies.push(msg);
    if (pending.replies.length === pending.expected) {
      this._settle(msg.reqId, () => pending.resolve(pending.replies));
    }
  }

  _failAll(err: Error): void {
    for (const [reqId, pending] of this.pending) {
      this._settle(reqId, () => pending.reject(err));
    }
  }

  _request(entry: WorkerEntry, payload: FragmentCombineRequest | FragmentJoinProbeRequest): Promise<FragmentSuccessMessage> {
    const reqId = this.nextReqId++;
    return new Promise<FragmentSuccessMessage>((resolve, reject) => {
      this.pending.set(reqId, { expected: 1, replies: [], resolve: (r: FragmentSuccessMessage[]) => resolve(r[0]), reject });
      this._updateRefs();
      entry.worker.postMessage({ ...payload, reqId });
    });
  }

  _broadcast(payload: FragmentAggregateRequest | FragmentJoinPartitionRequest): Promise<FragmentSuccessMessage[]> {
    const reqId = this.nextReqId++;
    return new Promise<FragmentSuccessMessage[]>((resolve, reject) => {
      this.pending.set(reqId, { expected: this.workers.length, replies: [], resolve, reject });
      this._updateRefs();
      for (const entry of this.workers) {
        entry.worker.postMessage({ ...payload, reqId });
      }
    });
  }

  async runAggregate(spec: FragmentSpec, columnIndexes: number[], chunks: DataChunk[], options: RunAggregateOptions = {}): Promise<DataChunk[]> {
    const { byteLimit = Config.parallelAggMemoryBytes, spillDir = null } = options;
    const nonEmpty = chunks.filter(chunk => chunk.size > 0);
    if (nonEmpty.length === 0) {
      return instantiateAggregate(spec).finalize();
    }

    this._ensure();

    const arena = new SabArena();
    const { shared, encoded } = encodeForTransport(nonEmpty, columnIndexes, arena);
    if (byteLimit > 0 && transportBytes(encoded) > byteLimit) return (null as DataChunk[] | null) as DataChunk[];

    const unitsPerMorsel = Math.max(1, Math.round(this.morselRows / DEFAULT_CHUNK_SIZE));
    const scheduler = new MorselScheduler(shared.length, unitsPerMorsel);
    const partitionCount = nextPowerOfTwo(this.workerCount * Math.max(1, Config.aggRadixMultiplier));
    this.spillSeq = (this.spillSeq || 0) + 1;

    const replies = await this._broadcast({
      type: FragmentTaskType.AGGREGATE,
      spec,
      chunks: encoded,
      scheduler: scheduler.descriptor(),
      partitionCount,
      spill: spillDir ? { dir: spillDir, tag: `agg${this.spillSeq}`, groupLimit: Config.aggSpillGroups } : null,
    });

    const spillFiles: string[] = [];
    for (const reply of replies) {
      for (const file of reply.spillFiles || []) spillFiles.push(file);
    }
    this.stats = { spillFiles: spillFiles.length };

    try {
      return await this._combineAndFinalize(spec, replies.map(r => r.partitions!), spillFiles, partitionCount);
    } finally {
      if (spillFiles.length > 0) {
        await Promise.allSettled(spillFiles.map(file => fs.rm(file, { force: true })));
      }
    }
  }

  async _combineAndFinalize(spec: FragmentSpec, perWorkerPartitions: PartialGroupRecord[][][], spillFiles: string[], partitionCount: number): Promise<DataChunk[]> {
    let totalGroups = 0;
    const slices: PartialGroupRecord[][][] = [];
    for (let p = 0; p < partitionCount; p++) {
      const slice: PartialGroupRecord[][] = [];
      for (const partitions of perWorkerPartitions) {
        const part = partitions[p];
        if (part && part.length > 0) {
          slice.push(part);
          totalGroups += part.length;
        }
      }
      slices.push(slice);
    }

    const useWorkerCombine = spillFiles.length > 0
      || (totalGroups >= Config.parallelCombineMinGroups && this.workers.length > 1);

    if (!useWorkerCombine) {
      const finalAggregate = instantiateAggregate(spec);
      for (const slice of slices) {
        for (const part of slice) finalAggregate.absorbPartials(part);
      }
      return finalAggregate.finalize();
    }

    const merged: PartialGroupRecord[][] = await Promise.all(slices.map((slice, p): Promise<PartialGroupRecord[]> => {
      const spillRefs: SpillRef[] = spillFiles.map(file => ({ file, partition: p }));
      if (slice.length === 0 && spillRefs.length === 0) return Promise.resolve([]);
      if (slice.length === 1 && spillRefs.length === 0) return Promise.resolve(slice[0]);
      return this._request(this.workers[p % this.workers.length], { type: FragmentTaskType.COMBINE, spec, partials: slice, spillRefs })
        .then(reply => reply.partials as PartialGroupRecord[]);
    }));

    const out: DataChunk[] = [];
    for (const partials of merged) {
      if (partials.length === 0) continue;
      const aggregate = instantiateAggregate(spec);
      aggregate.absorbPartials(partials);
      out.push(...await aggregate.finalize());
    }
    if (out.length === 0) {
      return instantiateAggregate(spec).finalize();
    }
    return out;
  }

  async *runJoinStream(spec: JoinSpec, buildSide: JoinStreamSide, probeSide: JoinStreamSide, outputTypes: JoinOutputTypes): AsyncGenerator<DataChunk> {
    this._ensure();

    const arena = new SabArena();
    const prepare = (side: JoinStreamSide): EncodedTransport => {
      const nonEmpty = side.chunks.filter(chunk => chunk.size > 0);
      const columnIndexes = side.columnIndexes
        ?? (nonEmpty.length > 0 ? nonEmpty[0].columns.map((_, i) => i) : []);
      return encodeForTransport(nonEmpty, columnIndexes, arena);
    };
    const { shared: sharedBuild, encoded: encodedBuild } = prepare(buildSide);
    const { shared: sharedProbe, encoded: encodedProbe } = prepare(probeSide);

    const unitsPerMorsel = Math.max(1, Math.round(this.morselRows / DEFAULT_CHUNK_SIZE));
    const buildScheduler = new MorselScheduler(sharedBuild.length, unitsPerMorsel);
    const probeScheduler = new MorselScheduler(sharedProbe.length, unitsPerMorsel);
    const partitionCount = nextPowerOfTwo(this.workerCount * Math.max(1, Config.aggRadixMultiplier));

    const replies = await this._broadcast({
      type: FragmentTaskType.JOIN_PARTITION,
      spec,
      buildChunks: encodedBuild,
      probeChunks: encodedProbe,
      buildScheduler: buildScheduler.descriptor(),
      probeScheduler: probeScheduler.descriptor(),
      partitionCount,
    });

    let hasNullKey = false;
    for (const reply of replies) {
      if (reply.buildNullCount! > 0) hasNullKey = true;
    }

    const nullItems: { row: ColumnValue[]; key: ColumnValue }[] = [];
    for (const reply of replies) {
      for (const row of reply.probeNullRows!) nullItems.push({ row, key: null });
    }
    if (nullItems.length > 0) {
      const nullRows = probeJoinRows(nullItems, () => null, {
        joinType: spec.joinType as JoinType,
        buildColCount: spec.buildColCount,
        probeColCount: spec.probeColCount,
        conditionEvaluator: null,
        hasNullKey,
      } as Parameters<typeof probeJoinRows>[2]);
      for (let offset = 0; offset < nullRows.length; offset += DEFAULT_CHUNK_SIZE) {
        yield buildJoinOutputChunk(nullRows.slice(offset, offset + DEFAULT_CHUNK_SIZE), {
          joinType: spec.joinType as JoinType,
          buildColCount: spec.buildColCount,
          buildSchema: outputTypes.build,
          probeSchema: outputTypes.probe,
        });
      }
    }

    if (spec.buildPreserved) {
      const buildNullRows: ColumnValue[][] = [];
      for (const reply of replies) {
        for (const row of reply.buildNullRows || []) buildNullRows.push(row.concat(new Array(spec.probeColCount).fill(null)));
      }
      for (let offset = 0; offset < buildNullRows.length; offset += DEFAULT_CHUNK_SIZE) {
        yield buildJoinOutputChunk(buildNullRows.slice(offset, offset + DEFAULT_CHUNK_SIZE), {
          joinType: spec.joinType as JoinType,
          buildColCount: spec.buildColCount,
          buildSchema: outputTypes.build,
          probeSchema: outputTypes.probe,
        });
      }
    }

    const tasks: Promise<FragmentSuccessMessage>[] = [];
    for (let p = 0; p < partitionCount; p++) {
      const buildRefs = concatRefs(replies.map(r => r.buildPartitions![p]));
      const probeRefs = concatRefs(replies.map(r => r.probePartitions![p]));
      const needProbe = probeRefs.length > 0 && (buildRefs.length > 0 || emitsOnUnmatchedProbe(spec.joinType as JoinType));
      const needBuild = buildRefs.length > 0 && spec.buildPreserved;
      if (!needProbe && !needBuild) continue;
      const worker = this.workers[tasks.length % this.workers.length];
      tasks.push(this._request(worker, {
        type: FragmentTaskType.JOIN_PROBE,
        spec,
        buildChunks: encodedBuild,
        probeChunks: encodedProbe,
        buildRefs,
        probeRefs: needProbe ? probeRefs : new Uint32Array(0),
        hasNullKey,
        outputTypes,
      }));
    }

    for await (const result of completionOrder(tasks)) {
      if (!result.chunks) continue;
      const reader = new ChunkSetReader(result.chunks);
      for (let i = 0; i < reader.count; i++) {
        const chunk = reader.chunk(i);
        if (chunk.size > 0) yield chunk;
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const workers = this.workers;
    this.workers = [];
    this._failAll(new Error('FragmentPool closed'));
    await Promise.all(workers.map(entry => entry.worker.terminate()));
  }
}
