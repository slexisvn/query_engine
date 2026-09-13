import { PhysicalNodeType, isPhysicalJoin, type PhysicalJoinNode, type PhysicalPlanNode } from '../physical-plan.js';
import type { TableStorage } from '../../storage/table-storage.js';
import { JoinType } from '../../planner/logical-plan.js';
import type { LogicalJoinNode, LogicalPlanNode } from '../../planner/logical-plan.js';
import { compileExpression } from '../expression-eval.js';
import { extractJoinKeys } from '../join-utils.js';
import { HashJoinBuild, HashJoinProbe } from '../operators/hash-join.js';
import { MergeJoinOperator, mergeJoinSortKeys } from '../operators/merge-join.js';
import { NestedLoopJoinOperator } from '../operators/nested-loop-join.js';
import {
  extractScanChain,
  buildJoinSpec,
  stageChainSchema,
  schemasEqual,
  plainSchemaOf,
} from '../fragment-spec.js';
import type { StageChain, JoinSpec } from '../fragment-spec.js';
import { Config } from '../../config.js';
import { isBuildSidePreserved } from '../../planner/join-build-side.js';
import { RowMemoryBudget } from '../memory-budget.js';
import { combinedMappingOf, registerBufferedChild, registerSortedChild } from './builder-utils.js';
import { DataType } from '../../storage/data-type.js';
import type { BoundExpr } from '../../binder/expression-binder.js';
import type { DataChunk } from '../../storage/chunk.js';
import type { PipelineGraph } from '../pipeline.js';
import type {
  ColumnMapping,
  CompiledExpr,
  CompiledPipeline,
  ExecColumn,
  ExecSchema,
  Sink,
} from '../execution-types.js';

import type { ExecutionContext } from '../execution-context.js';
export type MakeBuildSide = () => HashJoinBuild;
export type MakeProbeOp = (buildSide: HashJoinBuild) => HashJoinProbe;

type LogicalMarkJoinNode = LogicalJoinNode & { markColumn?: string };

export interface JoinSide {
  spec: StageChain;
  storage: TableStorage | null;
  columnIndexes: number[] | null;
}

export interface ParallelJoinPrep {
  spec: JoinSpec;
  buildSide: JoinSide;
  probeSide: JoinSide;
}

interface JoinOutputTypes {
  build: DataType[];
  probe: DataType[];
}

interface JoinStreamSide {
  chunks: DataChunk[];
  columnIndexes: number[] | null;
}

export interface FragmentPoolLike {
  runJoinStream(
    spec: JoinSpec,
    buildSide: JoinStreamSide,
    probeSide: JoinStreamSide,
    outputTypes: JoinOutputTypes,
  ): AsyncGenerator<DataChunk>;
}

interface JoinBuildCtx {
  left: CompiledPipeline;
  right: CompiledPipeline;
  buildInput: CompiledPipeline;
  probeInput: CompiledPipeline;
  buildKeys: BoundExpr[];
  probeKeys: BoundExpr[];
  conditionEvaluator: CompiledExpr | null;
  resultSchema: ExecSchema;
  resultMapping: ColumnMapping;
  isSemiAnti?: boolean;
  isMark?: boolean;
  markSchema?: ExecSchema | null;
}

