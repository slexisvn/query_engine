import { parentPort, threadId } from 'worker_threads';
import path from 'path';
import { MorselScheduler } from './morsel-scheduler.js';
import { writePartialSpill, readPartialSpill } from './partial-spill.js';
import { ChunkSetReader, encodeChunkSet } from './chunk-transport.js';
import { SabArena } from '../storage/sab-arena.js';
import { DEFAULT_CHUNK_SIZE } from '../config.js';
import type { DataChunk } from '../storage/chunk.js';
import type { ColumnValue } from '../storage/data-type.js';
import type { JoinKey } from '../execution/operators/join-core.js';
import { createKeyedHashTable, NO_ENTRY } from '../execution/hash-table.js';
import { instantiateFragment, instantiateAggregate, instantiateJoinSpec } from '../execution/fragment-spec.js';
import { createVectorAggregator } from '../execution/operators/vector-aggregate.js';
import type { FilterOperator } from '../execution/operators/filter.js';
import type { ProjectionOperator } from '../execution/operators/projection.js';
import type { CompiledExpr } from '../execution/execution-types.js';
import {
  joinKeyOf,
  joinKeyHash,
  joinKeyValues,
  probeJoinInto,
  materializeRow,
  JoinOutputBuffer,
} from '../execution/operators/join-core.js';
import type { JoinType } from '../planner/logical-plan.js';
import type {
  FragmentAggregateRequest,
  FragmentCombineRequest,
  FragmentJoinPartitionRequest,
  FragmentJoinProbeRequest,
  FragmentRequestMessage,
  FragmentAggregateResult,
  FragmentCombineResult,
  FragmentJoinPartitionResult,
  FragmentJoinProbeResult,
  FragmentReplyMessage,
  PartialGroupRecord,
  MorselSchedulerDescriptor,
} from './worker-messages.js';

type FragmentOperator = FilterOperator | ProjectionOperator;
type JoinRow = ColumnValue[];

interface BuildItemWithIndex {
  row: JoinRow;
  idx: number;
}

async function handleAggregate({ spec, chunks, scheduler: schedulerDescriptor, partitionCount, spill }: FragmentAggregateRequest): Promise<FragmentAggregateResult> {
  const { operators, aggregate } = instantiateFragment(spec);
  const vector = createVectorAggregator(spec);
  let vectorActive = !!vector;
  const scheduler = MorselScheduler.attach(schedulerDescriptor);
  const reader = new ChunkSetReader(chunks);
  const spillFiles: string[] = [];

  const groupCount = (): number => vectorActive ? vector!.groupCount : aggregate.groups.size;
  const exportPartitions = (): PartialGroupRecord[][] => (vectorActive ? vector! : aggregate).exportPartials(partitionCount);
  const resetGroups = (): void => vectorActive ? vector!.clear() : aggregate.groups.clear();

  const maybeSpill = (): void => {
    if (!spill || groupCount() <= spill.groupLimit) return;
    const file = path.join(spill.dir, `${spill.tag}_${threadId}_${spillFiles.length}.partials`);
    writePartialSpill(file, exportPartitions());
    spillFiles.push(file);
    resetGroups();
  };

  for (const { start, end } of scheduler.drain()) {
    for (let i = start; i < end; i++) {
      let chunk: DataChunk | null = reader.chunk(i);
      for (const op of operators) {
        if (!chunk || chunk.size === 0) break;
        chunk = await op.process(chunk);
      }
      if (!chunk || chunk.size === 0) continue;
      if (vectorActive && !vector!.consume(chunk)) {
        aggregate.absorbPartials(vector!.exportPartials(1)[0]);
        vectorActive = false;
      }
      if (!vectorActive) {
        await aggregate.consume(chunk);
      }
      maybeSpill();
    }
  }

  return { partitions: exportPartitions(), spillFiles };
}

