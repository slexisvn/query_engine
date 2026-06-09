import { parse } from './parser/parser.js';
import { Binder } from './binder/binder.js';
import { createLogicalPlan } from './planner/logical-planner.js';
import { defaultFunctionRegistry } from './catalog/function-registry.js';
import { NodeKind } from './parser/ast.js';
import { DataType } from './storage/data-type.js';
import { Column } from './storage/column.js';
import { Table } from './storage/table.js';
import { Optimizer } from './optimizer/optimizer.js';
import { SubqueryUnnesting } from './optimizer/passes/subquery-unnesting.js';
import { CTEOptimization } from './optimizer/passes/cte-optimization.js';
import { PredicatePushdown } from './optimizer/passes/predicate-pushdown.js';
import { ProjectionPushdown } from './optimizer/passes/projection-pushdown.js';
import { JoinReorder } from './optimizer/passes/join-reorder.js';
import { PhysicalDesign } from './optimizer/passes/physical-design.js';
import { QueryExecutor } from './execution/query-executor.js';
import { QueryResult } from './execution/query-result.js';
import { StatisticsCollector } from './catalog/statistics.js';
import { ExpressionSimplifier } from './optimizer/passes/expression-simplifier.js';
import { OuterToInnerJoin } from './optimizer/passes/outer-to-inner.js';
import { LimitPushdown } from './optimizer/passes/limit-pushdown.js';
import { HavingPushdown } from './optimizer/passes/having-pushdown.js';
import { EmptyPropagation } from './optimizer/passes/empty-propagation.js';
import { NodeMerge } from './optimizer/passes/node-merge.js';
import { PredicateInference } from './optimizer/passes/predicate-inference.js';
import { SortElimination } from './optimizer/passes/sort-elimination.js';
import { JoinElimination } from './optimizer/passes/join-elimination.js';
import { PredicateDedup } from './optimizer/passes/predicate-dedup.js';
import { JoinResidualSplit } from './optimizer/passes/join-residual-split.js';
import { TopNFusion } from './optimizer/passes/topn-fusion.js';
import { IndexSelection } from './optimizer/passes/index-selection.js';
import { BTreeIndex } from './storage/btree.js';
import { TempDirectoryManager } from './storage/temp-directory-manager.js';
import { FilterOrdering } from './optimizer/passes/filter-ordering.js';
import { AggregatePushdown } from './optimizer/passes/aggregate-pushdown.js';
import { StatisticsCache } from './catalog/statistics-cache.js';

export class QueryEngine {
  constructor(catalog, options = {}) {
    this.catalog = catalog;
    this.functionRegistry = defaultFunctionRegistry;
    this.tempManager = new TempDirectoryManager(options.tempDir ? { baseDir: options.tempDir } : {});
    this.executor = new QueryExecutor(catalog, this.tempManager);
    this.wasmEnabled = false;

    this.precomputedStats = options.statistics || null;
    this.statsCache = new StatisticsCache(catalog);
    this.optimizer = this.createOptimizer(this.precomputedStats);
  }

  close() {
    this.tempManager.cleanup();
  }

  async collectStatistics() {
    await this.statsCache.ensureAll();
    const map = this.statsCache.toMap();
    return map.size > 0 ? map : null;
  }

  createOptimizer(statistics) {
    const statsMap = statistics || new Map();
    const optimizer = new Optimizer();
    optimizer.registerPass(new ExpressionSimplifier());
    optimizer.registerPass(new SubqueryUnnesting());
    optimizer.registerPass(new HavingPushdown());
    optimizer.registerPass(new CTEOptimization());
    optimizer.registerPass(new PredicatePushdown());
    optimizer.registerPass(new PredicateInference());
    optimizer.registerPass(new PredicatePushdown());
    optimizer.registerPass(new OuterToInnerJoin());
    optimizer.registerPass(new PredicatePushdown());
    optimizer.registerPass(new AggregatePushdown());

    if (statistics) {
      optimizer.registerPass(new JoinReorder(statistics));
      optimizer.registerPass(new PredicatePushdown());
    }

    optimizer.registerPass(new JoinElimination());
    optimizer.registerPass(new ProjectionPushdown());
    optimizer.registerPass(new LimitPushdown());
    optimizer.registerPass(new EmptyPropagation());
    optimizer.registerPass(new NodeMerge());
    optimizer.registerPass(new PredicateDedup());
    optimizer.registerPass(new FilterOrdering(statsMap));
    optimizer.registerPass(new IndexSelection(this.catalog, statistics));
    optimizer.registerPass(new JoinResidualSplit());
    optimizer.registerPass(new PhysicalDesign(statsMap));
    optimizer.registerPass(new SortElimination());
    optimizer.registerPass(new TopNFusion());

    return optimizer;
  }

