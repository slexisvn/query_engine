import type { ParallelExpressionDispatch } from '../parallel-context.js';
import type { PhysicalPlanNode } from '../physical-plan.js';
import { compileExpression } from '../expression-eval.js';
import { FilterOperator } from '../operators/filter.js';
import { ProjectionOperator } from '../operators/projection.js';
import { SortOperator, LimitOperator } from '../operators/sort.js';
import { DistinctOperator } from '../operators/distinct.js';
import { UnionOperator } from '../operators/union.js';
import { WindowOperator } from '../operators/window.js';
import { CancelToken } from '../pipeline.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import type { BoundExpr, BoundWindowNode } from '../../binder/expression-binder.js';
import { registerBufferedChild } from './builder-utils.js';
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
import type {
  LogicalPlanNode,
  LogicalFilterNode,
  LogicalProjectNode,
  LogicalSortNode,
  LogicalTopNNode,
  LogicalLimitNode,
  LogicalDistinctNode,
  LogicalUnionNode,
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
    return {
      name: meta.outputName || meta.alias || meta.name || meta.columnName || `col${i}`,
      dataType: executor.normalizeExecType(meta.dataType || meta.resultType || 'VARCHAR'),
      tableAlias: outputAlias,
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
  const keyExtractors: KeyExtractor[] = node.orderKeys.map((ok: LogicalOrderKey) => ({
    eval: compileExpression(ok.expr, child.columnMapping),
    direction: ok.direction || 'ASC',
  }));

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
  const keyExtractors: KeyExtractor[] = node.orderKeys.map((ok: LogicalOrderKey) => ({
    eval: compileExpression(ok.expr, child.columnMapping),
    direction: ok.direction || 'ASC',
  }));

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
      const childSink: Sink = {
        async consume(chunk: DataChunk) {
          if (cancelToken.isCancelled) return;
          await limitOp.consume(chunk);
          const resultChunks = await limitOp.finalize();
          for (const rc of resultChunks) {
            if (rc.size > 0) await currentSink.consume(rc);
          }
          limitOp.chunks = [];
          if (limitOp.done) {
            cancelToken.cancel();
          }
        },
        async finalize() {
          const resultChunks = await limitOp.finalize();
          for (const rc of resultChunks) {
            if (rc.size > 0) await currentSink.consume(rc);
          }
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

export async function buildUnion(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalUnionNode;
  const left = await executor.buildPipeline(physical.children[0]);
  const right = await executor.buildPipeline(physical.children[1]);

  return {
    schema: left.schema,
    columnMapping: left.columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
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
      } else {
        const leftPipelineId = graph.createPipeline(currentSink);
        const rightPipelineId = graph.createPipeline(currentSink);

        left.register(graph, leftPipelineId, currentSink);
        right.register(graph, rightPipelineId, currentSink);

        graph.addDependency(currentPipelineId, leftPipelineId);
        graph.addDependency(currentPipelineId, rightPipelineId);

        const source: SourceGenerator = async function* () {
        };
        graph.setSource(currentPipelineId, source);
      }
    }
  };
}

export async function buildWindow(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalWindowNode;
  const child = await executor.buildPipeline(physical.children[0]);
  const windowExprs = node.windowExprs as BoundWindowNode[];

  const windowSchema: ExecSchema = [
    ...child.schema,
    ...windowExprs.map((w: BoundWindowNode, i: number): ExecColumn => ({
      name: `__window_${i}`,
      dataType: executor.normalizeExecType(w.resultType || 'FLOAT64'),
      tableAlias: '',
    })),
  ];
  const windowMapping: ColumnMapping = new Map<string, number>();
  let idx = 0;
  for (const col of windowSchema) {
    const key = col.tableAlias ? `${col.tableAlias}.${col.name}`.toUpperCase() : col.name.toUpperCase();
    windowMapping.set(key, idx);
    if (!windowMapping.has(col.name.toUpperCase())) {
      windowMapping.set(col.name.toUpperCase(), idx);
    }
    idx++;
  }
  for (let w = 0; w < windowExprs.length; w++) {
    const wKey = windowExprKey(windowExprs[w]);
    windowMapping.set(wKey, child.schema.length + w);
  }

  return {
    schema: windowSchema,
    columnMapping: windowMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const childChunks = registerBufferedChild(graph, currentPipelineId, child);

      const source: SourceGenerator = async function* () {
        const windowOp = new WindowOperator(windowExprs, child.schema, child.columnMapping, compileExpression);
        const resultChunks = await windowOp.execute(childChunks);
        for (const chunk of resultChunks) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      };
      graph.setSource(currentPipelineId, source);
    }
  };
}

function windowExprKey(expr: BoundWindowNode): string {
  const name = expr.name?.toUpperCase() || 'WIN';
  const argKey = (expr.args || []).map((a: BoundExpr) => {
    if (a.kind === BoundExprKind.COLUMN_REF) return `${a.tableAlias}.${a.columnName}`.toUpperCase();
    return JSON.stringify(a).slice(0, 30);
  }).join(',');
  const partKey = (expr.partitionBy || []).map((p: BoundExpr) => {
    if (p.kind === BoundExprKind.COLUMN_REF) return `${p.tableAlias}.${p.columnName}`.toUpperCase();
    return '';
  }).join(',');
  return `__WIN__${name}(${argKey})[${partKey}]`;
}
