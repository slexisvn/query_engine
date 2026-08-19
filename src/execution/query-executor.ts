import { PlanNodeType, type LogicalPlanNode, type LogicalJoinNode } from '../planner/logical-plan.js';
import { PhysicalNodeType, type PhysicalJoinNode, type PhysicalPlanNode } from './physical-plan.js';
import type { ExecutionCatalog } from './execution-catalog.js';
import type { MaterializedCTE } from './builders/cte-builders.js';
import type { ChunkReceiver, DistributedExecutionContext } from './builders/exchange-builders.js';
import type { ParallelExpressionDispatch, WorkerPoolHandle } from './parallel-context.js';
import { PhysicalPlanner } from './physical-planner.js';
import {
  normalizeExecType as normalizeExecTypeShared,
  normalizeAggResultType as normalizeAggResultTypeShared,
} from './fragment-spec.js';
import { ResultSink } from './result-sink.js';
import { PipelineGraph } from './pipeline.js';
import { TaskScheduler } from './scheduler.js';
import { Config } from '../config.js';
import { MemoryStorageBackend } from '../storage/backend/memory-storage-backend.js';
import { buildScan, buildIndexScan, buildSingleRow, buildEmpty } from './builders/source-builders.js';
import {
  buildFilter, buildProject, buildSort, buildTopN,
  buildLimit, buildDistinct, buildUnion, buildWindow,
} from './builders/pipeline-builders.js';
import { buildJoin, prepareParallelJoin, runBufferedSerialJoin } from './builders/join-builder.js';
import type { ParallelJoinPrep, MakeBuildSide, MakeProbeOp, FragmentPoolLike as JoinFragmentPoolLike } from './builders/join-builder.js';
import type { FragmentPoolLike as AggFragmentPoolLike } from './builders/aggregate-builder.js';
import { buildAggregate, buildPartialAggregate, buildFinalAggregate } from './builders/aggregate-builder.js';
import { buildCTEAnchor, buildCTEScan, buildMaterialize, buildDependentJoin } from './builders/cte-builders.js';
import { buildExchange, buildMergeExchange, buildExchangeReceive } from './builders/exchange-builders.js';
import type { ChunkSpillStore } from '../storage/spill-manager/spill-manager.js';
import type { TableStorage } from '../storage/table-storage.js';
import type { DataChunk } from '../storage/chunk.js';
import type { DataType, ColumnValue } from '../storage/data-type.js';
import type { BoundAggregateNode, BoundExpr } from '../binder/expression-binder.js';
import type {
  CompiledPipeline,
  Sink,
  ExecSchema,
  ExecColumn,
  ColumnMapping,
} from './execution-types.js';

type BuilderFn = (executor: QueryExecutor, node: PhysicalPlanNode) => Promise<CompiledPipeline>;

interface TempManagerLike {
  allocate(category: string, label: string): string;
}

interface StorageBackendLike {
  createTempSpace(): object;
  createPageStore(): object;
  createSpillManager(handle: string): ChunkSpillStore;
}

type WorkerPoolLike = WorkerPoolHandle;

type ParallelDispatchLike = ParallelExpressionDispatch;

type FragmentPoolLike = JoinFragmentPoolLike & AggFragmentPoolLike;



interface ExecuteResult {
  sink: ResultSink;
  columnNames: string[];
}