  parseSQL(sql) {
    return parse(sql);
  }

  bind(ast) {
    const binder = new Binder(this.catalog, this.functionRegistry);
    return binder.bind(ast);
  }

  plan(boundQuery) {
    return createLogicalPlan(boundQuery);
  }

  optimize(logicalPlan) {
    return this.optimizer.optimize(logicalPlan);
  }

  async compile(sql) {
    const ast = this.parseSQL(sql);
    let isExplain = false;
    let isAnalyze = false;
    let targetAst = ast;

    if (ast.kind === 'ExplainStmt') {
      isExplain = true;
      targetAst = ast.query;
    } else if (ast.kind === 'ExplainAnalyzeStmt') {
      isExplain = true;
      isAnalyze = true;
      targetAst = ast.query;
    } else if (ast.kind === 'CreateTableStmt' || ast.kind === 'DropTableStmt') {
      return { ddl: ast };
    }

    const bound = this.bind(targetAst);
    const logicalPlan = this.plan(bound);
    let cteMap = logicalPlan._cteMap || new Map();

    if (!this.precomputedStats && !this._statsCollected) {
      const collected = await this.collectStatistics();
      if (collected) {
        this.optimizer = this.createOptimizer(collected);
        this._statsCollected = true;
        if (this._distributedPasses) {
          for (const { method, args } of this._distributedPasses) {
            this.optimizer[method](...args);
          }
        }
      }
    }

    const optimized = this.optimize(logicalPlan);
    cteMap = this.optimizeCTEMap(cteMap);
    return { plan: optimized, outputColumns: bound.outputColumns, cteMap, isExplain, isAnalyze };
  }

  optimizeCTEMap(cteMap) {
    if (!cteMap || cteMap.size === 0) return cteMap;
    const optimized = new Map();
    for (const [name, plan] of cteMap) {
      optimized.set(name, this.optimize(plan));
    }
    return optimized;
  }

  async run(sql) {
    const compiled = await this.compile(sql);

    if (compiled.ddl) {
      return this.executeDDL(compiled.ddl);
    }

    const { plan, outputColumns, cteMap, isExplain, isAnalyze } = compiled;

    if (isExplain && !isAnalyze) {
      const { formatPlan } = await import('./planner/plan-formatter.js');
      const planStr = formatPlan(plan);
      return { rows: [{ 'EXPLAIN_PLAN': planStr }], columns: ['EXPLAIN_PLAN'] };
    }

    if (isAnalyze) {
      const { formatPlan } = await import('./planner/plan-formatter.js');
      const planStr = formatPlan(plan);
      const startTime = performance.now();
      this.executor.cteDefinitions = cteMap;
      const { sink, columnNames } = await this.executor.execute(plan, outputColumns);
      const result = new QueryResult(columnNames, sink);
      const rows = await result.toArray();
      const elapsed = (performance.now() - startTime).toFixed(2);
      const analyzeStr = `${planStr}\nExecution Time: ${elapsed} ms\nRows Returned: ${rows.length}`;
      return { rows: [{ 'EXPLAIN_ANALYZE': analyzeStr }], columns: ['EXPLAIN_ANALYZE'] };
    }

    this._activeCancel = new AbortController();
    try {
      this.executor.cteDefinitions = cteMap;
      const { sink, columnNames } = await this.executor.execute(plan, outputColumns);
      const result = new QueryResult(columnNames, sink);
      return { rows: await result.toArray(), columns: columnNames };
    } finally {
      this._activeCancel = null;
    }
  }

  cancel() {
    if (this._activeCancel) {
      this._activeCancel.abort();
    }
  }

