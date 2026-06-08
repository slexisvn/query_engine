import { PlanNodeType, JoinType, getChildren, PhysicalStrategy } from '../planner/logical-plan.js';
import { compileExpression, buildColumnMapping, aggExprKey } from './expression-eval.js';
import { ScanOperator } from './operators/scan.js';
import { FilterOperator } from './operators/filter.js';
import { ProjectionOperator } from './operators/projection.js';
import { HashJoinBuild, HashJoinProbe } from './operators/hash-join.js';
import { MergeJoinOperator } from './operators/merge-join.js';
import { NestedLoopJoinOperator } from './operators/nested-loop-join.js';
import { HashAggregateOperator, getAccumulatorFactory } from './operators/hash-aggregate.js';
import { StreamAggregateOperator } from './operators/stream-aggregate.js';
import { SortOperator, LimitOperator } from './operators/sort.js';
import { DistinctOperator } from './operators/distinct.js';
import { UnionOperator } from './operators/union.js';
import { DependentJoinOperator } from './operators/dependent-join.js';
import { IndexScanOperator } from './operators/index-scan.js';
import { extractJoinKeys } from './join-utils.js';
import { WindowOperator } from './operators/window.js';
import { SpillManager, FsStorage } from '../storage/spill-manager.js';
import { ResultSink } from './result-sink.js';
import { BoundExprKind } from '../binder/expression-binder.js';
import { DataChunk } from '../storage/chunk.js';
import { Column } from '../storage/column.js';
import { PipelineGraph, CancelToken } from './pipeline.js';
import { TaskScheduler } from './scheduler.js';
import { Config } from '../config.js';

export class QueryExecutor {
  constructor(catalog, tempManager) {
    this.catalog = catalog;
    this.tempManager = tempManager;
    this.cteResults = new Map();
    this.cteDefinitions = new Map();
    this.workerPool = null;
    this.parallelDispatch = null;
  }

  setParallelContext(workerPool, parallelDispatch) {
    this.workerPool = workerPool;
    this.parallelDispatch = parallelDispatch;
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
    switch (node.type) {
      case PlanNodeType.SCAN: return this.buildScan(node);
      case PlanNodeType.INDEX_SCAN: return this.buildIndexScan(node);
      case PlanNodeType.FILTER: return this.buildFilter(node);
      case PlanNodeType.PROJECT: return this.buildProject(node);
      case PlanNodeType.JOIN: return this.buildJoin(node);
      case PlanNodeType.AGGREGATE: return this.buildAggregate(node);
      case PlanNodeType.SORT: return this.buildSort(node);
      case PlanNodeType.LIMIT: return this.buildLimit(node);
      case PlanNodeType.DISTINCT: return this.buildDistinct(node);
      case PlanNodeType.UNION: return this.buildUnion(node);
      case PlanNodeType.CTE_ANCHOR: return this.buildCTEAnchor(node);
      case PlanNodeType.CTE_SCAN: return this.buildCTEScan(node);
      case PlanNodeType.MATERIALIZE: return this.buildMaterialize(node);
      case PlanNodeType.DEPENDENT_JOIN: return this.buildDependentJoin(node);
      case PlanNodeType.TOP_N: return this.buildTopN(node);
      case PlanNodeType.WINDOW: return this.buildWindow(node);
      case PlanNodeType.EMPTY: return this.buildEmpty(node);
      default:
        throw new Error(`Unsupported plan node: ${node.type}`);
    }
  }

  async buildEmpty(node) {
    const child = await this.buildPipeline(node.children[0]);
    return {
      schema: child.schema,
      columnMapping: child.columnMapping,
      register: (graph, currentPipelineId, currentSink) => {
        graph.setSource(currentPipelineId, async function* () {
        });
      }
    };
  }

