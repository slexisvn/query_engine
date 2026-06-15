import { PhysicalStrategy } from '../../planner/logical-plan.js';
import { compileExpression, aggExprKey } from '../expression-eval.js';
import { HashAggregateOperator, getAccumulatorFactory } from '../operators/hash-aggregate.js';
import { StreamAggregateOperator } from '../operators/stream-aggregate.js';
import { buildAggregateDefs, extractAggregateFragment, buildFragmentSpec } from '../fragment-spec.js';
import { Config } from '../../config.js';
import { registerBufferedChild } from './builder-utils.js';

export async function buildAggregate(executor: any, node: any): Promise<any> {
  const child = await executor.buildPipeline(node.children[0]);

  const groupByEvals = (node.groupBy || []).map((expr: any) =>
    compileExpression(expr, child.columnMapping)
  );
  const groupByTypes = (node.groupBy || []).map((expr: any) =>
    executor.normalizeExecType(expr?.dataType || expr?.resultType || 'VARCHAR')
  );

  const aggDefs = buildAggregateDefs(node.aggregates, child.columnMapping);

  const schema = [
    ...(node.groupBy || []).map((expr: any, i: any) => ({
      name: expr?.columnName || `group${i}`,
      dataType: groupByTypes[i],
      tableAlias: expr?.tableAlias || '',
    })),
    ...node.aggregates.map((agg: any, i: any) => ({
      name: agg.outputName || agg.name.toLowerCase(),
      dataType: executor.normalizeAggResultType(agg),
      tableAlias: '',
    })),
  ];

  const columnMapping = aggregateSchemaMapping(schema, node.groupBy || [], node.aggregates);

  if (node.physicalStrategy === PhysicalStrategy.STREAM) {
    return {
      schema, columnMapping,
      register: (graph: any, currentPipelineId: any, currentSink: any) => {
        const childChunks = registerBufferedChild(graph, currentPipelineId, child);

        graph.setSource(currentPipelineId, async function* () {
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

  const serialCompiled = {
    schema, columnMapping,
    register: (graph: any, currentPipelineId: any, currentSink: any) => {
      const aggOp = new HashAggregateOperator(groupByEvals, groupByTypes, aggDefs);
      const aggSink = {
        async consume(chunk: any) { await aggOp.consume(chunk); },
        async finalize() {}
      };
      const childPipelineId = graph.createPipeline(aggSink);
      child.register(graph, childPipelineId, aggSink);

      graph.addDependency(currentPipelineId, childPipelineId);

      graph.setSource(currentPipelineId, async function* () {
        const resultChunks = await aggOp.finalize();
        for (const chunk of resultChunks) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };

  const parallel = prepareParallelAggregate(executor, node);
  if (!parallel) return serialCompiled;

  return {
    schema, columnMapping,
    register: (graph: any, currentPipelineId: any, currentSink: any) => {
      const rowCount = parallel.storage.rowCount();
      const withinMemory = rowCount * parallel.estimatedRowBytes <= Config.parallelAggMemoryBytes;
      if (rowCount < Config.parallelAggThreshold || !withinMemory) {
        serialCompiled.register(graph, currentPipelineId, currentSink);
        return;
      }
      graph.setSource(currentPipelineId, async function* () {
        let resultChunks: any = null;
        try {
          const chunks: any[] = [];
          for await (const chunk of parallel.storage.scan()) chunks.push(chunk);
          resultChunks = await executor.fragmentPool.runAggregate(parallel.spec, parallel.columnIndexes, chunks, {
            spillDir: executor.tempManager.allocate('spill', 'pagg'),
          });
        } catch (_) {
          resultChunks = null;
        }
        if (resultChunks === null) {
          resultChunks = await executor._executeSubPipeline(serialCompiled);
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

function prepareParallelAggregate(executor: any, node: any): any {
  if (!executor.fragmentPool) return null;
  const fragment = extractAggregateFragment(node);
  if (!fragment) return null;
  const storage = executor.catalog.getTableStorage(fragment.table);
  if (!storage || typeof storage.scan !== 'function') return null;
  const built = buildFragmentSpec(fragment, node, storage.getSchema());
  if (!built) return null;
  return { storage, ...built };
}

function aggregateSchemaMapping(schema: any, groupBy: any, aggregates: any): any {
  const columnMapping = new Map<string, any>();
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
  for (let a = 0; a < aggregates.length; a++) {
    columnMapping.set(aggExprKey(aggregates[a]), groupByCount + a);
  }
  return columnMapping;
}

export async function buildPartialAggregate(executor: any, node: any): Promise<any> {
  const child = await executor.buildPipeline(node.children[0]);

  const groupByEvals = (node.groupBy || []).map((expr: any) =>
    compileExpression(expr, child.columnMapping)
  );
  const groupByTypes = (node.groupBy || []).map((expr: any) =>
    executor.normalizeExecType(expr?.dataType || expr?.resultType || 'VARCHAR')
  );

  const aggDefs: any[] = [];
  const aggSchemaCols: any[] = [];
  const mappingAggs: any[] = [];
  for (const agg of node.aggregates) {
    const funcName = (agg.func || agg.name || '').toUpperCase();
    const valueExtractor = agg.args && agg.args.length > 0
      ? compileExpression(agg.args[0], child.columnMapping)
      : () => 1;
    const extract = (chunk: any, rowIdx: any) => {
      const val = valueExtractor(chunk, rowIdx);
      return typeof val === 'bigint' ? Number(val) : val;
    };

    if (funcName === 'AVG_PARTIAL') {
      aggDefs.push({ name: 'SUM', resultType: 'FLOAT64', createAccumulator: getAccumulatorFactory('SUM'), extractValue: extract });
      aggDefs.push({ name: 'COUNT', resultType: 'FLOAT64', createAccumulator: getAccumulatorFactory('COUNT'), extractValue: extract });
      aggSchemaCols.push({ name: '_avg_sum', dataType: 'FLOAT64', tableAlias: '' });
      aggSchemaCols.push({ name: '_avg_count', dataType: 'FLOAT64', tableAlias: '' });
      mappingAggs.push({ func: 'SUM', args: agg.args }, { func: 'COUNT', args: agg.args });
      continue;
    }

    aggDefs.push({
      name: agg.func || agg.name,
      resultType: executor.normalizeAggResultType(agg),
      createAccumulator: getAccumulatorFactory(agg.func || agg.name, agg.distinct),
      extractValue: extract,
    });
    aggSchemaCols.push({ name: (agg.func || agg.name || '').toLowerCase(), dataType: executor.normalizeAggResultType(agg), tableAlias: '' });
    mappingAggs.push(agg);
  }

  const schema = [
    ...(node.groupBy || []).map((expr: any, i: any) => ({
      name: expr?.columnName || `group${i}`,
      dataType: groupByTypes[i],
      tableAlias: expr?.tableAlias || '',
    })),
    ...aggSchemaCols,
  ];

  const columnMapping = aggregateSchemaMapping(schema, node.groupBy || [], mappingAggs);

  return {
    schema, columnMapping,
    register: registerHashAggregate(child, () => new HashAggregateOperator(groupByEvals, groupByTypes, aggDefs)),
  };
}

export async function buildFinalAggregate(executor: any, node: any): Promise<any> {
  const child = await executor.buildPipeline(node.children[0]);

  const groupByCount = (node.groupBy || []).length;
  const groupByEvals = (node.groupBy || []).map((_expr: any, i: any) => {
    const colIdx = i;
    return (chunk: any, rowIdx: any) => chunk.columns[colIdx]?.get(rowIdx);
  });
  const groupByTypes = (node.groupBy || []).map((expr: any) =>
    executor.normalizeExecType(expr?.dataType || expr?.resultType || 'VARCHAR')
  );

  const finalAggs = node.aggregates;
  const partialAggs = node.partialAggregates || finalAggs;
  const partialWidth = (agg: any) => ((agg.func || agg.name || '').toUpperCase() === 'AVG_PARTIAL' ? 2 : 1);
  const partialStarts: any[] = [];
  let partialOffset = groupByCount;
  for (let i = 0; i < finalAggs.length; i++) {
    partialStarts.push(partialOffset);
    partialOffset += partialWidth(partialAggs[i] || finalAggs[i]);
  }

  const aggDefs = finalAggs.map((agg: any, aggIdx: any) => {
    const funcName = (agg.func || agg.name || '').toUpperCase();
    const start = partialStarts[aggIdx];

    if (funcName === 'AVG_FINAL') {
      return {
        name: 'AVG',
        resultType: executor.normalizeAggResultType(agg),
        createAccumulator: getAccumulatorFactory('AVG_FINAL', false),
        extractValue: (chunk: any, rowIdx: any) => {
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
      resultType: executor.normalizeAggResultType(agg),
      createAccumulator: getAccumulatorFactory(funcName, false),
      extractValue: (chunk: any, rowIdx: any) => {
        const val = chunk.columns[start]?.get(rowIdx);
        return typeof val === 'bigint' ? Number(val) : val;
      },
    };
  });

  const schema = [
    ...(node.groupBy || []).map((expr: any, i: any) => ({
      name: expr?.columnName || `group${i}`,
      dataType: groupByTypes[i],
      tableAlias: expr?.tableAlias || '',
    })),
    ...finalAggs.map((agg: any) => ({
      name: (agg.name || agg.func || '').toLowerCase(),
      dataType: executor.normalizeAggResultType(agg),
      tableAlias: '',
    })),
  ];

  const columnMapping = aggregateSchemaMapping(schema, node.groupBy || [], finalAggs);

  return {
    schema, columnMapping,
    register: registerHashAggregate(child, () => new HashAggregateOperator(groupByEvals, groupByTypes, aggDefs)),
  };
}

function registerHashAggregate(child: any, makeAggOp: any): any {
  return (graph: any, currentPipelineId: any, currentSink: any) => {
    const aggOp = makeAggOp();
    const aggSink = {
      async consume(chunk: any) { await aggOp.consume(chunk); },
      async finalize() {}
    };
    const childPipelineId = graph.createPipeline(aggSink);
    child.register(graph, childPipelineId, aggSink);

    graph.addDependency(currentPipelineId, childPipelineId);

    graph.setSource(currentPipelineId, async function* () {
      const resultChunks = await aggOp.finalize();
      for (const chunk of resultChunks) {
        await currentSink.consume(chunk);
        yield chunk;
      }
      if (currentSink.finalize) await currentSink.finalize();
    });
  };
}