const BUILDERS: Partial<Record<PhysicalNodeType, BuilderFn>> = {
  [PhysicalNodeType.TABLE_SCAN]: buildScan,
  [PhysicalNodeType.INDEX_SCAN]: buildIndexScan,
  [PhysicalNodeType.FILTER]: buildFilter,
  [PhysicalNodeType.PROJECT]: buildProject,
  [PhysicalNodeType.HASH_JOIN]: buildJoin,
  [PhysicalNodeType.MERGE_JOIN]: buildJoin,
  [PhysicalNodeType.NESTED_LOOP_JOIN]: buildJoin,
  [PhysicalNodeType.HASH_AGGREGATE]: buildAggregate,
  [PhysicalNodeType.STREAM_AGGREGATE]: buildAggregate,
  [PhysicalNodeType.UNGROUPED_AGGREGATE]: buildAggregate,
  [PhysicalNodeType.PERFECT_HASH_AGGREGATE]: buildAggregate,
  [PhysicalNodeType.SORT]: buildSort,
  [PhysicalNodeType.LIMIT]: buildLimit,
  [PhysicalNodeType.DISTINCT]: buildDistinct,
  [PhysicalNodeType.UNION]: buildUnion,
  [PhysicalNodeType.CTE_ANCHOR]: buildCTEAnchor,
  [PhysicalNodeType.CTE_SCAN]: buildCTEScan,
  [PhysicalNodeType.MATERIALIZE]: buildMaterialize,
  [PhysicalNodeType.DEPENDENT_JOIN]: buildDependentJoin,
  [PhysicalNodeType.TOP_N]: buildTopN,
  [PhysicalNodeType.WINDOW]: buildWindow,
  [PhysicalNodeType.EMPTY]: buildEmpty,
  [PhysicalNodeType.SINGLE_ROW]: buildSingleRow,
  [PhysicalNodeType.EXCHANGE]: buildExchange,
  [PhysicalNodeType.PARTIAL_AGGREGATE]: buildPartialAggregate,
  [PhysicalNodeType.FINAL_AGGREGATE]: buildFinalAggregate,
  [PhysicalNodeType.MERGE_EXCHANGE]: buildMergeExchange,
  [PhysicalNodeType.EXCHANGE_RECEIVE]: buildExchangeReceive,
};

export class QueryExecutor {
  catalog: ExecutionCatalog;
  tempManager: TempManagerLike;
  storageBackend: StorageBackendLike;
  cteResults: Map<string, MaterializedCTE>;
  cteDefinitions: Map<string, LogicalPlanNode>;
  workerPool: WorkerPoolLike | null;
  parallelDispatch: ParallelDispatchLike | null;
  fragmentPool: FragmentPoolLike | null;
  _distributedContext: DistributedExecutionContext | null;
  _exchangeReceivers: Map<number, ChunkReceiver> | null;
  physicalPlanner: PhysicalPlanner;

  constructor(catalog: ExecutionCatalog, tempManager: TempManagerLike, storageBackend: StorageBackendLike | null = null) {
    this.catalog = catalog;
    this.tempManager = tempManager;
    this.storageBackend = storageBackend ?? new MemoryStorageBackend();
    this.cteResults = new Map();
    this.cteDefinitions = new Map();
    this.workerPool = null;
    this.parallelDispatch = null;
    this.fragmentPool = null;
    this._distributedContext = null;
    this._exchangeReceivers = null;
    this.physicalPlanner = new PhysicalPlanner();
  }

  setPhysicalPlanner(planner: PhysicalPlanner): void {
    this.physicalPlanner = planner;
  }

  setParallelContext(workerPool: WorkerPoolLike, parallelDispatch: ParallelDispatchLike, fragmentPool: FragmentPoolLike | null = null): void {
    this.workerPool = workerPool;
    this.parallelDispatch = parallelDispatch;
    this.fragmentPool = fragmentPool;
  }

  setDistributedContext(ctx: DistributedExecutionContext): void {
    this._distributedContext = ctx;
  }

  _shouldParallelize(storage: TableStorage): boolean {
    return !!(this.workerPool
      && this.parallelDispatch
      && storage.rowCount() >= Config.parallelThreshold);
  }

  async execute(logicalPlan: LogicalPlanNode, outputColumns: ExecColumn[], streaming: boolean = false): Promise<ExecuteResult> {
    const sink = await this.executePlan(logicalPlan, streaming);
    const columnNames = outputColumns.map((c: ExecColumn) => c.name);
    return { sink, columnNames };
  }

  async executeStreaming(logicalPlan: LogicalPlanNode, outputColumns: ExecColumn[]): Promise<ExecuteResult> {
    return this.execute(logicalPlan, outputColumns, true);
  }

