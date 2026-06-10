import { PlanNodeType } from '../planner/logical-plan.js';
import {
  normalizeExecType as normalizeExecTypeShared,
  normalizeAggResultType as normalizeAggResultTypeShared,
} from './fragment-spec.js';
import { ResultSink } from './result-sink.js';
import { PipelineGraph } from './pipeline.js';
import { TaskScheduler } from './scheduler.js';
import { Config } from '../config.js';
import { buildScan, buildIndexScan, buildSingleRow, buildEmpty } from './builders/source-builders.js';
import {
  buildFilter, buildProject, buildSort, buildTopN,
  buildLimit, buildDistinct, buildUnion, buildWindow,
} from './builders/pipeline-builders.js';
import { buildJoin, prepareParallelJoin, runBufferedSerialJoin } from './builders/join-builder.js';
import { buildAggregate, buildPartialAggregate, buildFinalAggregate } from './builders/aggregate-builder.js';
import { buildCTEAnchor, buildCTEScan, buildMaterialize, buildDependentJoin } from './builders/cte-builders.js';
import { buildExchange, buildMergeExchange, buildExchangeReceive } from './builders/exchange-builders.js';

const BUILDERS = {
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
  constructor(catalog, tempManager) {
    this.catalog = catalog;
    this.tempManager = tempManager;
    this.cteResults = new Map();
    this.cteDefinitions = new Map();
    this.workerPool = null;
    this.parallelDispatch = null;
    this.fragmentPool = null;
  }

  setParallelContext(workerPool, parallelDispatch, fragmentPool = null) {
    this.workerPool = workerPool;
    this.parallelDispatch = parallelDispatch;
    this.fragmentPool = fragmentPool;
  }

  setDistributedContext(ctx) {
    this._distributedContext = ctx;
  }

  _shouldParallelize(storage) {
    return this.workerPool
      && this.parallelDispatch
      && storage.rowCount() >= Config.parallelThreshold;
  }

  async execute(logicalPlan, outputColumns, streaming = false) {
    const sink = await this.executePlan(logicalPlan, streaming);
    const columnNames = outputColumns.map(c => c.name);
    return { sink, columnNames };
  }

  async executeStreaming(logicalPlan, outputColumns) {
    return this.execute(logicalPlan, outputColumns, true);
  }

  async executePlan(logicalPlan, streaming = false) {
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

  async buildPipeline(node) {
    const builder = BUILDERS[node.type];
    if (!builder) {
      throw new Error(`Unsupported plan node: ${node.type}`);
    }
    return builder(this, node);
  }

  resolveProjectedColumnIndexes(storageSchema, planColumns) {
    if (!planColumns || planColumns.length === 0 || planColumns.length >= storageSchema.length) {
      return null;
    }

    const indexes = [];
    for (const col of planColumns) {
      const idx = storageSchema.findIndex(s => s.name.toUpperCase() === col.name.toUpperCase());
      if (idx < 0) return null;
      indexes.push(idx);
    }
    return indexes;
  }

  buildSchemaMapping(schema, alias) {
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

  findCTEPlan(cteName) {
    const key = cteName.toUpperCase();
    return this.cteDefinitions?.get(key) || null;
  }

  _estimatePlanRows(planNode) {
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

  async _executeSubPipeline(compiled) {
    const chunks = [];
    const sink = {
      consume: async (chunk) => { chunks.push(chunk); },
      finalize: async () => {},
    };
    const graph = new PipelineGraph();
    const pipelineId = graph.createPipeline(sink);
    compiled.register(graph, pipelineId, sink);
    await new TaskScheduler().schedule(graph);
    return chunks;
  }

  _prepareParallelJoin(node, buildInput, probeInput, buildNode, probeNode, buildKeys, probeKeys, residualCondition, combinedMapping) {
    return prepareParallelJoin(this, node, buildInput, probeInput, buildNode, probeNode, buildKeys, probeKeys, residualCondition, combinedMapping);
  }

  _runBufferedSerialJoin(makeBuildSide, makeProbeOp, buildChunks, probeChunks, node, probeColCount) {
    return runBufferedSerialJoin(makeBuildSide, makeProbeOp, buildChunks, probeChunks, node, probeColCount);
  }

  normalizeExecType(dt) {
    return normalizeExecTypeShared(dt);
  }

  normalizeAggResultType(agg) {
    return normalizeAggResultTypeShared(agg);
  }
}
