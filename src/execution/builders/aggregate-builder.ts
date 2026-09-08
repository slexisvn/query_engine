import { PhysicalNodeType, type PhysicalPlanNode } from '../physical-plan.js';
import type { TableStorage } from '../../storage/table-storage.js';
import type { ChunkSpillStore } from '../../storage/spill-manager/spill-manager.js';

import type {
  LogicalAggregateNode,
  LogicalPartialAggregateNode,
  LogicalFinalAggregateNode,
} from '../../planner/logical-plan.js';
import { compileExpression } from '../expression-eval.js';
import { exprKey, aggregateKey } from '../../binder/expr-key.js';
import { HashAggregateOperator, getAccumulatorFactory } from '../operators/hash-aggregate.js';
import { StreamAggregateOperator } from '../operators/stream-aggregate.js';
import { buildAggregateDefs, extractAggregateFragment, buildFragmentSpec, normalizeExecType, normalizeAggResultType } from '../fragment-spec.js';
import { Config } from '../../config.js';
import { registerBufferedChild } from './builder-utils.js';
import { DataType } from '../../storage/data-type.js';
import type { DataChunk } from '../../storage/chunk.js';
import type { PipelineGraph } from '../pipeline.js';
import type { ColumnValue } from '../../storage/data-type.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import type { BoundExpr, BoundAggregateNode } from '../../binder/expression-binder.js';
import type { ExecutionContext } from '../execution-context.js';
import type { CompiledExpr, EvalValue, CompiledPipeline, ColumnMapping, ExecColumn, ExecSchema, Sink } from '../execution-types.js';

type HashAggDefs = ConstructorParameters<typeof HashAggregateOperator>[2];
type AccumulatorFactory = ReturnType<typeof getAccumulatorFactory>;
type ExtractValueFn = (chunk: DataChunk, rowIdx: number) => EvalValue | ColumnValue[];
type BuiltFragmentSpec = NonNullable<ReturnType<typeof buildFragmentSpec>>;
type FragmentSpec = BuiltFragmentSpec['spec'];

interface AggDescriptor {
  kind?: BoundExprKind;
  name?: string;
  func?: string;
  distinct?: boolean;
  args?: BoundExpr[];
  outputName?: string;
}

interface GroupByExpr {
  kind?: BoundExprKind;
  columnName?: string;
  tableAlias?: string;
  dataType?: DataType | null;
  resultType?: string | null;
}

interface BuiltAggregateDef {
  name: string;
  resultType: DataType;
  createAccumulator: AccumulatorFactory;
  extractValue: ExtractValueFn;
}

export interface FragmentPoolLike {
  runAggregate(spec: FragmentSpec, columnIndexes: number[], chunks: DataChunk[], options: { spillDir?: string }): Promise<DataChunk[]>;
}

interface ParallelAggregate extends BuiltFragmentSpec {
  storage: TableStorage;
}