  async executePlan(logicalPlan: LogicalPlanNode, streaming: boolean = false): Promise<ResultSink> {
    this.cteResults.clear();
    const graph = new PipelineGraph();
    const resultSink = new ResultSink(streaming, this.storageBackend.createSpillManager(this.tempManager.allocate('spill', 'result')));
    await resultSink.init();

    const rootPipelineId = graph.createPipeline(resultSink);

    const compiledRoot = await this.buildPipeline(this.physicalPlanner.plan(logicalPlan));

    compiledRoot.register(graph, rootPipelineId, resultSink);

    const scheduler = new TaskScheduler();

    if (streaming) {
      const pipelinePromise = scheduler.schedule(graph);
      pipelinePromise.catch(err => resultSink.error(err));
      return resultSink;
    }

    await scheduler.schedule(graph);
    return resultSink;
  }

  async buildPipeline(node: PhysicalPlanNode): Promise<CompiledPipeline> {
    const builder = BUILDERS[node.type];
    if (!builder) {
      throw new Error(`Unsupported physical operator: ${node.type}`);
    }
    return builder(this, node);
  }

  async buildLogicalPipeline(node: LogicalPlanNode): Promise<CompiledPipeline> {
    return this.buildPipeline(this.physicalPlanner.plan(node));
  }

  resolveProjectedColumnIndexes(storageSchema: ExecSchema, planColumns: ExecColumn[] | null): number[] | null {
    if (!planColumns || planColumns.length === 0 || planColumns.length >= storageSchema.length) {
      return null;
    }

    const indexes: number[] = [];
    for (const col of planColumns) {
      const idx = storageSchema.findIndex((s: ExecColumn) => s.name.toUpperCase() === col.name.toUpperCase());
      if (idx < 0) return null;
      indexes.push(idx);
    }
    return indexes;
  }

  buildSchemaMapping(schema: ExecSchema, alias: string): ColumnMapping {
    const mapping: ColumnMapping = new Map();
    for (let i = 0; i < schema.length; i++) {
      const col = schema[i];
      const tableAlias = col.tableAlias || alias || '';
      const key = `${tableAlias}.${col.name}`.toUpperCase();
      mapping.set(key, i);
      if (!mapping.has(col.name.toUpperCase())) {
        mapping.set(col.name.toUpperCase(), i);
      }
    }
    return mapping;
  }

  findCTEPlan(cteName: string): LogicalPlanNode | null {
    const key = cteName.toUpperCase();
    return this.cteDefinitions?.get(key) || null;
  }

  _estimatePlanRows(planNode: LogicalPlanNode): number {
    let total = 0;
    const stack: LogicalPlanNode[] = [planNode];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      if (current.type === PlanNodeType.SCAN || current.type === PlanNodeType.INDEX_SCAN) {
        const storage = this.catalog.getTableStorage(current.table);
        if (storage) total += storage.rowCount();
      }
      for (const child of (current.children || [])) stack.push(child);
    }
    return total;
  }

  async _executeSubPipeline(compiled: CompiledPipeline): Promise<DataChunk[]> {
    const chunks: DataChunk[] = [];
    const sink: Sink = {
      consume: async (chunk: DataChunk) => { chunks.push(chunk); },
      finalize: async () => {},
    };
    const graph = new PipelineGraph();
    const pipelineId = graph.createPipeline(sink);
    compiled.register(graph, pipelineId, sink);
    await new TaskScheduler().schedule(graph);
    return chunks;
  }

  _prepareParallelJoin(
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
    return prepareParallelJoin(this, physical, buildInput, probeInput, buildNode, probeNode, buildKeys, probeKeys, residualCondition, combinedMapping);
  }

  _runBufferedSerialJoin(
    makeBuildSide: MakeBuildSide,
    makeProbeOp: MakeProbeOp,
    buildChunks: DataChunk[],
    probeChunks: DataChunk[],
    buildPreserved: boolean,
    probeColCount: number,
  ): Promise<DataChunk[]> {
    return runBufferedSerialJoin(makeBuildSide, makeProbeOp, buildChunks, probeChunks, buildPreserved, probeColCount);
  }

  normalizeExecType(dt: DataType | string): DataType {
    return normalizeExecTypeShared(dt);
  }

  normalizeAggResultType(agg: BoundAggregateNode | { name?: string }): DataType {
    return normalizeAggResultTypeShared(agg);
  }
}
