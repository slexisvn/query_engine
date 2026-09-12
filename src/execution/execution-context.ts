import { PlanNodeType, type LogicalPlanNode } from '../planner/logical-plan.js';
import { PhysicalNodeType, type PhysicalPlanNode } from './physical-plan.js';
import { ExecutionProfiler } from './execution-profile.js';
import { ResultSink } from './result-sink.js';
import { CancelToken, PipelineGraph } from './pipeline.js';
import { TaskScheduler } from './scheduler.js';
import { buildScan, buildIndexScan, buildSingleRow, buildEmpty } from './builders/source-builders.js';
import {
  buildFilter, buildProject, buildSort, buildTopN,
  buildLimit, buildDistinct, buildSetOp, buildWindow,
} from './builders/pipeline-builders.js';
import { buildJoin } from './builders/join-builder.js';
import { buildAggregate, buildPartialAggregate, buildFinalAggregate } from './builders/aggregate-builder.js';
import { buildCTEAnchor, buildCTEScan, buildMaterialize, buildDependentJoin } from './builders/cte-builders.js';
import { buildExchange, buildMergeExchange, buildExchangeReceive } from './builders/exchange-builders.js';
import type { ExecutionResources } from './execution-resources.js';
import type { MaterializedCTE } from './builders/cte-builders.js';
import type { ChunkReceiver, DistributedExecutionContext } from './builders/exchange-builders.js';
import type { DataChunk } from '../storage/chunk.js';
import type {
  CompiledPipeline,
  Sink,
  ExecSchema,
  ExecColumn,
  ColumnMapping,
} from './execution-types.js';

type BuilderFn = (ctx: ExecutionContext, node: PhysicalPlanNode) => Promise<CompiledPipeline>;

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
  [PhysicalNodeType.SET_OP]: buildSetOp,
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

interface NamedColumn {
  name: string;
}

export interface ExecutionContextOptions {
  cteDefinitions?: Map<string, LogicalPlanNode> | null;
  profiler?: ExecutionProfiler | null;
  distributedContext?: DistributedExecutionContext | null;
  exchangeReceivers?: Map<number, ChunkReceiver> | null;
  cancelToken?: CancelToken | null;
}

export class ExecutionContext {
  readonly resources: ExecutionResources;
  readonly cteResults: Map<string, Promise<MaterializedCTE>>;
  readonly ctePipelines: Map<string, Promise<CompiledPipeline>>;
  readonly cteDefinitions: Map<string, LogicalPlanNode>;
  readonly profiler: ExecutionProfiler | null;
  readonly distributedContext: DistributedExecutionContext | null;
  readonly exchangeReceivers: Map<number, ChunkReceiver> | null;
  readonly cancelToken: CancelToken;
  readonly interruptible: boolean;

  constructor(resources: ExecutionResources, options: ExecutionContextOptions = {}) {
    this.resources = resources;
    this.cteResults = new Map();
    this.ctePipelines = new Map();
    this.cteDefinitions = new Map(options.cteDefinitions ?? []);
    this.profiler = options.profiler ?? null;
    this.distributedContext = options.distributedContext ?? null;
    this.exchangeReceivers = options.exchangeReceivers ?? null;
    this.cancelToken = options.cancelToken ?? new CancelToken();
    this.interruptible = options.cancelToken != null;
  }

  get schedulerToken(): CancelToken | null {
    return this.interruptible ? this.cancelToken : null;
  }

  async run(logicalPlan: LogicalPlanNode, streaming: boolean = false): Promise<ResultSink> {
    const spillHandle = this.resources.tempManager.allocate('spill', 'result');
    const resultSink = new ResultSink(streaming, this.resources.storageBackend.createSpillManager(spillHandle));
    await resultSink.init();

    const graph = await this.buildGraph(logicalPlan, resultSink);
    const scheduler = new TaskScheduler();

    if (streaming) {
      scheduler.schedule(graph, this.schedulerToken).catch((err: Error) => resultSink.error(err));
      return resultSink;
    }

    await scheduler.schedule(graph, this.schedulerToken);
    return resultSink;
  }

  async buildGraph(logicalPlan: LogicalPlanNode, sink: Sink): Promise<PipelineGraph> {
    const physicalPlan = this.resources.physicalPlanner.plan(logicalPlan);
    this.profiler?.setRoot(physicalPlan);
    const compiled = await this.buildPipeline(physicalPlan);
    const graph = new PipelineGraph(this.cancelToken);
    compiled.register(graph, graph.createPipeline(sink), sink);
    return graph;
  }

  async buildPipeline(node: PhysicalPlanNode): Promise<CompiledPipeline> {
    const builder = BUILDERS[node.type];
    if (!builder) {
      throw new Error(`Unsupported physical operator: ${node.type}`);
    }
    const compiled = await builder(this, node);
    return this.profiler === null ? compiled : this.profiler.instrument(node, compiled);
  }

  async buildLogicalPipeline(node: LogicalPlanNode): Promise<CompiledPipeline> {
    return this.buildPipeline(this.resources.physicalPlanner.plan(node));
  }

  async executeSubPipeline(compiled: CompiledPipeline): Promise<DataChunk[]> {
    const chunks: DataChunk[] = [];
    const sink: Sink = {
      consume: async (chunk: DataChunk) => { chunks.push(chunk); },
      finalize: async () => {},
    };
    const graph = new PipelineGraph(this.cancelToken);
    const pipelineId = graph.createPipeline(sink);
    compiled.register(graph, pipelineId, sink);
    await new TaskScheduler().schedule(graph, this.schedulerToken);
    return chunks;
  }

  findCTEPlan(cteName: string): LogicalPlanNode | null {
    return this.cteDefinitions.get(cteName.toUpperCase()) ?? null;
  }

  defineCTE(cteName: string, plan: LogicalPlanNode): void {
    this.cteDefinitions.set(cteName.toUpperCase(), plan);
  }

  resolveProjectedColumnIndexes(storageSchema: ExecSchema, planColumns: readonly NamedColumn[] | null): number[] | null {
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

  estimatePlanRows(planNode: LogicalPlanNode): number {
    let total = 0;
    const stack: LogicalPlanNode[] = [planNode];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      if (current.type === PlanNodeType.SCAN || current.type === PlanNodeType.INDEX_SCAN) {
        const storage = this.resources.catalog.getTableStorage(current.table);
        if (storage) total += storage.rowCount();
      }
      for (const child of (current.children || [])) stack.push(child);
    }
    return total;
  }
}
