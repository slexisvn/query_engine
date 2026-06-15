import { PlanNodeType } from '../planner/logical-plan.js';
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
import { buildAggregate, buildPartialAggregate, buildFinalAggregate } from './builders/aggregate-builder.js';
import { buildCTEAnchor, buildCTEScan, buildMaterialize, buildDependentJoin } from './builders/cte-builders.js';
import { buildExchange, buildMergeExchange, buildExchangeReceive } from './builders/exchange-builders.js';

const BUILDERS: Record<string, any> = {
  [PlanNodeType.SCAN]: buildScan,
  [PlanNodeType.INDEX_SCAN]: buildIndexScan,
  [PlanNodeType.FILTER]: buildFilter,
  [PlanNodeType.PROJECT]: buildProject,
  [PlanNodeType.JOIN]: buildJoin,
  [PlanNodeType.AGGREGATE]: buildAggregate,
  [PlanNodeType.SORT]: buildSort,
  [PlanNodeType.LIMIT]: buildLimit,
  [PlanNodeType.DISTINCT]: buildDistinct,
  [PlanNodeType.UNION]: buildUnion,
  [PlanNodeType.CTE_ANCHOR]: buildCTEAnchor,
  [PlanNodeType.CTE_SCAN]: buildCTEScan,
  [PlanNodeType.MATERIALIZE]: buildMaterialize,
  [PlanNodeType.DEPENDENT_JOIN]: buildDependentJoin,
  [PlanNodeType.TOP_N]: buildTopN,
  [PlanNodeType.WINDOW]: buildWindow,
  [PlanNodeType.EMPTY]: buildEmpty,
  [PlanNodeType.SINGLE_ROW]: buildSingleRow,
  [PlanNodeType.EXCHANGE]: buildExchange,
  [PlanNodeType.PARTIAL_AGGREGATE]: buildPartialAggregate,
  [PlanNodeType.FINAL_AGGREGATE]: buildFinalAggregate,
  [PlanNodeType.MERGE_EXCHANGE]: buildMergeExchange,
  [PlanNodeType.EXCHANGE_RECEIVE]: buildExchangeReceive,
};

export class QueryExecutor {
  catalog: any;
  tempManager: any;
  storageBackend: any;
  cteResults: Map<any, any>;
  cteDefinitions: Map<any, any>;
  workerPool: any;
  parallelDispatch: any;
  fragmentPool: any;
  _distributedContext: any;

  constructor(catalog: any, tempManager: any, storageBackend: any = null) {
    this.catalog = catalog;
    this.tempManager = tempManager;
    this.storageBackend = storageBackend ?? new MemoryStorageBackend();
    this.cteResults = new Map();
    this.cteDefinitions = new Map();
    this.workerPool = null;
    this.parallelDispatch = null;
    this.fragmentPool = null;
  }

  setParallelContext(workerPool: any, parallelDispatch: any, fragmentPool: any = null): void {
    this.workerPool = workerPool;
    this.parallelDispatch = parallelDispatch;
    this.fragmentPool = fragmentPool;
  }

  setDistributedContext(ctx: any): void {
    this._distributedContext = ctx;
  }

  _shouldParallelize(storage: any): any {
    return this.workerPool
      && this.parallelDispatch
      && storage.rowCount() >= Config.parallelThreshold;
  }

  async execute(logicalPlan: any, outputColumns: any, streaming: boolean = false): Promise<any> {
    const sink = await this.executePlan(logicalPlan, streaming);
    const columnNames = outputColumns.map((c: any) => c.name);
    return { sink, columnNames };
  }

  async executeStreaming(logicalPlan: any, outputColumns: any): Promise<any> {
    return this.execute(logicalPlan, outputColumns, true);
  }

  async executePlan(logicalPlan: any, streaming: boolean = false): Promise<any> {
    this.cteResults.clear();
    const graph = new PipelineGraph();
    const resultSink = new ResultSink(streaming);
    await resultSink.init();

    const rootPipelineId = graph.createPipeline(resultSink);

    const compiledRoot = await this.buildPipeline(logicalPlan);

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

  async buildPipeline(node: any): Promise<any> {
    const builder = BUILDERS[node.type];
    if (!builder) {
      throw new Error(`Unsupported plan node: ${node.type}`);
    }
    return builder(this, node);
  }

  resolveProjectedColumnIndexes(storageSchema: any, planColumns: any): any {
    if (!planColumns || planColumns.length === 0 || planColumns.length >= storageSchema.length) {
      return null;
    }

    const indexes = [];
    for (const col of planColumns) {
      const idx = storageSchema.findIndex((s: any) => s.name.toUpperCase() === col.name.toUpperCase());
      if (idx < 0) return null;
      indexes.push(idx);
    }
    return indexes;
  }

  buildSchemaMapping(schema: any, alias: any): any {
    const mapping = new Map();
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

  findCTEPlan(cteName: any): any {
    const key = cteName.toUpperCase();
    return this.cteDefinitions?.get(key) || null;
  }

  _estimatePlanRows(planNode: any): number {
    let total = 0;
    const stack = [planNode];
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

  async _executeSubPipeline(compiled: any): Promise<any> {
    const chunks: any[] = [];
    const sink = {
      consume: async (chunk: any) => { chunks.push(chunk); },
      finalize: async () => {},
    };
    const graph = new PipelineGraph();
    const pipelineId = graph.createPipeline(sink);
    compiled.register(graph, pipelineId, sink);
    await new TaskScheduler().schedule(graph);
    return chunks;
  }

  _prepareParallelJoin(node: any, buildInput: any, probeInput: any, buildNode: any, probeNode: any, buildKeys: any, probeKeys: any, residualCondition: any, combinedMapping: any): any {
    return prepareParallelJoin(this, node, buildInput, probeInput, buildNode, probeNode, buildKeys, probeKeys, residualCondition, combinedMapping);
  }

  _runBufferedSerialJoin(makeBuildSide: any, makeProbeOp: any, buildChunks: any, probeChunks: any, node: any, probeColCount: any): any {
    return runBufferedSerialJoin(makeBuildSide, makeProbeOp, buildChunks, probeChunks, node, probeColCount);
  }

  normalizeExecType(dt: any): any {
    return normalizeExecTypeShared(dt);
  }

  normalizeAggResultType(agg: any): any {
    return normalizeAggResultTypeShared(agg);
  }
}