type RegisterFn = (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => void;

function aggregateSpillStore(ctx: ExecutionContext, label: string): ChunkSpillStore {
  return ctx.resources.storageBackend.createSpillManager(ctx.resources.tempManager.allocate('spill', label));
}

export async function buildAggregate(ctx: ExecutionContext, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalAggregateNode;
  const child = await ctx.buildPipeline(physical.children[0]);

  const groupByEvals = (node.groupBy || []).map((expr: BoundExpr) =>
    compileExpression(expr, child.columnMapping)
  );
  const groupByTypes = (node.groupBy || []).map((expr: GroupByExpr) =>
    normalizeExecType(expr?.dataType || expr?.resultType || 'VARCHAR')
  );

  const aggDefs = buildAggregateDefs(node.aggregates as BoundAggregateNode[], child.columnMapping) as HashAggDefs;

  const schema: ExecSchema = [
    ...(node.groupBy || []).map((expr: GroupByExpr, i: number) => ({
      name: expr?.columnName || `group${i}`,
      dataType: groupByTypes[i],
      tableAlias: expr?.tableAlias || '',
    })),
    ...(node.aggregates as AggDescriptor[]).map((agg: AggDescriptor, i: number) => ({
      name: agg.outputName || (agg.name || '').toLowerCase(),
      dataType: normalizeAggResultType(agg),
      tableAlias: '',
    })),
  ];

  const columnMapping = aggregateSchemaMapping(schema, node.groupBy || [], node.aggregates as AggDescriptor[]);

  if (physical.type === PhysicalNodeType.STREAM_AGGREGATE) {
    return {
      schema, columnMapping,
      register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
        const childChunks = registerBufferedChild(graph, currentPipelineId, child);

        graph.setSource(currentPipelineId, async function* (): AsyncGenerator<DataChunk> {
          const aggOp = new StreamAggregateOperator(groupByEvals, groupByTypes, aggDefs);
          const resultChunks = await aggOp.execute(childChunks);
          for (const chunk of resultChunks) {
            await currentSink.consume(chunk);
            yield chunk;
          }
          if (currentSink.finalize) await currentSink.finalize();
        });
      }
    };
  }

  const serialCompiled: CompiledPipeline = {
    schema, columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const aggOp = new HashAggregateOperator(groupByEvals, groupByTypes, aggDefs, aggregateSpillStore(ctx, 'agg'));
      const aggSink: Sink = {
        async consume(chunk: DataChunk) { await aggOp.consume(chunk); },
        async finalize() {}
      };
      const childPipelineId = graph.createPipeline(aggSink);
      child.register(graph, childPipelineId, aggSink);

      graph.addDependency(currentPipelineId, childPipelineId);

      graph.setSource(currentPipelineId, async function* (): AsyncGenerator<DataChunk> {
        const resultChunks = await aggOp.finalize();
        for (const chunk of resultChunks) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };

  const parallel = prepareParallelAggregate(ctx, node);
  if (!parallel) return serialCompiled;

  return {
    schema, columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      const rowCount = parallel.storage.rowCount();
      const withinMemory = rowCount * parallel.estimatedRowBytes <= Config.parallelAggMemoryBytes;
      if (rowCount < Config.parallelAggThreshold || !withinMemory) {
        serialCompiled.register(graph, currentPipelineId, currentSink);
        return;
      }
      graph.setSource(currentPipelineId, async function* (): AsyncGenerator<DataChunk> {
        let resultChunks: DataChunk[] | null = null;
        try {
          const chunks: DataChunk[] = [];
          for await (const chunk of parallel.storage.scan()) chunks.push(chunk);
          resultChunks = await ctx.resources.fragmentPool!.runAggregate(parallel.spec, parallel.columnIndexes, chunks, {
            spillDir: ctx.resources.tempManager.allocate('spill', 'pagg'),
          });
        } catch (_) {
          resultChunks = null;
        }
        if (resultChunks === null) {
          resultChunks = await ctx.executeSubPipeline(serialCompiled);
        }
        for (const chunk of resultChunks) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };
}

function prepareParallelAggregate(ctx: ExecutionContext, node: LogicalAggregateNode): ParallelAggregate | null {
  if (!ctx.resources.fragmentPool) return null;
  const fragment = extractAggregateFragment(node);
  if (!fragment) return null;
  const storage = ctx.resources.catalog.getTableStorage(fragment.table);
  if (!storage || typeof storage.scan !== 'function') return null;
  const built = buildFragmentSpec(fragment, node, storage.getSchema()) as BuiltFragmentSpec | null;
  if (!built) return null;
  return { storage, ...built };
}

function aggregateSchemaMapping(schema: ExecSchema, groupBy: BoundExpr[], aggregates: AggDescriptor[]): ColumnMapping {
  const columnMapping: ColumnMapping = new Map<string, number>();
  let idx = 0;
  for (const col of schema) {
    const key = col.tableAlias
      ? `${col.tableAlias}.${col.name}`.toUpperCase()
      : col.name.toUpperCase();
    columnMapping.set(key, idx);
    columnMapping.set(col.name.toUpperCase(), idx);
    idx++;
  }

  const groupByCount = groupBy.length;
  for (let g = 0; g < groupByCount; g++) {
    columnMapping.set(exprKey(groupBy[g]), g);
  }
  for (let a = 0; a < aggregates.length; a++) {
    const agg = aggregates[a];
    columnMapping.set(aggregateKey(agg.name || agg.func || '', !!agg.distinct, (agg.args || []) as BoundExpr[]), groupByCount + a);
  }
  return columnMapping;
}

export async function buildPartialAggregate(ctx: ExecutionContext, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalPartialAggregateNode;
  const child = await ctx.buildPipeline(physical.children[0]);

  const groupByEvals = (node.groupBy || []).map((expr: BoundExpr) =>
    compileExpression(expr, child.columnMapping)
  );
  const groupByTypes = (node.groupBy || []).map((expr: GroupByExpr) =>
    normalizeExecType(expr?.dataType || expr?.resultType || 'VARCHAR')
  );

  const aggDefs: BuiltAggregateDef[] = [];
  const aggSchemaCols: ExecColumn[] = [];
  const mappingAggs: AggDescriptor[] = [];
  for (const agg of node.aggregates as AggDescriptor[]) {
    const funcName = (agg.func || agg.name || '').toUpperCase();
    const valueExtractor = agg.args && agg.args.length > 0
      ? compileExpression(agg.args[0], child.columnMapping)
      : () => 1;
    const extract: CompiledExpr = (chunk: DataChunk, rowIdx: number) => {
      const val = valueExtractor(chunk, rowIdx);
      return typeof val === 'bigint' ? Number(val) : val;
    };

    if (funcName === 'AVG_PARTIAL') {
      aggDefs.push({ name: 'SUM', resultType: DataType.FLOAT64, createAccumulator: getAccumulatorFactory('SUM'), extractValue: extract });
      aggDefs.push({ name: 'COUNT', resultType: DataType.FLOAT64, createAccumulator: getAccumulatorFactory('COUNT'), extractValue: extract });
      aggSchemaCols.push({ name: '_avg_sum', dataType: DataType.FLOAT64, tableAlias: '' });
      aggSchemaCols.push({ name: '_avg_count', dataType: DataType.FLOAT64, tableAlias: '' });
      mappingAggs.push({ func: 'SUM', args: agg.args }, { func: 'COUNT', args: agg.args });
      continue;
    }

    aggDefs.push({
      name: (agg.func || agg.name)!,
      resultType: normalizeAggResultType(agg),
      createAccumulator: getAccumulatorFactory((agg.func || agg.name)!, agg.distinct),
      extractValue: extract,
    });
    aggSchemaCols.push({ name: (agg.func || agg.name || '').toLowerCase(), dataType: normalizeAggResultType(agg), tableAlias: '' });
    mappingAggs.push(agg);
  }

  const schema: ExecSchema = [
    ...(node.groupBy || []).map((expr: GroupByExpr, i: number) => ({
      name: expr?.columnName || `group${i}`,
      dataType: groupByTypes[i],
      tableAlias: expr?.tableAlias || '',
    })),
    ...aggSchemaCols,
  ];

  const columnMapping = aggregateSchemaMapping(schema, node.groupBy || [], mappingAggs);

  return {
    schema, columnMapping,
    register: registerHashAggregate(child, () => new HashAggregateOperator(groupByEvals, groupByTypes, aggDefs as HashAggDefs, aggregateSpillStore(ctx, 'agg'))),
  };
}

export async function buildFinalAggregate(ctx: ExecutionContext, physical: PhysicalPlanNode): Promise<CompiledPipeline> {
  const node = physical.logical as LogicalFinalAggregateNode;
  const child = await ctx.buildPipeline(physical.children[0]);

  const groupByCount = (node.groupBy || []).length;
  const childIndexOf = (expr: BoundExpr | undefined, fallback: number): number =>
    (expr === undefined ? undefined : child.columnMapping?.get(exprKey(expr))) ?? fallback;

  const groupByEvals = (node.groupBy || []).map((expr: BoundExpr, i: number): CompiledExpr => {
    const colIdx = childIndexOf(expr, i);
    return (chunk: DataChunk, rowIdx: number) => chunk.columns[colIdx]?.get(rowIdx) ?? null;
  });
  const groupByTypes = (node.groupBy || []).map((expr: GroupByExpr) =>
    normalizeExecType(expr?.dataType || expr?.resultType || 'VARCHAR')
  );

  const finalAggs = node.aggregates as AggDescriptor[];
  const partialAggs = (node.partialAggregates || finalAggs) as AggDescriptor[];
  const partialWidth = (agg: AggDescriptor) => ((agg.func || agg.name || '').toUpperCase() === 'AVG_PARTIAL' ? 2 : 1);
  const partialStarts: number[] = [];
  let partialOffset = groupByCount;
  for (let i = 0; i < finalAggs.length; i++) {
    const partial = partialAggs[i] || finalAggs[i];
    partialStarts.push(childIndexOf(partial as BoundExpr | undefined, partialOffset));
    partialOffset += partialWidth(partial);
  }

  const aggDefs: BuiltAggregateDef[] = finalAggs.map((agg: AggDescriptor, aggIdx: number) => {
    const funcName = (agg.func || agg.name || '').toUpperCase();
    const start = partialStarts[aggIdx];

    if (funcName === 'AVG_FINAL') {
      return {
        name: 'AVG',
        resultType: normalizeAggResultType(agg),
        createAccumulator: getAccumulatorFactory('AVG_FINAL', false),
        extractValue: (chunk: DataChunk, rowIdx: number): ColumnValue[] => {
          const s = chunk.columns[start]?.get(rowIdx);
          const c = chunk.columns[start + 1]?.get(rowIdx);
          return [
            typeof s === 'bigint' ? Number(s) : s,
            typeof c === 'bigint' ? Number(c) : c,
          ];
        },
      };
    }

    return {
      name: funcName,
      resultType: normalizeAggResultType(agg),
      createAccumulator: getAccumulatorFactory(funcName, false),
      extractValue: (chunk: DataChunk, rowIdx: number) => {
        const val = chunk.columns[start]?.get(rowIdx);
        return typeof val === 'bigint' ? Number(val) : val;
      },
    };
  });

  const schema: ExecSchema = [
    ...(node.groupBy || []).map((expr: GroupByExpr, i: number) => ({
      name: expr?.columnName || `group${i}`,
      dataType: groupByTypes[i],
      tableAlias: expr?.tableAlias || '',
    })),
    ...finalAggs.map((agg: AggDescriptor) => ({
      name: (agg.name || agg.func || '').toLowerCase(),
      dataType: normalizeAggResultType(agg),
      tableAlias: '',
    })),
  ];

  const columnMapping = aggregateSchemaMapping(schema, node.groupBy || [], finalAggs);

  return {
    schema, columnMapping,
    register: registerHashAggregate(child, () => new HashAggregateOperator(groupByEvals, groupByTypes, aggDefs as HashAggDefs, aggregateSpillStore(ctx, 'agg'))),
  };
}

function registerHashAggregate(child: CompiledPipeline, makeAggOp: () => HashAggregateOperator): RegisterFn {
  return (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
    const aggOp = makeAggOp();
    const aggSink: Sink = {
      async consume(chunk: DataChunk) { await aggOp.consume(chunk); },
      async finalize() {}
    };
    const childPipelineId = graph.createPipeline(aggSink);
    child.register(graph, childPipelineId, aggSink);

    graph.addDependency(currentPipelineId, childPipelineId);

    graph.setSource(currentPipelineId, async function* (): AsyncGenerator<DataChunk> {
      const resultChunks = await aggOp.finalize();
      for (const chunk of resultChunks) {
        await currentSink.consume(chunk);
        yield chunk;
      }
      if (currentSink.finalize) await currentSink.finalize();
    });
  };
}
