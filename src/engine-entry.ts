import { QueryEngine } from './engine/query-engine.js';
import { Catalog } from './catalog/catalog.js';
import { InMemoryRelation } from './dataframe/in-memory-relation.js';
import type { ColumnSchema, ColumnValue } from './storage/data-type.js';

export type RowInput = Record<string, ColumnValue> | ColumnValue[];

type QueryEngineOptions = ConstructorParameters<typeof QueryEngine>[1];

export type CreateEngineOptions = QueryEngineOptions & { catalog?: Catalog };

export function createEngine(options: CreateEngineOptions = {}): QueryEngine {
  const catalog = options.catalog || new Catalog();
  return new QueryEngine(catalog, options);
}

export function registerTable(engine: QueryEngine, name: string, rows: RowInput[], declaredSchema: ColumnSchema[] | null = null): ColumnSchema[] {
  const relation = InMemoryRelation.fromRows(rows, declaredSchema);
  const schema = relation.getSchema();
  engine.catalog.registerTable(name, schema);
  engine.catalog.registerTableStorage(name, relation);
  return schema;
}

export async function registerStreamingTable(engine: QueryEngine, name: string, schemaOrBatches: ColumnSchema[] | null | AsyncIterable<RowInput[]>, maybeBatches?: AsyncIterable<RowInput[]>): Promise<ColumnSchema[]> {
  let declaredSchema = schemaOrBatches as ColumnSchema[] | null;
  let batches = maybeBatches;
  if (batches === undefined) {
    batches = schemaOrBatches as AsyncIterable<RowInput[]>;
    declaredSchema = null;
  }

  const builder = InMemoryRelation.builder(declaredSchema);
  for await (const batch of batches) {
    builder.appendRows(batch);
  }
  const relation = builder.finish();

  const schema = relation.getSchema();
  engine.catalog.registerTable(name, schema);
  engine.catalog.registerTableStorage(name, relation);
  return schema;
}