async function handleCombine({ spec, partials, spillRefs }: FragmentCombineRequest): Promise<FragmentCombineResult> {
  const aggregate = instantiateAggregate(spec);
  for (const partialSet of partials) {
    aggregate.absorbPartials(partialSet);
  }
  for (const ref of spillRefs || []) {
    const partialSet = readPartialSpill(ref.file, ref.partition);
    if (partialSet.length > 0) aggregate.absorbPartials(partialSet);
  }
  return { partials: aggregate.exportPartials(1)[0] };
}

class StagedReader {
  reader: ChunkSetReader;
  operators: FragmentOperator[];
  cache: Map<number, DataChunk>;

  constructor(reader: ChunkSetReader, operators: FragmentOperator[]) {
    this.reader = reader;
    this.operators = operators;
    this.cache = new Map();
  }

  get count(): number {
    return this.reader.count;
  }

  async chunk(index: number): Promise<DataChunk> {
    let chunk = this.cache.get(index);
    if (chunk === undefined) {
      chunk = this.reader.chunk(index);
      for (const op of this.operators) {
        if (!chunk || chunk.size === 0) break;
        chunk = await op.process(chunk);
      }
      this.cache.set(index, chunk);
    }
    return chunk;
  }
}

interface PartitionRefsResult {
  partitions: Uint32Array[];
  nullCount: number;
}

async function partitionRefs(reader: StagedReader, extractors: CompiledExpr[], schedulerDescriptor: MorselSchedulerDescriptor, partitionCount: number, nullRows: JoinRow[] | null): Promise<PartitionRefsResult> {
  const scheduler = MorselScheduler.attach(schedulerDescriptor);
  const mask = partitionCount - 1;
  const keyScratch: ColumnValue[] = [null];
  const partitions: number[][] = Array.from({ length: partitionCount }, () => []);
  let nullCount = 0;

  for (const { start, end } of scheduler.drain()) {
    for (let ci = start; ci < end; ci++) {
      const chunk = await reader.chunk(ci);
      if (!chunk || chunk.size === 0) continue;
      for (let r = 0; r < chunk.size; r++) {
        const physical = chunk.activeRowIndex(r);
        const key = joinKeyOf(extractors, chunk, physical);
        if (key === null) {
          nullCount++;
          if (nullRows) nullRows.push(materializeRow(chunk, physical));
          continue;
        }
        partitions[joinKeyHash(key, keyScratch) & mask].push(ci, r);
      }
    }
  }

  return {
    partitions: partitions.map(refs => Uint32Array.from(refs)),
    nullCount,
  };
}

async function handleJoinPartition({ spec, buildChunks, probeChunks, buildScheduler, probeScheduler, partitionCount }: FragmentJoinPartitionRequest): Promise<FragmentJoinPartitionResult> {
  const join = instantiateJoinSpec(spec);
  const buildReader = new StagedReader(new ChunkSetReader(buildChunks), join.buildOperators);
  const probeReader = new StagedReader(new ChunkSetReader(probeChunks), join.probeOperators);
  const probeNullRows: JoinRow[] = [];
  const buildNullRows: JoinRow[] | null = spec.buildPreserved ? [] : null;
  const build = await partitionRefs(buildReader, join.buildExtractors, buildScheduler, partitionCount, buildNullRows);
  const probe = await partitionRefs(probeReader, join.probeExtractors, probeScheduler, partitionCount, probeNullRows);
  return {
    buildPartitions: build.partitions,
    buildNullCount: build.nullCount,
    probePartitions: probe.partitions,
    probeNullRows,
    buildNullRows: buildNullRows || [],
  };
}