  executeDDL(ddl) {
    if (ddl.kind === 'CreateTableStmt') {
      return this.executeCreateTable(ddl);
    }
    if (ddl.kind === 'DropTableStmt') {
      return this.executeDropTable(ddl);
    }
    throw new Error(`Unknown DDL: ${ddl.kind}`);
  }

  executeCreateTable(stmt) {
    const resolveType = (typeName) => {
      const map = {
        'INTEGER': DataType.INT32, 'INT': DataType.INT32, 'INT32': DataType.INT32,
        'BIGINT': DataType.INT64, 'INT64': DataType.INT64,
        'FLOAT': DataType.FLOAT64, 'DOUBLE': DataType.FLOAT64, 'REAL': DataType.FLOAT64,
        'DECIMAL': DataType.DECIMAL, 'NUMERIC': DataType.DECIMAL,
        'VARCHAR': DataType.VARCHAR, 'TEXT': DataType.VARCHAR, 'CHAR': DataType.VARCHAR,
        'DATE': DataType.DATE,
        'TIMESTAMP': DataType.TIMESTAMP, 'DATETIME': DataType.TIMESTAMP,
        'BOOLEAN': DataType.BOOLEAN, 'BOOL': DataType.BOOLEAN,
      };
      return map[typeName.name.toUpperCase()] || DataType.VARCHAR;
    };

    const tableName = stmt.name.toUpperCase();

    if (this.catalog.getTable(tableName)) {
      if (stmt.ifNotExists) {
        return { rows: [], columns: [], message: `Table ${tableName} already exists` };
      }
      throw new Error(`Table ${tableName} already exists`);
    }

    const columns = stmt.columns.map(col => ({
      name: col.name.toUpperCase(),
      dataType: resolveType(col.typeName),
    }));

    const bufferPath = this.tempManager.allocate('buffer', tableName);
    const table = new Table(tableName, columns, bufferPath);
    this.catalog.registerTable(tableName, columns);
    this.catalog.registerTableStorage(tableName, table);

    return { rows: [], columns: [], message: `Table ${tableName} created` };
  }

  executeDropTable(stmt) {
    const tableName = stmt.name.toUpperCase();
    if (!this.catalog.getTable(tableName)) {
      if (stmt.ifExists) {
        return { rows: [], columns: [], message: `Table ${tableName} does not exist` };
      }
      throw new Error(`Table ${tableName} does not exist`);
    }
    this.catalog.dropTable(tableName);
    return { rows: [], columns: [], message: `Table ${tableName} dropped` };
  }

  async stream(sql) {
    const compiled = await this.compile(sql);
    if (compiled.ddl) return this.executeDDL(compiled.ddl);

    const { plan, outputColumns, cteMap, isExplain, isAnalyze } = compiled;

    if (isExplain && !isAnalyze) {
      const { formatPlan } = await import('./planner/plan-formatter.js');
      const planStr = formatPlan(plan);
      return { rows: [{ 'EXPLAIN_PLAN': planStr }], columns: ['EXPLAIN_PLAN'] };
    }

    this.executor.cteDefinitions = cteMap;
    const { sink, columnNames } = await this.executor.execute(plan, outputColumns, true);
    return new QueryResult(columnNames, sink);
  }

  async buildIndexes() {
    for (const tableName of this.catalog.listTables()) {
      const tableDef = this.catalog.getTable(tableName);
      if (!tableDef.primaryKey || tableDef.primaryKey.length === 0) continue;

      const storage = this.catalog.getTableStorage(tableName);
      if (!storage) continue;

      for (const pkCol of tableDef.primaryKey) {
        const colIdx = tableDef.columns.findIndex(c => c.name.toUpperCase() === pkCol.toUpperCase());
        if (colIdx < 0) continue;

        const colDef = tableDef.columns[colIdx];
        const btree = new BTreeIndex(colDef.dataType);

        await storage.flush();
        for (let p = 0; p < storage.pageIds.length; p++) {
          const pageId = storage.pageIds[p];
          const chunk = await storage.bufferPool.fetchPage(pageId, true);
          for (let r = 0; r < chunk.size; r++) {
            const key = chunk.columns[colIdx].get(r);
            if (key !== null && key !== undefined) {
              btree.insert(key, { pageId, rowIndex: r });
            }
          }
        }

        this.catalog.registerIndex(tableName, pkCol, btree);
        storage.registerIndex(colIdx, btree);
      }
    }
  }

