import type { ExecutionCatalog } from '../execution-catalog.js';
import type { PhysicalPlanNode } from '../physical-plan.js';
import { ScanOperator } from '../operators/scan.js';
import { IndexScanOperator } from '../operators/index-scan.js';
import { DataChunk } from '../../storage/chunk.js';
import type { PipelineGraph } from '../pipeline.js';
import type {
  ColumnMapping,
  CompiledPipeline,
  ExecColumn,
  ExecSchema,
  Sink,
  SourceGenerator,
} from '../execution-types.js';
import type {
  LogicalScanNode,
  LogicalIndexScanNode,
} from '../../planner/logical-plan.js';
import type { ColumnInfo } from '../../binder/scope.js';
import { isPagedTableStorage } from '../../storage/table-storage.js';
import { compileChunkPruner, schemaColumnResolver } from '../zone-map-pruner.js';
import { Config } from '../../config.js';

interface ExecutorLike {
  catalog: ExecutionCatalog;
  buildPipeline(node: PhysicalPlanNode): Promise<CompiledPipeline>;
  resolveProjectedColumnIndexes(schema: ExecSchema, planColumns: ColumnInfo[] | null): number[] | null;
  buildSchemaMapping(schema: ExecSchema, alias: string): ColumnMapping;
}

export async function buildScan(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalScanNode;
  const storage = executor.catalog.getTableStorage(node.table);
  if (!storage) throw new Error(`No storage for table: ${node.table}`);

  const schema = storage.getSchema();
  const projectedColumns = executor.resolveProjectedColumnIndexes(schema, node.columns);
  const outputSchema = projectedColumns
    ? projectedColumns.map((i: number) => schema[i])
    : schema;
  const alias = node.alias || node.table;
  const finalSchema = outputSchema.map((c: ExecColumn) => ({ ...c, tableAlias: alias }));
  const columnMapping = executor.buildSchemaMapping(finalSchema, alias);
  const pruner = Config.zoneMapPruning
    ? compileChunkPruner(node.pruningFilter ?? null, schemaColumnResolver(schema, alias))
    : null;

  return {
    schema: finalSchema,
    columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const scanOp = new ScanOperator(storage, projectedColumns, pruner);

      const source: SourceGenerator = async function* () {
        for await (const chunk of scanOp.scan()) {
          if (currentSink.cancelToken?.isCancelled) break;
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      };
      graph.setSource(currentPipelineId, source);
    }
  };
}

export async function buildIndexScan(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalIndexScanNode;
  const storage = executor.catalog.getTableStorage(node.table);
  if (!storage) throw new Error(`No storage for table: ${node.table}`);
  if (!isPagedTableStorage(storage)) throw new Error(`Index scan requires paged storage for table: ${node.table}`);

  const btree = executor.catalog.getIndexForColumn(node.table, node.columnName);
  if (!btree) throw new Error(`No index for ${node.table}.${node.columnName}`);

  const schema = storage.getSchema();
  const projectedColumns = executor.resolveProjectedColumnIndexes(schema, node.columns);
  const outputSchema = projectedColumns ? projectedColumns.map((i: number) => schema[i]) : schema;
  const finalSchema = outputSchema.map((c: ExecColumn) => ({ ...c, tableAlias: node.alias || node.table }));
  const columnMapping = executor.buildSchemaMapping(finalSchema, node.alias || node.table);

  return {
    schema: finalSchema,
    columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const scanOp = new IndexScanOperator(
        btree, storage, node.scanType, node.scanKey,
        node.scanLow, node.scanHigh, node.lowInc, node.highInc,
        projectedColumns
      );
      const source: SourceGenerator = async function* () {
        for await (const chunk of scanOp.scan()) {
          if (currentSink.cancelToken?.isCancelled) break;
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      };
      graph.setSource(currentPipelineId, source);
    }
  };
}

export async function buildSingleRow(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  return {
    schema: [],
    columnMapping: new Map(),
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const source: SourceGenerator = async function* () {
        const chunk = new DataChunk([], 1);
        await currentSink.consume(chunk);
        yield chunk;
        if (currentSink.finalize) await currentSink.finalize();
      };
      graph.setSource(currentPipelineId, source);
    }
  };
}

export async function buildEmpty(executor: ExecutorLike, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const child = await executor.buildPipeline(physical.children[0]);
  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const source: SourceGenerator = async function* () {
      };
      graph.setSource(currentPipelineId, source);
    }
  };
}