async function handleJoinProbe({ spec, buildChunks, probeChunks, buildRefs, probeRefs, hasNullKey, outputTypes }: FragmentJoinProbeRequest): Promise<FragmentJoinProbeResult> {
  const {
    buildOperators, probeOperators, buildExtractors, probeExtractors, conditionEvaluator, buildColCount, probeColCount,
  } = instantiateJoinSpec(spec);
  const buildCache = new StagedReader(new ChunkSetReader(buildChunks), buildOperators);
  const probeCache = new StagedReader(new ChunkSetReader(probeChunks), probeOperators);

  const refCount = buildRefs.length / 2;
  const keyScratch: ColumnValue[] = [null];
  const hashTable = createKeyedHashTable(buildExtractors.length);
  const buckets: BuildItemWithIndex[][] = [];
  const matched = new Uint8Array(refCount);
  const buildRows: JoinRow[] = new Array(refCount);

  for (let i = 0; i < refCount; i++) {
    const chunk = (await buildCache.chunk(buildRefs[2 * i]))!;
    const physical = chunk.activeRowIndex(buildRefs[2 * i + 1]);
    const key = joinKeyOf(buildExtractors, chunk, physical);
    const row = materializeRow(chunk, physical);
    buildRows[i] = row;

    if (key === null) continue;
    const entry = hashTable.findOrInsert(joinKeyValues(key, keyScratch));
    let bucket = buckets[entry];
    if (spec.uniqueKeys && bucket) continue;
    if (!bucket) {
      bucket = [];
      buckets[entry] = bucket;
    }
    bucket.push({ row, idx: i });
  }

  const items: ProbeItem[] = new Array(probeRefs.length / 2);
  for (let i = 0; i < probeRefs.length; i += 2) {
    const chunk = (await probeCache.chunk(probeRefs[i]))!;
    const physical = chunk.activeRowIndex(probeRefs[i + 1]);
    items[i / 2] = {
      row: materializeRow(chunk, physical),
      key: joinKeyOf(probeExtractors, chunk, physical),
    };
  }

  const lookup = (key: JoinKey) => {
    const entry = hashTable.find(joinKeyValues(key, keyScratch));
    return entry === NO_ENTRY ? null : (buckets[entry] || null);
  };
  const output = new JoinOutputBuffer({
    joinType: spec.joinType as JoinType,
    buildColCount,
    probeColCount,
    buildSchema: outputTypes.build,
    probeSchema: outputTypes.probe,
  });
  probeJoinInto(items, lookup, {
    joinType: spec.joinType as JoinType,
    buildColCount,
    probeColCount,
    conditionEvaluator: conditionEvaluator as Parameters<typeof probeJoinInto>[2]['conditionEvaluator'],
    hasNullKey,
    onMatched: (item: BuildItemWithIndex) => { matched[item.idx] = 1; },
  }, output);

  if (spec.buildPreserved) {
    for (let i = 0; i < refCount; i++) {
      if (!matched[i]) output.push(buildRows[i], null);
    }
  }

  if (output.length === 0) return { chunks: null };

  const arena = new SabArena();
  const outChunks: DataChunk[] = [...output.chunks(DEFAULT_CHUNK_SIZE, arena)];
  const columnIndexes = outChunks[0].columns.map((_, i) => i);
  return { chunks: encodeChunkSet(outChunks, columnIndexes, arena) };
}

interface ProbeItem {
  row: JoinRow;
  key: JoinKey;
}

const HANDLERS = {
  aggregate: handleAggregate,
  combine: handleCombine,
  joinPartition: handleJoinPartition,
  joinProbe: handleJoinProbe,
};

parentPort!.on('message', async (msg: FragmentRequestMessage) => {
  const handler = HANDLERS[msg.type];
  if (!handler) {
    const failure: FragmentReplyMessage = { reqId: msg.reqId, ok: false, error: `Unknown fragment task: ${msg.type}` };
    parentPort!.postMessage(failure);
    return;
  }
  try {
    const result = await handler(msg as FragmentAggregateRequest & FragmentCombineRequest & FragmentJoinPartitionRequest & FragmentJoinProbeRequest);
    const reply: FragmentReplyMessage = { reqId: msg.reqId, ok: true, ...result };
    parentPort!.postMessage(reply);
  } catch (err) {
    const failure: FragmentReplyMessage = { reqId: msg.reqId, ok: false, error: (err as Error).stack || (err as Error).message };
    parentPort!.postMessage(failure);
  }
});
