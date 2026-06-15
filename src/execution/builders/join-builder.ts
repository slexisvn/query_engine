import { JoinType, PhysicalStrategy } from '../../planner/logical-plan.js';
import { compileExpression } from '../expression-eval.js';
import { extractJoinKeys } from '../join-utils.js';
import { HashJoinBuild, HashJoinProbe } from '../operators/hash-join.js';
import { MergeJoinOperator } from '../operators/merge-join.js';
import { NestedLoopJoinOperator } from '../operators/nested-loop-join.js';
import {
  extractStageChain,
  buildJoinSpec,
  stagedSchemaOf,
  schemasEqual,
  plainSchemaOf,
} from '../fragment-spec.js';
import { Config } from '../../config.js';
import { combinedMappingOf, registerBufferedChild } from './builder-utils.js';

export async function buildJoin(executor: any, node: any): Promise<any> {
  const left = await executor.buildPipeline(node.children[0]);
  const right = await executor.buildPipeline(node.children[1]);

  const isSemiAnti = node.joinType === JoinType.SEMI || node.joinType === JoinType.ANTI;
  const isMark = node.joinType === JoinType.MARK;
  let buildInput: any, probeInput: any, buildNode: any, probeNode: any;
  if (isSemiAnti || isMark || node._buildSide === 'right') {
    buildInput = right;
    probeInput = left;
    buildNode = node.children[1];
    probeNode = node.children[0];
  } else {
    buildInput = left;
    probeInput = right;
    buildNode = node.children[0];
    probeNode = node.children[1];
  }

  const combinedSchema = [...buildInput.schema, ...probeInput.schema];
  const combinedMapping = combinedMappingOf(buildInput.schema, probeInput.schema);

  const { buildKeys, probeKeys, residualCondition } = extractJoinKeys(
    node.condition, buildInput.columnMapping, probeInput.columnMapping
  );

  const buildPreserved = node.joinType === JoinType.FULL
    || (node.joinType === JoinType.LEFT && buildNode === node.children[0]);

  const conditionEvaluator = residualCondition
    ? compileExpression(residualCondition, combinedMapping)
    : null;

  const markSchema = isMark
    ? [...left.schema, { name: node.markColumn || '__mark', dataType: 'BOOLEAN', tableAlias: '' }]
    : null;
  const resultSchema = isSemiAnti ? left.schema : isMark ? markSchema : combinedSchema;
  const resultMapping = isSemiAnti
    ? left.columnMapping
    : isMark
      ? executor.buildSchemaMapping(markSchema, '')
      : combinedMapping;

  if (node.physicalStrategy === PhysicalStrategy.MERGE) {
    return buildMergeJoin(node, {
      left, right, buildInput, probeInput,
      buildKeys, probeKeys, conditionEvaluator,
      resultSchema, resultMapping,
    });
  }

  if (node.physicalStrategy === PhysicalStrategy.NESTED_LOOP) {
    return buildNestedLoopJoin(node, {
      left, right, buildInput, probeInput,
      isSemiAnti, isMark, markSchema,
    });
  }

  const joinSpillHandle = executor.tempManager.allocate('spill', 'join');
  const makeBuildSide = () => new HashJoinBuild(
    buildKeys.map((k: any) => compileExpression(k, buildInput.columnMapping)),
    node.joinType,
    !!node._dedupeBuild && !conditionEvaluator,
    executor.storageBackend.createSpillManager(joinSpillHandle),
    buildPreserved,
  );
  const makeProbeOp = (buildSide: any) => new HashJoinProbe(
    buildSide,
    probeKeys.map((k: any) => compileExpression(k, probeInput.columnMapping)),
    buildInput.schema.length,
    probeInput.schema.length,
    node.joinType,
    conditionEvaluator
  );

  const serialCompiled = {
    schema: resultSchema,
    columnMapping: resultMapping,
    register: (graph: any, currentPipelineId: any, currentSink: any) => {
      const buildSide = makeBuildSide();

      const buildSink = {
        async consume(chunk: any) { await buildSide.consume(chunk); },
        async finalize() { await buildSide.finalize(); }
      };
      const buildPipelineId = graph.createPipeline(buildSink);
      buildInput.register(graph, buildPipelineId, buildSink);

      const probeOp = makeProbeOp(buildSide);

      const probeSink = {
        get cancelToken() { return currentSink.cancelToken; },
        async consume(chunk: any) {
          if (this.cancelToken?.isCancelled) return;
          const result = await probeOp.process(chunk);
          if (result && result.size > 0) {
            await currentSink.consume(result);
          }
        },
        async finalize() {
          if (buildPreserved) {
            const unmatchedRows = buildSide.emitUnmatched(probeInput.schema.length);
            if (unmatchedRows.length > 0) {
              await currentSink.consume(probeOp.buildOutputChunk(unmatchedRows));
            }
          }
          if (probeOp.finalize) {
            await probeOp.finalize(currentSink);
          }
          if (currentSink.finalize) await currentSink.finalize();
        }
      };

      graph.addDependency(currentPipelineId, buildPipelineId);
      probeInput.register(graph, currentPipelineId, probeSink);
    }
  };

  const parallelJoin = executor._prepareParallelJoin(
    node, buildInput, probeInput, buildNode, probeNode,
    buildKeys, probeKeys, residualCondition, combinedMapping
  );
  if (!parallelJoin) return serialCompiled;

  return {
    schema: resultSchema,
    columnMapping: resultMapping,
    register: (graph: any, currentPipelineId: any, currentSink: any) => {
      const registerSide = (side: any, input: any) =>
        side.storage ? null : registerBufferedChild(graph, currentPipelineId, input);
      const bufferedBuild = registerSide(parallelJoin.buildSide, buildInput);
      const bufferedProbe = registerSide(parallelJoin.probeSide, probeInput);

      graph.setSource(currentPipelineId, async function* () {
        const collect = async (side: any, buffered: any) => {
          if (!side.storage) return buffered;
          const chunks: any[] = [];
          for await (const chunk of side.storage.scan()) chunks.push(chunk);
          return chunks;
        };
        const buildChunks = await collect(parallelJoin.buildSide, bufferedBuild);
        const probeChunks = await collect(parallelJoin.probeSide, bufferedProbe);

        const countRows = (chunks: any) => chunks.reduce((sum: any, c: any) => sum + c.size, 0);
        const buildRows = countRows(buildChunks);
        const probeRows = countRows(probeChunks);
        const eligible = buildRows + probeRows >= Config.parallelJoinThreshold
          && buildRows <= Config.memoryLimit;

        const emitSerial = async function* () {
          const bothBuffered = bufferedBuild !== null && bufferedProbe !== null;
          const resultChunks = bothBuffered
            ? await executor._runBufferedSerialJoin(makeBuildSide, makeProbeOp, buildChunks, probeChunks, node, probeInput.schema.length)
            : await executor._executeSubPipeline(serialCompiled);
          for (const chunk of resultChunks) {
            if (!chunk || chunk.size === 0) continue;
            await currentSink.consume(chunk);
            yield chunk;
          }
        };

        if (!eligible) {
          yield* emitSerial();
          if (currentSink.finalize) await currentSink.finalize();
          return;
        }

        const typesOf = (side: any, chunks: any) => {
          if (side.storage) return side.spec.schema.map((col: any) => col.dataType);
          const first = chunks.find((c: any) => c.size > 0);
          if (first) return first.columns.map((col: any) => col.dataType);
          return side.spec.schema.map((col: any) => col.dataType);
        };
        const outputTypes = {
          build: typesOf(parallelJoin.buildSide, buildChunks),
          probe: typesOf(parallelJoin.probeSide, probeChunks),
        };

        let emitted = false;
        try {
          const stream = executor.fragmentPool.runJoinStream(
            parallelJoin.spec,
            { chunks: buildChunks, columnIndexes: parallelJoin.buildSide.columnIndexes },
            { chunks: probeChunks, columnIndexes: parallelJoin.probeSide.columnIndexes },
            outputTypes,
          );
          for await (const chunk of stream) {
            if (chunk.size === 0) continue;
            await currentSink.consume(chunk);
            yield chunk;
            emitted = true;
          }
        } catch (err) {
          if (emitted) throw err;
          yield* emitSerial();
        }
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };
}

function buildMergeJoin(node: any, ctx: any): any {
  const { left, right, buildInput, probeInput, conditionEvaluator } = ctx;
  let mergeBuild = buildInput;
  let mergeProbe = probeInput;
  let mergeBuildKeys = ctx.buildKeys;
  let mergeProbeKeys = ctx.probeKeys;
  let mergeSchema = ctx.resultSchema;
  let mergeMapping = ctx.resultMapping;
  if (node.joinType === JoinType.LEFT && buildInput !== left) {
    mergeBuild = left;
    mergeProbe = right;
    mergeBuildKeys = ctx.probeKeys;
    mergeProbeKeys = ctx.buildKeys;
    mergeSchema = [...left.schema, ...right.schema];
    mergeMapping = combinedMappingOf(left.schema, right.schema);
  } else if (node.joinType === JoinType.RIGHT && buildInput !== right) {
    mergeBuild = right;
    mergeProbe = left;
    mergeBuildKeys = ctx.probeKeys;
    mergeProbeKeys = ctx.buildKeys;
    mergeSchema = [...right.schema, ...left.schema];
    mergeMapping = combinedMappingOf(right.schema, left.schema);
  }
  return {
    schema: mergeSchema,
    columnMapping: mergeMapping,
    register: (graph: any, currentPipelineId: any, currentSink: any) => {
      const leftChunks = registerBufferedChild(graph, currentPipelineId, left);
      const rightChunks = registerBufferedChild(graph, currentPipelineId, right);

      graph.setSource(currentPipelineId, async function* () {
        const mergeJoin = new MergeJoinOperator(
          mergeBuild === left ? leftChunks : rightChunks,
          mergeProbe === left ? leftChunks : rightChunks,
          mergeBuildKeys.map((k: any) => compileExpression(k, mergeBuild.columnMapping)),
          mergeProbeKeys.map((k: any) => compileExpression(k, mergeProbe.columnMapping)),
          mergeBuild.schema.length,
          mergeProbe.schema.length,
          node.joinType,
          conditionEvaluator
        );

        const resultChunks = await mergeJoin.execute();
        for (const chunk of resultChunks) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };
}

function buildNestedLoopJoin(node: any, ctx: any): any {
  const { left, right, buildInput, probeInput, isSemiAnti, isMark, markSchema } = ctx;
  const nlOuter = buildInput === left ? buildInput : probeInput;
  const nlInner = buildInput === left ? probeInput : buildInput;
  const nlMapping = combinedMappingOf(nlOuter.schema, nlInner.schema);
  const nlCondition = node.condition
    ? compileExpression(node.condition, nlMapping)
    : null;
  const nlSchema = [...nlOuter.schema, ...nlInner.schema];
  const nlResultMapping = isSemiAnti ? left.columnMapping : nlMapping;
  const nlResultSchema = isSemiAnti ? left.schema : isMark ? markSchema : nlSchema;
  return {
    schema: nlResultSchema,
    columnMapping: nlResultMapping,
    register: (graph: any, currentPipelineId: any, currentSink: any) => {
      const leftChunks = registerBufferedChild(graph, currentPipelineId, left);
      const rightChunks = registerBufferedChild(graph, currentPipelineId, right);

      graph.setSource(currentPipelineId, async function* () {
        const nlJoin = new NestedLoopJoinOperator(
          nlOuter === left ? leftChunks : rightChunks,
          nlInner === left ? leftChunks : rightChunks,
          nlOuter.schema.length,
          nlInner.schema.length,
          node.joinType,
          nlCondition
        );
        const resultChunks = await nlJoin.execute();
        for (const chunk of resultChunks) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };
}

export function prepareParallelJoin(executor: any, node: any, buildInput: any, probeInput: any, buildNode: any, probeNode: any, buildKeys: any, probeKeys: any, residualCondition: any, combinedMapping: any): any {
  if (!executor.fragmentPool) return null;
  if (buildKeys.length === 0 || node.joinType === JoinType.CROSS) return null;
  if (executor._estimatePlanRows(node) < Config.parallelJoinThreshold) return null;

  const buildSide = prepareJoinSide(executor, buildNode, buildInput);
  const probeSide = prepareJoinSide(executor, probeNode, probeInput);

  const buildPreserved = node.joinType === JoinType.FULL
    || (node.joinType === JoinType.LEFT && buildNode === node.children[0]);

  const spec = buildJoinSpec({
    build: buildSide.spec,
    probe: probeSide.spec,
    buildKeys,
    probeKeys,
    residualCondition,
    joinType: node.joinType,
    buildPreserved,
    uniqueKeys: !!node._dedupeBuild && !residualCondition,
    buildMapping: buildInput.columnMapping,
    probeMapping: probeInput.columnMapping,
    combinedMapping,
  });
  if (!spec) return null;
  return { spec, buildSide, probeSide };
}

function prepareJoinSide(executor: any, planNode: any, input: any): any {
  const sideSchema = plainSchemaOf(input.schema);
  const buffered = {
    spec: { schema: sideSchema, baseSchema: sideSchema, stages: [] },
    storage: null,
    columnIndexes: null,
  };

  const fragment = planNode ? extractStageChain(planNode) : null;
  if (!fragment) return buffered;
  const storage = executor.catalog.getTableStorage(fragment.table);
  if (!storage || typeof storage.scan !== 'function') return buffered;

  const storageSchema = storage.getSchema();
  const projected = executor.resolveProjectedColumnIndexes(storageSchema, fragment.scanColumns);
  const columnIndexes = projected || storageSchema.map((_: any, i: any) => i);
  const baseSchema = columnIndexes.map((i: any) => ({
    name: storageSchema[i].name,
    dataType: storageSchema[i].dataType,
    tableAlias: fragment.alias,
  }));
  if (!schemasEqual(stagedSchemaOf(baseSchema, fragment.stages), sideSchema)) return buffered;

  return {
    spec: { schema: sideSchema, baseSchema, stages: fragment.stages },
    storage,
    columnIndexes,
  };
}

export async function runBufferedSerialJoin(makeBuildSide: any, makeProbeOp: any, buildChunks: any, probeChunks: any, node: any, probeColCount: any): Promise<any> {
  const buildSide = makeBuildSide();
  for (const chunk of buildChunks) await buildSide.consume(chunk);
  await buildSide.finalize();

  const probeOp = makeProbeOp(buildSide);
  const out: any[] = [];
  for (const chunk of probeChunks) {
    const result = await probeOp.process(chunk);
    if (result && result.size > 0) out.push(result);
  }
  if (node.joinType === JoinType.LEFT || node.joinType === JoinType.FULL) {
    const unmatchedRows = buildSide.emitUnmatched(probeColCount);
    if (unmatchedRows.length > 0) out.push(probeOp.buildOutputChunk(unmatchedRows));
  }
  if (probeOp.finalize) {
    await probeOp.finalize({ consume: async (chunk: any) => { out.push(chunk); } });
  }
  return out;
}
