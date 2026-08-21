import type { ParallelExpressionDispatch } from '../parallel-context.js';
import type { PhysicalPlanNode } from '../physical-plan.js';
import { compileExpression } from '../expression-eval.js';
import { FilterOperator } from '../operators/filter.js';
import { ProjectionOperator } from '../operators/projection.js';
import { SortOperator, LimitOperator, nullsFirstFor } from '../operators/sort.js';
import { DistinctOperator } from '../operators/distinct.js';
import { UnionOperator } from '../operators/union.js';
import { SetOperator } from '../operators/set-op.js';
import { WindowOperator } from '../operators/window.js';
import { CancelToken } from '../pipeline.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import type { BoundExpr, BoundWindowNode } from '../../binder/expression-binder.js';
import { combinedMappingOf } from './builder-utils.js';
import { exprKey } from '../../binder/expr-key.js';
import type { DataChunk } from '../../storage/chunk.js';
import type { DataType } from '../../storage/data-type.js';
import type { PipelineGraph } from '../pipeline.js';
import type {
  ColumnMapping,
  CompiledExpr,
  CompiledPipeline,
  ExecColumn,
  ExecSchema,
  Sink,
  SourceGenerator,
} from '../execution-types.js';
import { SetOpType } from '../../planner/logical-plan.js';
import { projectedColumnName, projectedColumnAlias } from '../../planner/project-schema.js';
import type {
  LogicalPlanNode,
  LogicalFilterNode,
  LogicalProjectNode,
  LogicalSortNode,
  LogicalTopNNode,
  LogicalLimitNode,
  LogicalDistinctNode,
  LogicalSetOpNode,
  LogicalWindowNode,
  LogicalOrderKey,
  ProjectedExpr,
} from '../../planner/logical-plan.js';

type ParallelDispatchLike = ConstructorParameters<typeof FilterOperator>[3];
import type { ChunkSpillStore } from '../../storage/spill-manager/spill-manager.js';

interface TempManagerLike {
  allocate(category: string, label: string): string;
}

interface StorageBackendLike {
  createSpillManager(handle: string): ChunkSpillStore;
}

interface ExecutorLike {
  buildPipeline(node: PhysicalPlanNode): Promise<CompiledPipeline>;
  buildSchemaMapping(schema: ExecSchema, alias: string): ColumnMapping;
  normalizeExecType(dt: DataType | string): DataType;
  parallelDispatch: ParallelExpressionDispatch | null;
  tempManager: TempManagerLike;
  storageBackend: StorageBackendLike;
}

interface ProjectExprMeta {
  outputName?: string;
  alias?: string;
  name?: string;
  columnName?: string;
  dataType?: string;
  resultType?: string;
}

interface KeyExtractor {
  eval: CompiledExpr;
  direction: string;
  nullsFirst: boolean;
}

function sortKeysOf(orderKeys: LogicalOrderKey[], columnMapping: ColumnMapping): KeyExtractor[] {
  return orderKeys.map((ok: LogicalOrderKey) => ({
    eval: compileExpression(ok.expr, columnMapping),
    direction: ok.direction || 'ASC',
    nullsFirst: nullsFirstFor(ok.direction, ok.nullOrder),
  }));
}

export async function buildFilter(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalFilterNode;
  const child = await executor.buildPipeline(physical.children[0]);
  const evalFn = compileExpression(node.condition, child.columnMapping);
  const parallelDispatch = executor.parallelDispatch;

  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const filterOp = new FilterOperator(node.condition, evalFn, child.columnMapping, parallelDispatch);
      const childSink: Sink = {
        get cancelToken() { return currentSink.cancelToken; },
        async consume(chunk: DataChunk) {
          if (this.cancelToken?.isCancelled) return;
          const filtered = await filterOp.process(chunk);
          if (filtered && filtered.size > 0) {
            await currentSink.consume(filtered);
          }
        },
        async finalize() {
          if (currentSink.finalize) await currentSink.finalize();
        }
      };
      child.register(graph, currentPipelineId, childSink);
    }
  };
}

