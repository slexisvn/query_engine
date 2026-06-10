import { parentPort, threadId } from 'worker_threads';
import path from 'path';
import { MorselScheduler } from './morsel-scheduler.js';
import { writePartialSpill, readPartialSpill } from './partial-spill.js';
import { ChunkSetReader, encodeChunkSet } from './chunk-transport.js';
import { SabArena } from '../storage/sab-arena.js';
import { DEFAULT_CHUNK_SIZE } from '../storage/chunk.js';
import { instantiateFragment, instantiateAggregate, instantiateJoinSpec } from '../execution/fragment-spec.js';
import { createVectorAggregator } from '../execution/operators/vector-aggregate.js';
import {
  joinKeyOf,
  joinKeyHash,
  probeJoinRows,
  emitsUnmatchedBuild,
  materializeRow,
  buildJoinOutputChunk,
} from '../execution/operators/join-core.js';

async function handleAggregate({ spec, chunks, scheduler: schedulerDescriptor, partitionCount, spill }) {
  const { operators, aggregate } = instantiateFragment(spec);
  const vector = createVectorAggregator(spec);
  let vectorActive = !!vector;
  const scheduler = MorselScheduler.attach(schedulerDescriptor);
  const reader = new ChunkSetReader(chunks);
  const spillFiles = [];

  const groupCount = () => vectorActive ? vector.groupCount : aggregate.groups.size;
  const exportPartitions = () => (vectorActive ? vector : aggregate).exportPartials(partitionCount);
  const resetGroups = () => vectorActive ? vector.clear() : aggregate.groups.clear();

  const maybeSpill = () => {
    if (!spill || groupCount() <= spill.groupLimit) return;
    const file = path.join(spill.dir, `${spill.tag}_${threadId}_${spillFiles.length}.partials`);
    writePartialSpill(file, exportPartitions());
    spillFiles.push(file);
    resetGroups();
  };

  for (const { start, end } of scheduler.drain()) {
    for (let i = start; i < end; i++) {
      let chunk = reader.chunk(i);
      for (const op of operators) {
        if (!chunk || chunk.size === 0) break;
        chunk = await op.process(chunk);
      }
      if (!chunk || chunk.size === 0) continue;
      if (vectorActive && !vector.consume(chunk)) {
        aggregate.absorbPartials(vector.exportPartials(1)[0]);
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

async function handleCombine({ spec, partials, spillRefs }) {
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
  constructor(reader, operators) {
    this.reader = reader;
    this.operators = operators;
    this.cache = new Map();
  }

  get count() {
    return this.reader.count;
  }

  async chunk(index) {
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

async function partitionRefs(reader, extractors, schedulerDescriptor, partitionCount, nullRows) {
  const scheduler = MorselScheduler.attach(schedulerDescriptor);
  const mask = partitionCount - 1;
  const partitions = Array.from({ length: partitionCount }, () => []);
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
        partitions[joinKeyHash(key) & mask].push(ci, r);
      }
    }
  }

  return {
    partitions: partitions.map(refs => Uint32Array.from(refs)),
    nullCount,
  };
}

async function handleJoinPartition({ spec, buildChunks, probeChunks, buildScheduler, probeScheduler, partitionCount }) {
  const join = instantiateJoinSpec(spec);
  const buildReader = new StagedReader(new ChunkSetReader(buildChunks), join.buildOperators);
  const probeReader = new StagedReader(new ChunkSetReader(probeChunks), join.probeOperators);
  const probeNullRows = [];
  const build = await partitionRefs(buildReader, join.buildExtractors, buildScheduler, partitionCount, null);
  const probe = await partitionRefs(probeReader, join.probeExtractors, probeScheduler, partitionCount, probeNullRows);
  return {
    buildPartitions: build.partitions,
    buildNullCount: build.nullCount,
    probePartitions: probe.partitions,
    probeNullRows,
  };
}

async function handleJoinProbe({ spec, buildChunks, probeChunks, buildRefs, probeRefs, hasNullKey, outputTypes }) {
  const { buildOperators, probeOperators, buildExtractors, probeExtractors, conditionEvaluator } = instantiateJoinSpec(spec);
  const buildCache = new StagedReader(new ChunkSetReader(buildChunks), buildOperators);
  const probeCache = new StagedReader(new ChunkSetReader(probeChunks), probeOperators);

  const refCount = buildRefs.length / 2;
  const hashTable = new Map();
  const matched = new Uint8Array(refCount);
  const buildRows = new Array(refCount);

  for (let i = 0; i < refCount; i++) {
    const chunk = await buildCache.chunk(buildRefs[2 * i]);
    const physical = chunk.activeRowIndex(buildRefs[2 * i + 1]);
    const key = joinKeyOf(buildExtractors, chunk, physical);
    const row = materializeRow(chunk, physical);
    buildRows[i] = row;

    let bucket = hashTable.get(key);
    if (spec.uniqueKeys && bucket) continue;
    if (!bucket) {
      bucket = [];
      hashTable.set(key, bucket);
    }
    bucket.push({ row, idx: i });
  }

  const items = new Array(probeRefs.length / 2);
  for (let i = 0; i < probeRefs.length; i += 2) {
    const chunk = await probeCache.chunk(probeRefs[i]);
    const physical = chunk.activeRowIndex(probeRefs[i + 1]);
    items[i / 2] = {
      row: materializeRow(chunk, physical),
      key: joinKeyOf(probeExtractors, chunk, physical),
    };
  }

  const rows = probeJoinRows(items, (key) => hashTable.get(key) || null, {
    joinType: spec.joinType,
    buildColCount: spec.buildColCount,
    probeColCount: spec.probeColCount,
    conditionEvaluator,
    hasNullKey,
    onMatched: (item) => { matched[item.idx] = 1; },
  });

  if (emitsUnmatchedBuild(spec.joinType)) {
    for (let i = 0; i < refCount; i++) {
      if (!matched[i]) {
        rows.push(buildRows[i].concat(new Array(spec.probeColCount).fill(null)));
      }
    }
  }

  if (rows.length === 0) return { chunks: null };

  const arena = new SabArena();
  const outChunks = [];
  for (let offset = 0; offset < rows.length; offset += DEFAULT_CHUNK_SIZE) {
    outChunks.push(buildJoinOutputChunk(rows.slice(offset, offset + DEFAULT_CHUNK_SIZE), {
      joinType: spec.joinType,
      buildColCount: spec.buildColCount,
      buildSchema: outputTypes.build,
      probeSchema: outputTypes.probe,
    }, arena));
  }
  const columnIndexes = outChunks[0].columns.map((_, i) => i);
  return { chunks: encodeChunkSet(outChunks, columnIndexes, arena) };
}

const HANDLERS = {
  aggregate: handleAggregate,
  combine: handleCombine,
  joinPartition: handleJoinPartition,
  joinProbe: handleJoinProbe,
};

parentPort.on('message', async (msg) => {
  const handler = HANDLERS[msg.type];
  if (!handler) {
    parentPort.postMessage({ reqId: msg.reqId, ok: false, error: `Unknown fragment task: ${msg.type}` });
    return;
  }
  try {
    const result = await handler(msg);
    parentPort.postMessage({ reqId: msg.reqId, ok: true, ...result });
  } catch (err) {
    parentPort.postMessage({ reqId: msg.reqId, ok: false, error: err.stack || err.message });
  }
});