export async function buildJoin(ctx: ExecutionContext, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  if (!isPhysicalJoin(physical)) throw new Error(`Not a join operator: ${physical.type}`);
  const node = physical.logical as LogicalJoinNode;
  const left = await ctx.buildPipeline(physical.children[0]);
  const right = await ctx.buildPipeline(physical.children[1]);

  const isSemiAnti = node.joinType === JoinType.SEMI || node.joinType === JoinType.ANTI;
  const isMark = node.joinType === JoinType.MARK;
  let buildInput: CompiledPipeline, probeInput: CompiledPipeline;
  let buildNode: LogicalPlanNode, probeNode: LogicalPlanNode;
  if (isSemiAnti || isMark || physical.buildSide === 'right') {
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
  const combinedMapping = combinedMappingOf(buildInput, probeInput);

  const { buildKeys, probeKeys, residualCondition } = extractJoinKeys(
    node.condition, buildInput.columnMapping, probeInput.columnMapping
  );

  const buildPreserved = isBuildSidePreserved(node.joinType, buildNode === node.children[0]);

  const conditionEvaluator = residualCondition
    ? compileExpression(residualCondition, combinedMapping)
    : null;

  const markSchema: ExecSchema | null = isMark
    ? [...left.schema, { name: (node as LogicalMarkJoinNode).markColumn || '__mark', dataType: DataType.BOOLEAN, tableAlias: '' }]
    : null;
  const resultSchema = isSemiAnti ? left.schema : isMark ? markSchema! : combinedSchema;
  const resultMapping = isSemiAnti
    ? left.columnMapping
    : isMark
      ? ctx.buildSchemaMapping(markSchema!, '')
      : combinedMapping;

  if (physical.type === PhysicalNodeType.MERGE_JOIN) {
    return buildMergeJoin(ctx, node, {
      left, right, buildInput, probeInput,
      buildKeys, probeKeys, conditionEvaluator,
      resultSchema, resultMapping,
    });
  }

  if (physical.type === PhysicalNodeType.NESTED_LOOP_JOIN) {
    return buildNestedLoopJoin(node, {
      left, right, buildInput, probeInput,
      buildKeys, probeKeys, conditionEvaluator,
      resultSchema, resultMapping,
      isSemiAnti, isMark, markSchema,
    });
  }

  const makeBuildSide: MakeBuildSide = () => new HashJoinBuild(
    buildKeys.map((k: BoundExpr) => compileExpression(k, buildInput.columnMapping)),
    node.joinType,
    physical.dedupeBuild && !conditionEvaluator,
    ctx.createSpillStore('join'),
    buildPreserved,
    physical.runtimeFilterEntries,
  );
  const makeProbeOp: MakeProbeOp = (buildSide: HashJoinBuild) => new HashJoinProbe(
    buildSide,
    probeKeys.map((k: BoundExpr) => compileExpression(k, probeInput.columnMapping)),
    buildInput.schema.length,
    probeInput.schema.length,
    node.joinType,
    conditionEvaluator
  );

  const serialCompiled: CompiledPipeline = {
    schema: resultSchema,
    columnMapping: resultMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const buildSide = makeBuildSide();

      const buildSink: Sink = {
        async consume(chunk: DataChunk) { await buildSide.consume(chunk); },
        async finalize() { await buildSide.finalize(); }
      };
      const buildPipelineId = graph.createPipeline(buildSink);
      buildInput.register(graph, buildPipelineId, buildSink);

      const probeOp = makeProbeOp(buildSide);

      const probeSink: Sink = {
        get cancelToken() { return currentSink.cancelToken; },
        async consume(chunk: DataChunk) {
          if (this.cancelToken?.isCancelled) return;
          const result = await probeOp.process(chunk);
          if (result && result.size > 0) {
            await currentSink.consume(result);
          }
        },
        async finalize() {
          if (buildPreserved) {
            const unmatchedRows = buildSide.emitUnmatched();
            if (unmatchedRows.length > 0) {
              await currentSink.consume(probeOp.buildUnmatchedChunk(unmatchedRows));
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

  const parallelJoin = prepareParallelJoin(
    ctx,
    physical, buildInput, probeInput, buildNode, probeNode,
    buildKeys, probeKeys, residualCondition, combinedMapping
  );
  if (!parallelJoin) return serialCompiled;

  return {
    schema: resultSchema,
    columnMapping: resultMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const registerSide = (side: JoinSide, input: CompiledPipeline): DataChunk[] | null =>
        side.storage ? null : registerBufferedChild(graph, currentPipelineId, input);
      const bufferedBuild = registerSide(parallelJoin.buildSide, buildInput);
      const bufferedProbe = registerSide(parallelJoin.probeSide, probeInput);

      graph.setSource(currentPipelineId, async function* (): AsyncGenerator<DataChunk> {
        const collect = async (side: JoinSide, buffered: DataChunk[] | null): Promise<DataChunk[]> => {
          if (!side.storage) return buffered!;
          const chunks: DataChunk[] = [];
          for await (const chunk of side.storage.scan()) chunks.push(chunk);
          return chunks;
        };
        const buildChunks = await collect(parallelJoin.buildSide, bufferedBuild);
        const probeChunks = await collect(parallelJoin.probeSide, bufferedProbe);

        const countRows = (chunks: DataChunk[]): number => chunks.reduce((sum: number, c: DataChunk) => sum + c.size, 0);
        const buildRows = countRows(buildChunks);
        const probeRows = countRows(probeChunks);
        const buildBudget = new RowMemoryBudget();
        buildBudget.adoptSchema(buildChunks[0]?.columns.map((c) => c.dataType));
        const eligible = buildRows + probeRows >= Config.parallelJoinThreshold
          && buildRows <= buildBudget.rowCapacity;

        const emitSerial = async function* (): AsyncGenerator<DataChunk> {
          const bothBuffered = bufferedBuild !== null && bufferedProbe !== null;
          const resultChunks = bothBuffered
            ? await runBufferedSerialJoin(makeBuildSide, makeProbeOp, buildChunks, probeChunks, buildPreserved, probeInput.schema.length)
            : await ctx.executeSubPipeline(serialCompiled);
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

        const typesOf = (side: JoinSide, chunks: DataChunk[]): DataType[] => {
          const declared = (): DataType[] => stageChainSchema(side.spec).map((col: ExecColumn) => col.dataType);
          if (side.storage) return declared();
          const first = chunks.find((c: DataChunk) => c.size > 0);
          return first ? first.columns.map((col) => col.dataType) : declared();
        };
        const outputTypes: JoinOutputTypes = {
          build: typesOf(parallelJoin.buildSide, buildChunks),
          probe: typesOf(parallelJoin.probeSide, probeChunks),
        };

        let emitted = false;
        try {
          const stream = ctx.resources.fragmentPool!.runJoinStream(
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

function buildMergeJoin(ctx: ExecutionContext, node: LogicalJoinNode, join: JoinBuildCtx): CompiledPipeline {
  const { left, right, buildInput, probeInput, conditionEvaluator } = join;
  let mergeBuild = buildInput;
  let mergeProbe = probeInput;
  let mergeBuildKeys = join.buildKeys;
  let mergeProbeKeys = join.probeKeys;
  let mergeSchema = join.resultSchema;
  let mergeMapping = join.resultMapping;
  if (node.joinType === JoinType.LEFT && buildInput !== left) {
    mergeBuild = left;
    mergeProbe = right;
    mergeBuildKeys = join.probeKeys;
    mergeProbeKeys = join.buildKeys;
    mergeSchema = [...left.schema, ...right.schema];
    mergeMapping = combinedMappingOf(left, right);
  } else if (node.joinType === JoinType.RIGHT && buildInput !== right) {
    mergeBuild = right;
    mergeProbe = left;
    mergeBuildKeys = join.probeKeys;
    mergeProbeKeys = join.buildKeys;
    mergeSchema = [...right.schema, ...left.schema];
    mergeMapping = combinedMappingOf(right, left);
  }
  return {
    schema: mergeSchema,
    columnMapping: mergeMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const buildKeyExprs = mergeBuildKeys.map((k: BoundExpr) => compileExpression(k, mergeBuild.columnMapping));
      const probeKeyExprs = mergeProbeKeys.map((k: BoundExpr) => compileExpression(k, mergeProbe.columnMapping));

      const buildRows = registerSortedChild(
        graph, currentPipelineId, mergeBuild,
        mergeJoinSortKeys(buildKeyExprs),
        ctx.createSpillStore('merge-join-build'),
      );
      const probeRows = registerSortedChild(
        graph, currentPipelineId, mergeProbe,
        mergeJoinSortKeys(probeKeyExprs),
        ctx.createSpillStore('merge-join-probe'),
      );

      graph.setSource(currentPipelineId, async function* (): AsyncGenerator<DataChunk> {
        const mergeJoin = new MergeJoinOperator(
          buildRows,
          probeRows,
          buildKeyExprs,
          probeKeyExprs,
          mergeBuild.schema.map((col: ExecColumn) => col.dataType),
          mergeProbe.schema.map((col: ExecColumn) => col.dataType),
          node.joinType,
          conditionEvaluator,
        );

        for await (const chunk of mergeJoin.execute()) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };
}

function buildNestedLoopJoin(node: LogicalJoinNode, join: JoinBuildCtx): CompiledPipeline {
  const { left, right, buildInput, probeInput, isSemiAnti, isMark, markSchema } = join;
  const nlOuter = buildInput === left ? buildInput : probeInput;
  const nlInner = buildInput === left ? probeInput : buildInput;
  const nlMapping = combinedMappingOf(nlOuter, nlInner);
  const nlCondition = node.condition
    ? compileExpression(node.condition, nlMapping)
    : null;
  const nlSchema = [...nlOuter.schema, ...nlInner.schema];
  const nlResultMapping = isSemiAnti ? left.columnMapping : isMark ? join.resultMapping : nlMapping;
  const nlResultSchema = isSemiAnti ? left.schema : isMark ? markSchema! : nlSchema;
  return {
    schema: nlResultSchema,
    columnMapping: nlResultMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const leftChunks = registerBufferedChild(graph, currentPipelineId, left);
      const rightChunks = registerBufferedChild(graph, currentPipelineId, right);

      graph.setSource(currentPipelineId, async function* (): AsyncGenerator<DataChunk> {
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

export function prepareParallelJoin(
  ctx: ExecutionContext,
  physical: PhysicalJoinNode,
  buildInput: CompiledPipeline,
  probeInput: CompiledPipeline,
  buildNode: LogicalPlanNode,
  probeNode: LogicalPlanNode,
  buildKeys: BoundExpr[],
  probeKeys: BoundExpr[],
  residualCondition: BoundExpr | null,
  combinedMapping: ColumnMapping,
): ParallelJoinPrep | null {
  const node = physical.logical;
  if (!ctx.resources.fragmentPool) return null;
  if (buildKeys.length === 0 || node.joinType === JoinType.CROSS) return null;
  if (ctx.estimatePlanRows(node) < Config.parallelJoinThreshold) return null;

  const buildSide = prepareJoinSide(ctx, buildNode, buildInput);
  const probeSide = prepareJoinSide(ctx, probeNode, probeInput);

  const buildPreserved = isBuildSidePreserved(node.joinType, buildNode === node.children[0]);

  const spec = buildJoinSpec({
    build: buildSide.spec,
    probe: probeSide.spec,
    buildKeys,
    probeKeys,
    residualCondition,
    joinType: node.joinType,
    buildPreserved,
    uniqueKeys: physical.dedupeBuild && !residualCondition,
    buildMapping: buildInput.columnMapping,
    probeMapping: probeInput.columnMapping,
    combinedMapping,
  });
  if (!spec) return null;
  return { spec, buildSide, probeSide };
}

function prepareJoinSide(ctx: ExecutionContext, planNode: LogicalPlanNode | null, input: CompiledPipeline): JoinSide {
  const sideSchema = plainSchemaOf(input.schema);
  const buffered: JoinSide = {
    spec: { baseSchema: sideSchema, stages: [] },
    storage: null,
    columnIndexes: null,
  };

  const fragment = planNode ? extractScanChain(planNode) : null;
  if (!fragment) return buffered;
  const storage = ctx.resources.catalog.getTableStorage(fragment.table);
  if (!storage || typeof storage.scan !== 'function') return buffered;

  const storageSchema = storage.getSchema();
  const projected = ctx.resolveProjectedColumnIndexes(storageSchema, fragment.scanColumns);
  const columnIndexes = projected || storageSchema.map((_: ExecColumn, i: number) => i);
  const baseSchema: ExecSchema = columnIndexes.map((i: number) => ({
    name: storageSchema[i].name,
    dataType: storageSchema[i].dataType,
    tableAlias: fragment.alias,
  }));
  if (!schemasEqual(stageChainSchema({ baseSchema, stages: fragment.stages }), sideSchema)) return buffered;

  return {
    spec: { baseSchema, stages: fragment.stages },
    storage,
    columnIndexes,
  };
}

export async function runBufferedSerialJoin(
  makeBuildSide: MakeBuildSide,
  makeProbeOp: MakeProbeOp,
  buildChunks: DataChunk[],
  probeChunks: DataChunk[],
  buildPreserved: boolean,
  probeColCount: number,
): Promise<DataChunk[]> {
  const buildSide = makeBuildSide();
  for (const chunk of buildChunks) await buildSide.consume(chunk);
  await buildSide.finalize();

  const probeOp = makeProbeOp(buildSide);
  const out: DataChunk[] = [];
  for (const chunk of probeChunks) {
    const result = await probeOp.process(chunk);
    if (result && result.size > 0) out.push(result);
  }
  if (buildPreserved) {
    const unmatchedRows = buildSide.emitUnmatched();
    if (unmatchedRows.length > 0) out.push(probeOp.buildUnmatchedChunk(unmatchedRows));
  }
  if (probeOp.finalize) {
    await probeOp.finalize({ consume: async (chunk: DataChunk) => { out.push(chunk); } });
  }
  return out;
}