export async function buildProject(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalProjectNode;
  const child = await executor.buildPipeline(physical.children[0]);
  const evaluators: CompiledExpr[] = node.expressions.map((expr: ProjectedExpr) => compileExpression(expr, child.columnMapping));
  const resultTypes: DataType[] = node.expressions.map((expr: ProjectedExpr) => {
    const meta = expr as ProjectExprMeta;
    return executor.normalizeExecType(meta.dataType || meta.resultType || 'VARCHAR');
  });

  const outputAlias = node.outputAlias || '';
  const schema: ExecSchema = node.expressions.map((expr: ProjectedExpr, i: number) => {
    const meta = expr as ProjectExprMeta;
    const name = projectedColumnName(expr, i);
    return {
      name,
      dataType: executor.normalizeExecType(meta.dataType || meta.resultType || 'VARCHAR'),
      tableAlias: projectedColumnAlias(expr, name, outputAlias),
    };
  });
  const columnMapping = executor.buildSchemaMapping(schema, outputAlias);

  return {
    schema,
    columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const projOp = new ProjectionOperator(node.expressions, evaluators, resultTypes, child.columnMapping, executor.parallelDispatch);
      const childSink: Sink = {
        get cancelToken() { return currentSink.cancelToken; },
        async consume(chunk: DataChunk) {
          if (this.cancelToken?.isCancelled) return;
          const projected = await projOp.process(chunk);
          await currentSink.consume(projected);
        },
        async finalize() {
          if (currentSink.finalize) await currentSink.finalize();
        }
      };
      child.register(graph, currentPipelineId, childSink);
    }
  };
}

export async function buildSort(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalSortNode;
  const child = await executor.buildPipeline(physical.children[0]);
  const keyExtractors: KeyExtractor[] = sortKeysOf(node.orderKeys, child.columnMapping);

  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const spillHandle = executor.tempManager.allocate('spill', 'sort');
      const sortOp = new SortOperator(keyExtractors, node.limit ?? null, node.offset || 0, executor.storageBackend.createSpillManager(spillHandle));
      const sortSink: Sink = {
        async consume(chunk: DataChunk) { await sortOp.consume(chunk); },
        async finalize() {}
      };
      const childPipelineId = graph.createPipeline(sortSink);
      child.register(graph, childPipelineId, sortSink);

      graph.addDependency(currentPipelineId, childPipelineId);

      const source: SourceGenerator = async function* () {
        for await (const chunk of sortOp.stream()) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      };
      graph.setSource(currentPipelineId, source);
    }
  };
}

export async function buildTopN(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalTopNNode;
  const child = await executor.buildPipeline(physical.children[0]);
  const keyExtractors: KeyExtractor[] = sortKeysOf(node.orderKeys, child.columnMapping);

  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const spillHandle = executor.tempManager.allocate('spill', 'topn');
      const sortOp = new SortOperator(keyExtractors, node.count, node.offset || 0, executor.storageBackend.createSpillManager(spillHandle));
      const sortSink: Sink = {
        async consume(chunk: DataChunk) { await sortOp.consume(chunk); },
        async finalize() {}
      };
      const childPipelineId = graph.createPipeline(sortSink);
      child.register(graph, childPipelineId, sortSink);

      graph.addDependency(currentPipelineId, childPipelineId);

      const source: SourceGenerator = async function* () {
        for await (const chunk of sortOp.stream()) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      };
      graph.setSource(currentPipelineId, source);
    }
  };
}

export async function buildLimit(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalLimitNode;
  const child = await executor.buildPipeline(physical.children[0]);
  const limit = node.count;
  const offset = node.offset || 0;

  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const limitOp = new LimitOperator(limit, offset);
      const cancelToken = new CancelToken();
      const emitPending = async () => {
        for (const chunk of limitOp.takeChunks()) {
          if (chunk.size > 0) await currentSink.consume(chunk);
        }
      };
      const childSink: Sink = {
        async consume(chunk: DataChunk) {
          if (cancelToken.isCancelled) return;
          await limitOp.consume(chunk);
          await emitPending();
          if (limitOp.done) {
            cancelToken.cancel();
          }
        },
        async finalize() {
          await emitPending();
          if (currentSink.finalize) await currentSink.finalize();
        },
        cancelToken,
      };
      child.register(graph, currentPipelineId, childSink);
    }
  };
}

export async function buildDistinct(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalDistinctNode;
  const child = await executor.buildPipeline(physical.children[0]);

  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const spillHandle = executor.tempManager.allocate('spill', 'distinct');
      const distinctOp = new DistinctOperator(executor.storageBackend.createSpillManager(spillHandle));
      const childSink: Sink = {
        async consume(chunk: DataChunk) {
          const result = await distinctOp.process(chunk);
          if (result && result.size > 0) {
            await currentSink.consume(result);
          }
        },
        async finalize() {
          for await (const chunk of distinctOp.finalize()) {
            if (chunk.size > 0) await currentSink.consume(chunk);
          }
          if (currentSink.finalize) await currentSink.finalize();
        }
      };
      child.register(graph, currentPipelineId, childSink);
    }
  };
}

export async function buildSetOp(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalSetOpNode;
  const left = await executor.buildPipeline(physical.children[0]);
  const right = await executor.buildPipeline(physical.children[1]);

  const register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => void =
    node.op === SetOpType.UNION
      ? registerUnion(executor, node, left, right)
      : registerFilteringSetOp(node, left, right);

  return { schema: left.schema, columnMapping: left.columnMapping, register };
}