  async buildScan(node) {
    const storage = this.catalog.getTableStorage(node.table);
    if (!storage) throw new Error(`No storage for table: ${node.table}`);

    const schema = storage.getSchema();
    const projectedColumns = this.resolveProjectedColumnIndexes(schema, node.columns);
    const outputSchema = projectedColumns
      ? projectedColumns.map(i => schema[i])
      : schema;
    const finalSchema = outputSchema.map(c => ({ ...c, tableAlias: node.alias || node.table }));
    const columnMapping = this.buildSchemaMapping(finalSchema, node.alias || node.table);

    const useParallel = this._shouldParallelize(storage);

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

  async buildIndexScan(node) {
    const storage = this.catalog.getTableStorage(node.table);
    if (!storage) throw new Error(`No storage for table: ${node.table}`);

    const btree = this.catalog.getIndexForColumn(node.table, node.columnName);
    if (!btree) throw new Error(`No index for ${node.table}.${node.columnName}`);

    const schema = storage.getSchema();
    const projectedColumns = this.resolveProjectedColumnIndexes(schema, node.columns);
    const outputSchema = projectedColumns ? projectedColumns.map(i => schema[i]) : schema;
    const finalSchema = outputSchema.map(c => ({ ...c, tableAlias: node.alias || node.table }));
    const columnMapping = this.buildSchemaMapping(finalSchema, node.alias || node.table);

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

  async buildFilter(node) {
    const child = await this.buildPipeline(node.children[0]);
    const evalFn = compileExpression(node.condition, child.columnMapping);
    const parallelDispatch = this.parallelDispatch;

    return {
      schema: child.schema,
      columnMapping: child.columnMapping,
      register: (graph, currentPipelineId, currentSink) => {
        const filterOp = new FilterOperator(node.condition, evalFn, child.columnMapping, parallelDispatch);
        const childSink = {
          get cancelToken() { return currentSink.cancelToken; },
          async consume(chunk) {
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

  async buildProject(node) {
    const child = await this.buildPipeline(node.children[0]);
    const evaluators = node.expressions.map(expr => compileExpression(expr, child.columnMapping));
    const resultTypes = node.expressions.map(expr => this.normalizeExecType(expr?.dataType || expr?.resultType || 'VARCHAR'));

    const schema = node.expressions.map((expr, i) => ({
      name: expr?.outputName || expr?.alias || expr?.name || expr?.columnName || `col${i}`,
      dataType: this.normalizeExecType(expr?.dataType || expr?.resultType || 'VARCHAR'),
      tableAlias: '',
    }));
    const columnMapping = this.buildSchemaMapping(schema, '');

    return {
      schema,
      columnMapping,
      register: (graph, currentPipelineId, currentSink) => {
        const projOp = new ProjectionOperator(node.expressions, evaluators, resultTypes, child.columnMapping, this.parallelDispatch);
        const childSink = {
          get cancelToken() { return currentSink.cancelToken; },
          async consume(chunk) {
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

  async buildJoin(node) {
    const left = await this.buildPipeline(node.children[0]);
    const right = await this.buildPipeline(node.children[1]);

    const isSemiAnti = node.joinType === JoinType.SEMI || node.joinType === JoinType.ANTI;
    const isMark = node.joinType === JoinType.MARK;
    let buildInput, probeInput;
    if (isSemiAnti || isMark) {
      buildInput = right;
      probeInput = left;
    } else if (node._buildSide === 'right') {
      buildInput = right;
      probeInput = left;
    } else {
      buildInput = left;
      probeInput = right;
    }

    const combinedSchema = [...buildInput.schema, ...probeInput.schema];
    const combinedMapping = new Map();
    let idx = 0;

        for (const col of buildInput.schema) {
      const key = `${col.tableAlias}.${col.name}`.toUpperCase();
      combinedMapping.set(key, idx);
      if (!combinedMapping.has(col.name.toUpperCase())) {
        combinedMapping.set(col.name.toUpperCase(), idx);
      }
      idx++;
    }
    for (const col of probeInput.schema) {
      const key = `${col.tableAlias}.${col.name}`.toUpperCase();
      combinedMapping.set(key, idx);
      if (!combinedMapping.has(col.name.toUpperCase())) {
        combinedMapping.set(col.name.toUpperCase(), idx);
      }
      idx++;
    }

    const { buildKeys, probeKeys, residualCondition } = extractJoinKeys(
      node.condition, buildInput.columnMapping, probeInput.columnMapping
    );

    const conditionEvaluator = residualCondition
      ? compileExpression(residualCondition, combinedMapping)
      : null;

    const markSchema = isMark
      ? [...left.schema, { name: node.markColumn || '__mark', dataType: 'BOOLEAN', tableAlias: '' }]
      : null;
    const resultSchema = isSemiAnti ? left.schema : isMark ? markSchema : combinedSchema;
    const resultMapping = isSemiAnti
      ? left.columnMapping
      : isMark
        ? this.buildSchemaMapping(markSchema, '')
        : combinedMapping;

    if (node.physicalStrategy === PhysicalStrategy.MERGE) {
      let mergeBuild = buildInput;
      let mergeProbe = probeInput;
      let mergeBuildKeys = buildKeys;
      let mergeProbeKeys = probeKeys;
      let mergeSchema = resultSchema;
      let mergeMapping = resultMapping;
      if (node.joinType === JoinType.LEFT && buildInput !== left) {
        mergeBuild = left;
        mergeProbe = right;
        mergeBuildKeys = probeKeys;
        mergeProbeKeys = buildKeys;
        mergeSchema = [...left.schema, ...right.schema];
        mergeMapping = new Map();
        let mi = 0;
        for (const col of left.schema) {
          const key = `${col.tableAlias}.${col.name}`.toUpperCase();
          mergeMapping.set(key, mi);
          if (!mergeMapping.has(col.name.toUpperCase())) mergeMapping.set(col.name.toUpperCase(), mi);
          mi++;
        }
        for (const col of right.schema) {
          const key = `${col.tableAlias}.${col.name}`.toUpperCase();
          mergeMapping.set(key, mi);
          if (!mergeMapping.has(col.name.toUpperCase())) mergeMapping.set(col.name.toUpperCase(), mi);
          mi++;
        }
      } else if (node.joinType === JoinType.RIGHT && buildInput !== right) {
        mergeBuild = right;
        mergeProbe = left;
        mergeBuildKeys = probeKeys;
        mergeProbeKeys = buildKeys;
        mergeSchema = [...right.schema, ...left.schema];
        mergeMapping = new Map();
        let mi = 0;
        for (const col of right.schema) {
          const key = `${col.tableAlias}.${col.name}`.toUpperCase();
          mergeMapping.set(key, mi);
          if (!mergeMapping.has(col.name.toUpperCase())) mergeMapping.set(col.name.toUpperCase(), mi);
          mi++;
        }
        for (const col of left.schema) {
          const key = `${col.tableAlias}.${col.name}`.toUpperCase();
          mergeMapping.set(key, mi);
          if (!mergeMapping.has(col.name.toUpperCase())) mergeMapping.set(col.name.toUpperCase(), mi);
          mi++;
        }
      }
      return {
        schema: mergeSchema,
        columnMapping: mergeMapping,
        register: (graph, currentPipelineId, currentSink) => {
          const leftChunks = [];
          const rightChunks = [];

                    const leftSink = {
            consume: async (c) => leftChunks.push(c),
            finalize: async () => {}
          };
          const rightSink = {
            consume: async (c) => rightChunks.push(c),
            finalize: async () => {}
          };

                    const leftPipelineId = graph.createPipeline(leftSink);
          const rightPipelineId = graph.createPipeline(rightSink);

                    left.register(graph, leftPipelineId, leftSink);
          right.register(graph, rightPipelineId, rightSink);

                    graph.addDependency(currentPipelineId, leftPipelineId);
          graph.addDependency(currentPipelineId, rightPipelineId);

                    graph.setSource(currentPipelineId, async function* () {
            const mergeJoin = new MergeJoinOperator(
              mergeBuild === left ? leftChunks : rightChunks,
              mergeProbe === left ? leftChunks : rightChunks,
              mergeBuildKeys.map(k => compileExpression(k, mergeBuild.columnMapping)),
              mergeProbeKeys.map(k => compileExpression(k, mergeProbe.columnMapping)),
              mergeBuild.schema.length,
              mergeProbe.schema.length,
              node.joinType,
              conditionEvaluator
            );

                        const resultChunks = await mergeJoin.execute();
            for (const chunk of resultChunks) {
              await currentSink.consume(chunk);
              yield chunk;
            }
            if (currentSink.finalize) await currentSink.finalize();
          });
        }
      };
    }

    if (node.physicalStrategy === PhysicalStrategy.NESTED_LOOP) {
      const nlOuter = buildInput === left ? buildInput : probeInput;
      const nlInner = buildInput === left ? probeInput : buildInput;
      const nlMapping = new Map();
      let nlIdx = 0;
      for (const col of nlOuter.schema) {
        const key = `${col.tableAlias}.${col.name}`.toUpperCase();
        nlMapping.set(key, nlIdx);
        if (!nlMapping.has(col.name.toUpperCase())) nlMapping.set(col.name.toUpperCase(), nlIdx);
        nlIdx++;
      }
      for (const col of nlInner.schema) {
        const key = `${col.tableAlias}.${col.name}`.toUpperCase();
        nlMapping.set(key, nlIdx);
        if (!nlMapping.has(col.name.toUpperCase())) nlMapping.set(col.name.toUpperCase(), nlIdx);
        nlIdx++;
      }
      const nlCondition = node.condition
        ? compileExpression(node.condition, nlMapping)
        : null;
      const nlSchema = [...nlOuter.schema, ...nlInner.schema];
      const nlResultMapping = isSemiAnti ? left.columnMapping : nlMapping;
      const nlResultSchema = isSemiAnti ? left.schema : isMark ? markSchema : nlSchema;
      return {
        schema: nlResultSchema,
        columnMapping: nlResultMapping,
        register: (graph, currentPipelineId, currentSink) => {
          const leftChunks = [];
          const rightChunks = [];
          const leftSink = { consume: async (c) => leftChunks.push(c), finalize: async () => {} };
          const rightSink = { consume: async (c) => rightChunks.push(c), finalize: async () => {} };
          const leftPipelineId = graph.createPipeline(leftSink);
          const rightPipelineId = graph.createPipeline(rightSink);
          left.register(graph, leftPipelineId, leftSink);
          right.register(graph, rightPipelineId, rightSink);
          graph.addDependency(currentPipelineId, leftPipelineId);
          graph.addDependency(currentPipelineId, rightPipelineId);
          graph.setSource(currentPipelineId, async function* () {
            const nlJoin = new NestedLoopJoinOperator(
              nlOuter === left ? leftChunks : rightChunks,
              nlInner === left ? leftChunks : rightChunks,
              nlOuter.schema.length,
              nlInner.schema.length,
              node.joinType,
              nlCondition
            );
            const resultChunks = await nlJoin.execute();
            for (const chunk of resultChunks) {
              await currentSink.consume(chunk);
              yield chunk;
            }
            if (currentSink.finalize) await currentSink.finalize();
          });
        }
      };
    }

    const joinSpillPath = this.tempManager.allocate('spill', 'join');
    return {
      schema: resultSchema,
      columnMapping: resultMapping,
      register: (graph, currentPipelineId, currentSink) => {
        const buildSide = new HashJoinBuild(
          buildKeys.map(k => compileExpression(k, buildInput.columnMapping)),
          node.joinType,
          !!node._dedupeBuild && !conditionEvaluator,
          new SpillManager(new FsStorage(joinSpillPath)),
        );

        const buildSink = {
          async consume(chunk) { await buildSide.consume(chunk); },
          async finalize() { await buildSide.finalize(); }
        };
        const buildPipelineId = graph.createPipeline(buildSink);
        buildInput.register(graph, buildPipelineId, buildSink);

        const probeOp = new HashJoinProbe(
          buildSide,
          probeKeys.map(k => compileExpression(k, probeInput.columnMapping)),
          buildInput.schema.length,
          probeInput.schema.length,
          node.joinType,
          conditionEvaluator
        );

        const probeSink = {
          get cancelToken() { return currentSink.cancelToken; },
          async consume(chunk) {
            if (this.cancelToken?.isCancelled) return;
            const result = await probeOp.process(chunk);
            if (result && result.size > 0) {
              await currentSink.consume(result);
            }
          },
          async finalize() {
            if (node.joinType === JoinType.LEFT || node.joinType === JoinType.FULL) {
              const unmatchedRows = buildSide.emitUnmatched(probeInput.schema.length);
              if (unmatchedRows.length > 0) {
                await currentSink.consume(probeOp.buildOutputChunk(unmatchedRows));
              }
            }
            if (probeOp.finalize) {
              await probeOp.finalize(currentSink);
            }
            if (currentSink.finalize) await currentSink.finalize();
          }
        };

        graph.addDependency(currentPipelineId, buildPipelineId);
        probeInput.register(graph, currentPipelineId, probeSink);
      }
    };
  }

  async buildAggregate(node) {
    const child = await this.buildPipeline(node.children[0]);

    const groupByEvals = (node.groupBy || []).map(expr =>
      compileExpression(expr, child.columnMapping)
    );
    const groupByTypes = (node.groupBy || []).map(expr =>
      this.normalizeExecType(expr?.dataType || expr?.resultType || 'VARCHAR')
    );

    const valueKeyCounts = new Map();
    for (const agg of node.aggregates) {
      if (agg.args.length === 0) continue;
      const key = expressionCacheKey(agg.args[0]);
      valueKeyCounts.set(key, (valueKeyCounts.get(key) || 0) + 1);
    }

    const aggDefs = node.aggregates.map(agg => {
      const valueExtractor = agg.args.length > 0
        ? compileExpression(agg.args[0], child.columnMapping)
        : () => 1;
      const valueKey = agg.args.length > 0 ? expressionCacheKey(agg.args[0]) : null;

      let wasmColIndex = undefined;
      if (agg.args.length > 0 && agg.args[0].kind === BoundExprKind.COLUMN_REF) {
        const colExpr = agg.args[0];
        const colKey = colExpr.tableAlias
          ? `${colExpr.tableAlias}.${colExpr.columnName}`.toUpperCase()
          : colExpr.columnName.toUpperCase();
        const resolved = child.columnMapping.get(colKey) ?? child.columnMapping.get(colExpr.columnName.toUpperCase());
        if (resolved !== undefined) wasmColIndex = resolved;
      }

      return {
        name: agg.name,
        valueKey: valueKey && valueKeyCounts.get(valueKey) > 1 ? valueKey : null,
        resultType: this.normalizeAggResultType(agg),
        createAccumulator: getAccumulatorFactory(agg.name, agg.distinct),
        extractValue: (chunk, rowIdx) => {
          const val = valueExtractor(chunk, rowIdx);
          return typeof val === 'bigint' ? Number(val) : val;
        },
        _wasmColIndex: wasmColIndex,
        _sourceExpr: agg.args.length > 0 ? agg.args[0] : null,
        _columnMapping: child.columnMapping,
      };
    });

    const schema = [
      ...(node.groupBy || []).map((expr, i) => ({
        name: expr?.columnName || `group${i}`,
        dataType: groupByTypes[i],
        tableAlias: expr?.tableAlias || '',
      })),
      ...node.aggregates.map((agg, i) => ({
        name: agg.name.toLowerCase(),
        dataType: this.normalizeAggResultType(agg),
        tableAlias: '',
      })),
    ];

    const columnMapping = new Map();
    let idx = 0;
    for (const col of schema) {
      const key = col.tableAlias
        ? `${col.tableAlias}.${col.name}`.toUpperCase()
        : col.name.toUpperCase();
      columnMapping.set(key, idx);
      columnMapping.set(col.name.toUpperCase(), idx);
      idx++;
    }

    const groupByCount = (node.groupBy || []).length;
    for (let a = 0; a < node.aggregates.length; a++) {
      const agg = node.aggregates[a];
      const key = aggExprKey(agg);
      columnMapping.set(key, groupByCount + a);
    }

    if (node.physicalStrategy === PhysicalStrategy.STREAM) {
      return {
        schema, columnMapping,
        register: (graph, currentPipelineId, currentSink) => {
          const childChunks = [];
          const childSink = { consume: async (c) => childChunks.push(c) };
          const childPipelineId = graph.createPipeline(childSink);
          child.register(graph, childPipelineId, childSink);

                    graph.addDependency(currentPipelineId, childPipelineId);

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

    return {
      schema, columnMapping,
      register: (graph, currentPipelineId, currentSink) => {
        const aggOp = new HashAggregateOperator(groupByEvals, groupByTypes, aggDefs, this.parallelDispatch);
        const aggSink = {
          async consume(chunk) { await aggOp.consume(chunk); },
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
  }

  async buildWindow(node) {
    const child = await this.buildPipeline(node.children[0]);
    const windowExprs = node.windowExprs;

    const windowSchema = [
      ...child.schema,
      ...windowExprs.map((w, i) => ({
        name: `__window_${i}`,
        dataType: this.normalizeExecType(w.resultType || 'FLOAT64'),
        tableAlias: '',
      })),
    ];
    const windowMapping = new Map();
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
      register: (graph, currentPipelineId, currentSink) => {
        const childChunks = [];
        const childSink = {
          consume: async (c) => childChunks.push(c),
          finalize: async () => {}
        };
        const childPipelineId = graph.createPipeline(childSink);
        child.register(graph, childPipelineId, childSink);
        graph.addDependency(currentPipelineId, childPipelineId);

        graph.setSource(currentPipelineId, async function* () {
          const windowOp = new WindowOperator(windowExprs, child.schema, child.columnMapping, compileExpression);
          const resultChunks = await windowOp.execute(childChunks);
          for (const chunk of resultChunks) {
            await currentSink.consume(chunk);
            yield chunk;
          }
          if (currentSink.finalize) await currentSink.finalize();
        });
      }
    };
  }

  async buildSort(node) {
    const child = await this.buildPipeline(node.children[0]);
    const keyExtractors = node.orderKeys.map(ok => ({
      eval: compileExpression(ok.expr, child.columnMapping),
      direction: ok.direction || 'ASC',
    }));

    return {
      schema: child.schema,
      columnMapping: child.columnMapping,
      register: (graph, currentPipelineId, currentSink) => {
        const spillPath = this.tempManager.allocate('spill', 'sort');
        const sortOp = new SortOperator(keyExtractors, node.limit, node.offset || 0, new SpillManager(new FsStorage(spillPath)));
        const sortSink = {
          async consume(chunk) { await sortOp.consume(chunk); },
          async finalize() {}
        };
        const childPipelineId = graph.createPipeline(sortSink);
        child.register(graph, childPipelineId, sortSink);

                graph.addDependency(currentPipelineId, childPipelineId);

                graph.setSource(currentPipelineId, async function* () {
          const resultChunks = await sortOp.finalize();
          for (const chunk of resultChunks) {
            await currentSink.consume(chunk);
            yield chunk;
          }
          if (currentSink.finalize) await currentSink.finalize();
        });
      }
    };
  }

  async buildTopN(node) {
    const child = await this.buildPipeline(node.children[0]);
    const keyExtractors = node.orderKeys.map(ok => ({
      eval: compileExpression(ok.expr, child.columnMapping),
      direction: ok.direction || 'ASC',
    }));

    return {
      schema: child.schema,
      columnMapping: child.columnMapping,
      register: (graph, currentPipelineId, currentSink) => {
        const spillPath = this.tempManager.allocate('spill', 'topn');
        const sortOp = new SortOperator(keyExtractors, node.count, node.offset || 0, new SpillManager(new FsStorage(spillPath)));
        const sortSink = {
          async consume(chunk) { await sortOp.consume(chunk); },
          async finalize() {}
        };
        const childPipelineId = graph.createPipeline(sortSink);
        child.register(graph, childPipelineId, sortSink);

        graph.addDependency(currentPipelineId, childPipelineId);

        graph.setSource(currentPipelineId, async function* () {
          const resultChunks = await sortOp.finalize();
          for (const chunk of resultChunks) {
            await currentSink.consume(chunk);
            yield chunk;
          }
          if (currentSink.finalize) await currentSink.finalize();
        });
      }
    };
  }

  async buildLimit(node) {
    const child = await this.buildPipeline(node.children[0]);
    const limit = node.count;
    const offset = node.offset || 0;

    return {
      schema: child.schema,
      columnMapping: child.columnMapping,
      register: (graph, currentPipelineId, currentSink) => {
        const limitOp = new LimitOperator(limit, offset);
        const cancelToken = new CancelToken();
        const childSink = {
          async consume(chunk) {
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

  async buildDistinct(node) {
    const child = await this.buildPipeline(node.children[0]);

    return {
      schema: child.schema,
      columnMapping: child.columnMapping,
      register: (graph, currentPipelineId, currentSink) => {
        const distinctOp = new DistinctOperator();
        const childSink = {
          async consume(chunk) {
            const result = await distinctOp.process(chunk);
            if (result && result.size > 0) {
              await currentSink.consume(result);
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

  async buildUnion(node) {
    const left = await this.buildPipeline(node.children[0]);
    const right = await this.buildPipeline(node.children[1]);

    return {
      schema: left.schema,
      columnMapping: left.columnMapping,
      register: (graph, currentPipelineId, currentSink) => {
        if (!node.all) {
          const unionOp = new UnionOperator(false);
          const dedupSink = {
            async consume(chunk) {
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

          graph.setSource(currentPipelineId, async function* () {
            if (currentSink.finalize) await currentSink.finalize();
          });
        } else {
          const leftPipelineId = graph.createPipeline(currentSink);
          const rightPipelineId = graph.createPipeline(currentSink);

          left.register(graph, leftPipelineId, currentSink);
          right.register(graph, rightPipelineId, currentSink);

          graph.addDependency(currentPipelineId, leftPipelineId);
          graph.addDependency(currentPipelineId, rightPipelineId);

          graph.setSource(currentPipelineId, async function* () {
          });
        }
      }
    };
  }

  async buildCTEAnchor(node) {
    const producer = await this.buildPipeline(node.children[0]);
    this.cteDefinitions.set(node.cteName.toUpperCase(), node.children[0]);

    const consumer = await this.buildPipeline(node.children[1]);

    const self = this;

    return {
      schema: consumer.schema,
      columnMapping: consumer.columnMapping,
      register: (graph, currentPipelineId, currentSink) => {
        const cteChunks = [];
        const cteSink = { consume: async (c) => cteChunks.push(c) };
        const producerPipelineId = graph.createPipeline(cteSink);
        producer.register(graph, producerPipelineId, cteSink);
        cteSink.finalize = async () => {
          self.cteResults.set(node.cteName.toUpperCase(), { chunks: cteChunks, schema: producer.schema, columnMapping: producer.columnMapping });
        };

        graph.addDependency(currentPipelineId, producerPipelineId);
        consumer.register(graph, currentPipelineId, currentSink);
      }
    };
  }

  async buildCTEScan(node) {
    const ctePlan = this.findCTEPlan(node.cteName);
    if (!ctePlan) throw new Error(`CTE not found: ${node.cteName}`);

        const compiledCTE = await this.buildPipeline(ctePlan);
    const self = this;

    return {
      schema: compiledCTE.schema,
      columnMapping: compiledCTE.columnMapping,
      register: (graph, currentPipelineId, currentSink) => {
        graph.setSource(currentPipelineId, async function* () {
          let stored = self.cteResults.get(node.cteName.toUpperCase());
          if (!stored) {
            const cteChunks = [];
            const cteSink = {
              async consume(c) { cteChunks.push(c); },
              async finalize() {}
            };
            const cteGraph = new PipelineGraph();
            const ctePipelineId = cteGraph.createPipeline(cteSink);
            compiledCTE.register(cteGraph, ctePipelineId, cteSink);
            const scheduler = new TaskScheduler();
            await scheduler.schedule(cteGraph);

            stored = {
              chunks: cteChunks,
              schema: compiledCTE.schema,
              columnMapping: compiledCTE.columnMapping,
            };
            self.cteResults.set(node.cteName.toUpperCase(), stored);
          }

          const clonedChunks = stored.chunks.map(chunk => {
            const cols = chunk.columns.map(col => {
              const newCol = new Column(col.dataType, chunk.size);
              for (let i = 0; i < chunk.size; i++) {
                newCol.set(i, col.get(chunk.activeRowIndex(i)));
              }
              newCol.length = chunk.size;
              return newCol;
            });
            return new DataChunk(cols, chunk.size);
          });

          for (const chunk of clonedChunks) {
            await currentSink.consume(chunk);
            yield chunk;
          }
        });
      }
    };
  }

  findCTEPlan(cteName) {
    const key = cteName.toUpperCase();
    return this.cteDefinitions?.get(key) || null;
  }

  async buildMaterialize(node) {
    const child = await this.buildPipeline(node.children[0]);
    return {
      schema: child.schema,
      columnMapping: child.columnMapping,
      register: (graph, currentPipelineId, currentSink) => {
        child.register(graph, currentPipelineId, currentSink);
      }
    };
  }

  async buildDependentJoin(node) {
    const outer = await this.buildPipeline(node.children[0]);
    const dummyOp = new DependentJoinOperator(node.subqueryType, outer.schema);
    const self = this;

    return {
      schema: dummyOp.resultSchema,
      columnMapping: this.buildSchemaMapping(dummyOp.resultSchema, ''),
      register: (graph, currentPipelineId, currentSink) => {
        const outerChunks = [];
        const outerSink = { consume: async (c) => outerChunks.push(c) };
        const outerPipelineId = graph.createPipeline(outerSink);
        outer.register(graph, outerPipelineId, outerSink);

                graph.addDependency(currentPipelineId, outerPipelineId);

                graph.setSource(currentPipelineId, async function* () {
          const runtimeOp = new DependentJoinOperator(node.subqueryType, outer.schema);
          const isCorrelated = (node.correlatedColumns || []).length > 0;
          let cachedInnerChunks = null;

          for (const outerChunk of outerChunks) {
            const outerRows = outerChunk.toRows();
            for (const outerRow of outerRows) {
              if (!isCorrelated && cachedInnerChunks !== null) {
                await runtimeOp.processOuterRow(outerRow, cachedInnerChunks);
                continue;
              }
              const innerPipeline = await self.buildPipeline(node.children[1]);
              const innerChunks = [];
              const innerGraph = new PipelineGraph();
              const innerSink = { consume: async (c) => innerChunks.push(c) };
              const innerPipelineId = innerGraph.createPipeline(innerSink);
              innerPipeline.register(innerGraph, innerPipelineId, innerSink);
              await new TaskScheduler(Config.dependentJoinConcurrency).schedule(innerGraph);
              if (!isCorrelated) cachedInnerChunks = innerChunks;
              await runtimeOp.processOuterRow(outerRow, innerChunks);
            }
          }

          const resultChunks = await runtimeOp.finalize();
          for (const chunk of resultChunks) {
            await currentSink.consume(chunk);
            yield chunk;
          }
        });
      }
    };
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

  normalizeExecType(dt) {
    if (dt === 'DECIMAL' || dt === 'INT64') return 'FLOAT64';
    return dt;
  }

  normalizeAggResultType(agg) {
    const name = agg.name?.toUpperCase();
    if (name === 'COUNT' || name === 'COUNT_STAR') return 'INT32';
    if (name === 'AVG') return 'FLOAT64';
    if (name === 'SUM' || name === 'MIN' || name === 'MAX') return 'FLOAT64';
    return 'FLOAT64';
  }
}

function windowExprKey(expr) {
  const name = expr.name?.toUpperCase() || 'WIN';
  const argKey = (expr.args || []).map(a => {
    if (a.kind === BoundExprKind.COLUMN_REF) return `${a.tableAlias}.${a.columnName}`.toUpperCase();
    return JSON.stringify(a).slice(0, 30);
  }).join(',');
  const partKey = (expr.partitionBy || []).map(p => {
    if (p.kind === BoundExprKind.COLUMN_REF) return `${p.tableAlias}.${p.columnName}`.toUpperCase();
    return '';
  }).join(',');
  return `__WIN__${name}(${argKey})[${partKey}]`;
}

function expressionCacheKey(expr) {
  if (!expr || typeof expr !== 'object') return String(expr);
  switch (expr.kind) {
    case BoundExprKind.COLUMN_REF:
      return `COL:${expr.tableAlias || ''}.${expr.columnName}`;
    case BoundExprKind.LITERAL:
      return `LIT:${String(expr.value)}`;
    case BoundExprKind.BINARY:
      return `BIN:${expr.op}:${expressionCacheKey(expr.left)}:${expressionCacheKey(expr.right)}`;
    case BoundExprKind.UNARY:
      return `UNARY:${expr.op}:${expressionCacheKey(expr.operand)}`;
    case BoundExprKind.CASE:
      return `CASE:${JSON.stringify(expr)}`;
    default:
      return JSON.stringify(expr);
  }
}

