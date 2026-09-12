import type { PhysicalPlanNode } from '../physical-plan.js';
import { ScanOperator } from '../operators/scan.js';
import { IndexScanOperator } from '../operators/index-scan.js';
import { DataChunk } from '../../storage/chunk.js';
import type { PipelineGraph } from '../pipeline.js';
import type {
  CompiledPipeline,
  ExecColumn,
  Sink,
  SourceGenerator,
} from '../execution-types.js';
import type {
  LogicalScanNode,
  LogicalIndexScanNode,
} from '../../planner/logical-plan.js';
import { isPagedTableStorage } from '../../storage/table-storage.js';
import { compileChunkPruner, schemaColumnResolver } from '../zone-map-pruner.js';
import type { ExecutionContext } from '../execution-context.js';
import { Config } from '../../config.js';
import { scanSource } from './builder-utils.js';

export async function buildScan(ctx: ExecutionContext, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalScanNode;
  const storage = ctx.resources.catalog.getTableStorage(node.table);
  if (!storage) throw new Error(`No storage for table: ${node.table}`);

  const schema = storage.getSchema();
  const projectedColumns = ctx.resolveProjectedColumnIndexes(schema, node.columns);
  const outputSchema = projectedColumns
    ? projectedColumns.map((i: number) => schema[i])
    : schema;
  const alias = node.alias || node.table;
  const finalSchema = outputSchema.map((c: ExecColumn) => ({ ...c, tableAlias: alias }));
  const columnMapping = ctx.buildSchemaMapping(finalSchema, alias);
  const pruner = Config.zoneMapPruning
    ? compileChunkPruner(node.pruningFilter ?? null, schemaColumnResolver(schema, alias))
    : null;

  return {
    schema: finalSchema,
    columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const scanOp = new ScanOperator(storage, projectedColumns, pruner);

      graph.setSource(currentPipelineId, scanSource(ctx, currentSink, () => scanOp.scan()));
    }
  };
}

export async function buildIndexScan(ctx: ExecutionContext, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalIndexScanNode;
  const storage = ctx.resources.catalog.getTableStorage(node.table);
  if (!storage) throw new Error(`No storage for table: ${node.table}`);
  if (!isPagedTableStorage(storage)) throw new Error(`Index scan requires paged storage for table: ${node.table}`);

  const btree = ctx.resources.catalog.getIndexForColumn(node.table, node.columnName);
  if (!btree) throw new Error(`No index for ${node.table}.${node.columnName}`);

  const schema = storage.getSchema();
  const projectedColumns = ctx.resolveProjectedColumnIndexes(schema, node.columns);
  const outputSchema = projectedColumns ? projectedColumns.map((i: number) => schema[i]) : schema;
  const finalSchema = outputSchema.map((c: ExecColumn) => ({ ...c, tableAlias: node.alias || node.table }));
  const columnMapping = ctx.buildSchemaMapping(finalSchema, node.alias || node.table);

  return {
    schema: finalSchema,
    columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const scanOp = new IndexScanOperator(
        btree, storage, node.scanType, node.scanKey,
        node.scanLow, node.scanHigh, node.lowInc, node.highInc,
        projectedColumns
      );
      graph.setSource(currentPipelineId, scanSource(ctx, currentSink, () => scanOp.scan()));
    }
  };
}

export async function buildSingleRow(ctx: ExecutionContext, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
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

export async function buildEmpty(ctx: ExecutionContext, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const child = await ctx.buildPipeline(physical.children[0]);
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
