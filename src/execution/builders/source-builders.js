import { ScanOperator } from '../operators/scan.js';
import { IndexScanOperator } from '../operators/index-scan.js';
import { DataChunk } from '../../storage/chunk.js';

export async function buildScan(executor, node) {
  const storage = executor.catalog.getTableStorage(node.table);
  if (!storage) throw new Error(`No storage for table: ${node.table}`);

  const schema = storage.getSchema();
  const projectedColumns = executor.resolveProjectedColumnIndexes(schema, node.columns);
  const outputSchema = projectedColumns
    ? projectedColumns.map(i => schema[i])
    : schema;
  const finalSchema = outputSchema.map(c => ({ ...c, tableAlias: node.alias || node.table }));
  const columnMapping = executor.buildSchemaMapping(finalSchema, node.alias || node.table);

  return {
    schema: finalSchema,
    columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      const scanOp = new ScanOperator(storage, projectedColumns);

      graph.setSource(currentPipelineId, async function* () {
        for await (const chunk of scanOp.scan()) {
          if (currentSink.cancelToken?.isCancelled) break;
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };
}

export async function buildIndexScan(executor, node) {
  const storage = executor.catalog.getTableStorage(node.table);
  if (!storage) throw new Error(`No storage for table: ${node.table}`);

  const btree = executor.catalog.getIndexForColumn(node.table, node.columnName);
  if (!btree) throw new Error(`No index for ${node.table}.${node.columnName}`);

  const schema = storage.getSchema();
  const projectedColumns = executor.resolveProjectedColumnIndexes(schema, node.columns);
  const outputSchema = projectedColumns ? projectedColumns.map(i => schema[i]) : schema;
  const finalSchema = outputSchema.map(c => ({ ...c, tableAlias: node.alias || node.table }));
  const columnMapping = executor.buildSchemaMapping(finalSchema, node.alias || node.table);

  return {
    schema: finalSchema,
    columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      const scanOp = new IndexScanOperator(
        btree, storage, node.scanType, node.scanKey,
        node.scanLow, node.scanHigh, node.lowInc, node.highInc,
        projectedColumns
      );
      graph.setSource(currentPipelineId, async function* () {
        for await (const chunk of scanOp.scan()) {
          if (currentSink.cancelToken?.isCancelled) break;
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };
}

export async function buildSingleRow(executor, node) {
  return {
    schema: [],
    columnMapping: new Map(),
    register: (graph, currentPipelineId, currentSink) => {
      graph.setSource(currentPipelineId, async function* () {
        const chunk = new DataChunk([], 1);
        await currentSink.consume(chunk);
        yield chunk;
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };
}

export async function buildEmpty(executor, node) {
  const child = await executor.buildPipeline(node.children[0]);
  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      graph.setSource(currentPipelineId, async function* () {
      });
    }
  };
}