function registerUnion(executor: ExecutorLike, node: LogicalSetOpNode, left: CompiledPipeline, right: CompiledPipeline) {
  return (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink): void => {
    if (!node.all) {
      const spillHandle = executor.tempManager.allocate('spill', 'union');
      const unionOp = new UnionOperator(false, executor.storageBackend.createSpillManager(spillHandle));
      const dedupSink: Sink = {
        async consume(chunk: DataChunk) {
          const result = await unionOp.process(chunk);
          if (result && result.size > 0) {
            await currentSink.consume(result);
          }
        },
        async finalize() {}
      };

      const leftPipelineId = graph.createPipeline(dedupSink);
      const rightPipelineId = graph.createPipeline(dedupSink);

      left.register(graph, leftPipelineId, dedupSink);
      right.register(graph, rightPipelineId, dedupSink);

      graph.addDependency(rightPipelineId, leftPipelineId);
      graph.addDependency(currentPipelineId, rightPipelineId);

      const source: SourceGenerator = async function* () {
        for await (const chunk of unionOp.finalize()) {
          if (chunk.size === 0) continue;
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      };
      graph.setSource(currentPipelineId, source);
      return;
    }

    const leftPipelineId = graph.createPipeline(currentSink);
    const rightPipelineId = graph.createPipeline(currentSink);

    left.register(graph, leftPipelineId, currentSink);
    right.register(graph, rightPipelineId, currentSink);

    graph.addDependency(currentPipelineId, leftPipelineId);
    graph.addDependency(currentPipelineId, rightPipelineId);

    graph.setSource(currentPipelineId, async function* () {});
  };
}

function registerFilteringSetOp(node: LogicalSetOpNode, left: CompiledPipeline, right: CompiledPipeline) {
  return (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink): void => {
    const setOp = new SetOperator(node.op, node.all);

    const rightSink: Sink = {
      async consume(chunk: DataChunk) { setOp.consumeRight(chunk); },
      async finalize() {}
    };
    const rightPipelineId = graph.createPipeline(rightSink);
    right.register(graph, rightPipelineId, rightSink);

    const leftChunks: DataChunk[] = [];
    const leftSink: Sink = {
      async consume(chunk: DataChunk) { leftChunks.push(chunk.selectionVector ? chunk.flatten() : chunk); },
      async finalize() {}
    };
    const leftPipelineId = graph.createPipeline(leftSink);
    left.register(graph, leftPipelineId, leftSink);

    graph.addDependency(leftPipelineId, rightPipelineId);
    graph.addDependency(currentPipelineId, leftPipelineId);

    const source: SourceGenerator = async function* () {
      for (const chunk of leftChunks) {
        const result = setOp.filterLeft(chunk);
        if (result.size === 0) continue;
        await currentSink.consume(result);
        yield result;
      }
      if (currentSink.finalize) await currentSink.finalize();
    };
    graph.setSource(currentPipelineId, source);
  };
}

export async function buildWindow(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalWindowNode;
  const child = await executor.buildPipeline(physical.children[0]);
  const windowExprs = node.windowExprs as BoundWindowNode[];

  const windowColumns: ExecSchema = windowExprs.map((w: BoundWindowNode, i: number): ExecColumn => ({
    name: `__window_${i}`,
    dataType: executor.normalizeExecType(w.resultType || 'FLOAT64'),
    tableAlias: '',
  }));
  const windowSchema: ExecSchema = [...child.schema, ...windowColumns];
  const windowMapping: ColumnMapping = combinedMappingOf(child, { schema: windowColumns, columnMapping: new Map() });
  for (let w = 0; w < windowExprs.length; w++) {
    windowMapping.set(exprKey(windowExprs[w]), child.schema.length + w);
  }

  return {
    schema: windowSchema,
    columnMapping: windowMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const spillHandle = executor.tempManager.allocate('spill', 'window');
      const windowOp = new WindowOperator(
        windowExprs,
        child.schema,
        child.columnMapping,
        compileExpression,
        executor.storageBackend.createSpillManager(spillHandle),
      );
      const windowSink: Sink = {
        async consume(chunk: DataChunk) { await windowOp.consume(chunk); },
        async finalize() {}
      };
      const childPipelineId = graph.createPipeline(windowSink);
      child.register(graph, childPipelineId, windowSink);
      graph.addDependency(currentPipelineId, childPipelineId);

      const source: SourceGenerator = async function* () {
        for await (const chunk of windowOp.stream()) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      };
      graph.setSource(currentPipelineId, source);
    }
  };
}