  async enableWasm() {
    try {
      const { getGlobalLoader } = await import('./wasm/loader.js');
      const loader = await getGlobalLoader();
      await loader.loadModule('core');
      const { registerAllKernels } = await import('./wasm/register-kernels.js');
      registerAllKernels();
      this.wasmEnabled = true;
    } catch (_) {
      this.wasmEnabled = false;
    }
  }

  async enableParallel() {
    const { Config } = await import('./config.js');
    if (Config.parallelWorkers <= 1) return false;

    try {
      const { getGlobalLoader } = await import('./wasm/loader.js');
      const loader = await getGlobalLoader({ shared: true });
      const instance = await loader.loadModule('core');

      const regionAllocator = loader.initRegions(Config.regionSize);

      const { registerAllKernels } = await import('./wasm/register-kernels.js');
      registerAllKernels();
      this.wasmEnabled = true;

      const wasmModule = loader.getModule('core');
      const { WorkerPool } = await import('./parallel/worker-pool.js');
      const pool = new WorkerPool({
        maxWorkers: Config.parallelWorkers,
        wasmModule,
        wasmMemory: loader.memory,
        regionAllocator,
      });
      await pool.init();

      const { globalDispatch } = await import('./wasm/dispatch.js');
      const { ParallelDispatch } = await import('./parallel/parallel-dispatch.js');
      const parallelDispatch = new ParallelDispatch(pool, regionAllocator, globalDispatch);

      this.executor.setParallelContext(pool, parallelDispatch);
      this.workerPool = pool;
      this.parallelEnabled = true;
      return true;
    } catch (_) {
      this.parallelEnabled = false;
      return false;
    }
  }

  async enableDistributed(clusterConfig = {}) {
    const { NodeDescriptor, NodeRole } = await import('./distributed/cluster/node-descriptor.js');
    const { ClusterManager } = await import('./distributed/cluster/cluster-manager.js');
    const { PartitionMap } = await import('./distributed/partition/partition-map.js');
    const { DistributionAwareJoin } = await import('./distributed/optimizer/distribution-aware-join.js');
    const { PartialAggregatePass } = await import('./distributed/optimizer/partial-aggregate.js');
    const { DistributedSortPass } = await import('./distributed/optimizer/distributed-sort.js');
    const { QueryCoordinator } = await import('./distributed/execution/coordinator.js');

    const localNode = new NodeDescriptor({
      nodeId: clusterConfig.nodeId || `node-${Date.now()}`,
      host: clusterConfig.host || '127.0.0.1',
      port: clusterConfig.port || 9400,
      role: clusterConfig.role || NodeRole.HYBRID,
      capacity: clusterConfig.capacity,
    });

    const clusterManager = new ClusterManager(localNode);
    const partitionMap = new PartitionMap();
    const statsMap = this.precomputedStats || new Map();

    this.optimizer.insertPassAfter('PhysicalDesign', new DistributionAwareJoin(partitionMap, statsMap));
    this.optimizer.registerPass(new PartialAggregatePass());
    this.optimizer.registerPass(new DistributedSortPass());

    this._distributedPasses = [
      { method: 'insertPassAfter', args: ['PhysicalDesign', new DistributionAwareJoin(partitionMap, statsMap)] },
      { method: 'registerPass', args: [new PartialAggregatePass()] },
      { method: 'registerPass', args: [new DistributedSortPass()] },
    ];

    let transport = clusterConfig.transport || null;
    if (!transport) {
      const { HttpTransport } = await import('./distributed/transport/http-transport.js');
      transport = new HttpTransport({ port: localNode.port });
    }

    const coordinator = new QueryCoordinator(this, clusterManager, partitionMap, transport);

    this.distributed = {
      clusterManager,
      partitionMap,
      transport,
      coordinator,
      localNode,
    };

    return coordinator;
  }

  async shutdown() {
    if (this.workerPool) {
      await this.workerPool.shutdown();
      this.workerPool = null;
    }
    if (this.distributed?.transport) {
      await this.distributed.transport.stop();
    }
    this.tempManager.cleanup();
  }
}
