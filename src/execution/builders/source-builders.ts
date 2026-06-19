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
  LogicalPlanNode,
  LogicalScanNode,
  LogicalIndexScanNode,
  LogicalSingleRowNode,
  LogicalEmptyNode,
} from '../../planner/logical-plan.js';
import type { ColumnInfo } from '../../binder/scope.js';

type ScanStorage = ConstructorParameters<typeof ScanOperator>[0];
type IndexStorage = ConstructorParameters<typeof IndexScanOperator>[1];
type IndexBTree = ConstructorParameters<typeof IndexScanOperator>[0];

interface CatalogLike {
  getTableStorage(name: string): (ScanStorage & IndexStorage) | null;
  getIndexForColumn(table: string, column: string): IndexBTree | null;
}

interface ExecutorLike {
  catalog: CatalogLike;
  buildPipeline(node: LogicalPlanNode): Promise<CompiledPipeline>;
  resolveProjectedColumnIndexes(schema: ExecSchema, planColumns: ColumnInfo[] | null): number[] | null;
  buildSchemaMapping(schema: ExecSchema, alias: string): ColumnMapping;
}

export async function buildScan(executor: ExecutorLike, node: LogicalScanNode): Promise<CompiledPipeline> {
  const storage = executor.catalog.getTableStorage(node.table);
  if (!storage) throw new Error(`No storage for table: ${node.table}`);

  const schema = storage.getSchema();
  const projectedColumns = executor.resolveProjectedColumnIndexes(schema, node.columns);
  const outputSchema = projectedColumns
    ? projectedColumns.map((i: number) => schema[i])
    : schema;
  const finalSchema = outputSchema.map((c: ExecColumn) => ({ ...c, tableAlias: node.alias || node.table }));
  const columnMapping = executor.buildSchemaMapping(finalSchema, node.alias || node.table);

  return {
    schema: finalSchema,
    columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const scanOp = new ScanOperator(storage, projectedColumns);

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

export async function buildIndexScan(executor: ExecutorLike, node: LogicalIndexScanNode): Promise<CompiledPipeline> {
  const storage = executor.catalog.getTableStorage(node.table);
  if (!storage) throw new Error(`No storage for table: ${node.table}`);

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

export async function buildSingleRow(executor: ExecutorLike, node: LogicalSingleRowNode): Promise<CompiledPipeline> {
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

export async function buildEmpty(executor: ExecutorLike, node: LogicalEmptyNode): Promise<CompiledPipeline> {
  const child = await executor.buildPipeline(node.children![0]);
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
