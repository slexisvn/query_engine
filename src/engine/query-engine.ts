import { parse } from '../parser/parser.js';
import { Binder } from '../binder/binder.js';
import { createLogicalPlan } from '../planner/logical-planner.js';
import { defaultFunctionRegistry } from '../catalog/function-registry.js';
import { DataType } from '../storage/data-type.js';
import { Table } from '../storage/table.js';
import { isPagedTableStorage } from '../storage/table-storage.js';
import { Optimizer } from '../optimizer/optimizer.js';
import { createDefaultOptimizer } from '../optimizer/optimizer-pipeline.js';
import { cteScanOrderRequirements } from '../optimizer/passes/sort-elimination.js';
import type { OptimizationContext } from '../optimizer/pass.js';
import { QueryExecutor } from '../execution/query-executor.js';
import { PhysicalPlanner } from '../execution/physical-planner.js';
import { QueryResult } from '../execution/query-result.js';
import { BTreeIndex } from '../storage/btree.js';
import { StatisticsCache } from '../catalog/statistics-cache.js';
import { LRUCache } from '../utils/lru-cache.js';
import { Config } from '../config.js';
import { LogicalScan, collectScannedTables } from '../planner/logical-plan.js';
import { PLAN_PROPERTIES_PASS } from '../optimizer/passes/plan-properties.js';
import type { LogicalPlanNode } from '../planner/logical-plan.js';
import { DataFrame } from '../dataframe/dataframe.js';
import { DFSchema } from '../dataframe/schema.js';
import { InMemoryRelation } from '../dataframe/in-memory-relation.js';
import type { Statement, QueryStmt, CreateTableStmtNode, DropTableStmtNode, TypeNameNode, ColumnDefNode } from '../parser/ast.js';
import type { BoundQuery, OutputColumn } from '../binder/binder.js';
import type { LiteralValue } from '../binder/expression-binder.js';
import type { Catalog, CatalogTable } from '../catalog/catalog.js';
import type { ColumnSchema, ColumnValue } from '../storage/data-type.js';
import type { TableStatistics } from '../catalog/statistics.js';
import type { OptimizationPass } from '../optimizer/pass.js';
import type { Transport } from '../distributed/transport/transport.js';
import type { NodeDescriptor } from '../distributed/cluster/node-descriptor.js';
import type { ClusterManager } from '../distributed/cluster/cluster-manager.js';
import type { PartitionMap } from '../distributed/partition/partition-map.js';
import type { QueryCoordinator } from '../distributed/execution/coordinator.js';
import type { NodeCapacity, NodeId, NodeRole as NodeRoleType } from '../distributed/distributed-types.js';

export type QueryParam = LiteralValue;

type StatisticsMap = Map<string, TableStatistics>;

type DDLStmt = CreateTableStmtNode | DropTableStmtNode;

type PrebuiltCteBound = BoundQuery & { prebuiltPlan: LogicalPlanNode };

type BinderCatalog = ConstructorParameters<typeof Binder>[0];

type ExecutorStorageBackend = NonNullable<ConstructorParameters<typeof QueryExecutor>[2]>;

type ExecutorColumns = Parameters<QueryExecutor['execute']>[1];

interface StorageBackendLike {
  createTempSpace(): TempManagerLike;
  createPageStore(handle: string): PageStoreLike;
}

interface TempManagerLike {
  allocate(category: string, label: string): string;
  cleanup(): void;
}

type PageStoreLike = ConstructorParameters<typeof Table>[2];

type StorageBackendFactory = (options: QueryEngineOptions) => StorageBackendLike | null | undefined;

interface QueryEngineOptions {
  storageBackend?: StorageBackendLike;
  statistics?: StatisticsMap | null;
}

interface SqlFrame {
  name: string;
  columns: ColumnSchema[];
  plan: LogicalPlanNode;
  cteMap?: Map<string, LogicalPlanNode> | null;
}

interface SqlOptions {
  frames?: SqlFrame[];
  params?: readonly QueryParam[];
}

interface DistributedClusterConfig {
  nodeId?: NodeId;
  host?: string;
  port?: number;
  role?: NodeRoleType;
  capacity?: NodeCapacity;
  transport?: Transport;
}

interface DistributedContext {
  clusterManager: ClusterManager;
  partitionMap: PartitionMap;
  transport: Transport;
  coordinator: QueryCoordinator;
  localNode: NodeDescriptor;
}

interface DistributedPassEntry {
  method: 'insertPassAfter' | 'registerPass';
  args: [string, OptimizationPass] | [OptimizationPass];
}

interface WorkerPoolLike {
  init(): Promise<void>;
  shutdown(): Promise<void>;
}

interface FragmentPoolLike {
  close(): Promise<void>;
}

interface CompiledDDL {
  ddl: DDLStmt;
  plan?: undefined;
}

interface CompiledQuery {
  ddl?: undefined;
  plan: LogicalPlanNode;
  outputColumns: OutputColumn[];
  cteMap: Map<string, LogicalPlanNode>;
  isExplain: boolean;
  isAnalyze: boolean;
}

type CompileResult = CompiledDDL | CompiledQuery;

interface DDLResult {
  rows: Record<string, ColumnValue>[];
  columns: string[];
  message?: string;
}

interface RunRowsResult {
  rows: Record<string, ColumnValue>[];
  columns: string[];
  rowKeys?: string[];
}

const DATAFRAME_TABLE_PREFIX = '__DF';

let _defaultBackendFactory: StorageBackendFactory | null = null;

export function setDefaultStorageBackend(factory: StorageBackendFactory): void {
  _defaultBackendFactory = factory;
}

function referencedTables(plan: LogicalPlanNode, cteMap: Map<string, LogicalPlanNode> | null): Set<string> {
  const tables = collectScannedTables(plan);
  for (const ctePlan of cteMap?.values() ?? []) collectScannedTables(ctePlan, tables);
  return tables;
}

function serializeParams(params: readonly QueryParam[]): string {
  return params.map(param => (typeof param === 'bigint' ? `${param}n` : JSON.stringify(param))).join('\u0001');
}

function coerceForStorage(value: ColumnValue, dataType: DataType): ColumnValue {
  if (value === null || value === undefined) return null;
  if (dataType === DataType.DECIMAL) {
    return typeof value === 'bigint' ? Number(value) : value;
  }
  const wantsBigInt = dataType === DataType.INT64 || dataType === DataType.TIMESTAMP;
  if (wantsBigInt) {
    return typeof value === 'bigint' ? value : BigInt(Math.round(Number(value)));
  }
  if (typeof value === 'bigint') {
    return dataType === DataType.VARCHAR ? value.toString() : Number(value);
  }
  return value;
}

export class QueryEngine {
  catalog: Catalog;
  functionRegistry: typeof defaultFunctionRegistry;
  storageBackend: StorageBackendLike;
  tempManager: TempManagerLike;
  executor: QueryExecutor;
  wasmEnabled: boolean;
  _dfIdCounter: number;
  precomputedStats: StatisticsMap | null;
  statsCache: StatisticsCache;
  optimizer: Optimizer;
  _distributedPasses?: DistributedPassEntry[];
  _activeCancel?: AbortController | null;
  planCache: LRUCache<string, CompiledQuery>;
  workerPool?: WorkerPoolLike | null;
  fragmentPool?: FragmentPoolLike | null;
  parallelEnabled?: boolean;
  distributed?: DistributedContext;

  constructor(catalog: Catalog, options: QueryEngineOptions = {}) {
    this.catalog = catalog;
    this.functionRegistry = defaultFunctionRegistry;

    const backend = options.storageBackend ?? _defaultBackendFactory?.(options);
    if (!backend) {
      throw new Error('QueryEngine requires a storageBackend (none provided and no default registered)');
    }
    this.storageBackend = backend;
    this.tempManager = backend.createTempSpace();
    this.executor = new QueryExecutor(catalog, this.tempManager, backend as ExecutorStorageBackend);
    this.wasmEnabled = false;
    this._dfIdCounter = 0;

    this.precomputedStats = options.statistics || null;
    this.statsCache = new StatisticsCache(catalog);
    this.planCache = new LRUCache(Config.planCacheEntries);
    this.optimizer = this.createOptimizer(this.precomputedStats);
    this.executor.setPhysicalPlanner(new PhysicalPlanner(this.precomputedStats ?? new Map()));
  }

  _nextDfId(): number {
    return this._dfIdCounter++;
  }

  close(): void {
    this.tempManager.cleanup();
  }

  async collectStatistics(tables: Iterable<string>): Promise<StatisticsMap | null> {
    await this.statsCache.ensureFor(tables);
    const map = this.statsCache.toMap();
    return map.size > 0 ? map : null;
  }

  createOptimizer(statistics: StatisticsMap | null): Optimizer {
    return createDefaultOptimizer({ catalog: this.catalog, statistics });
  }

  parseSQL(sql: string): Statement {
    return parse(sql);
  }

  bind(ast: QueryStmt, params: readonly QueryParam[] = []): BoundQuery {
    const binder = new Binder(this.catalog as BinderCatalog, this.functionRegistry, params);
    return binder.bind(ast);
  }

  plan(boundQuery: BoundQuery): LogicalPlanNode {
    return createLogicalPlan(boundQuery);
  }

  optimize(logicalPlan: LogicalPlanNode, context: OptimizationContext = {}): LogicalPlanNode {
    return this.optimizer.optimize(logicalPlan, context);
  }

  planCacheKey(sql: string, params: readonly QueryParam[]): string | null {
    if (this.distributed) return null;
    return `${this.catalog.version}\u0000${this.statsCache.generation}\u0000${sql}\u0000${serializeParams(params)}`;
  }

  async compile(sql: string, params: readonly QueryParam[] = []): Promise<CompileResult> {
    const lookupKey = this.planCacheKey(sql, params);
    const cached = lookupKey === null ? undefined : this.planCache.get(lookupKey);
    if (cached) return cached;

    const compiled = await this.compileUncached(sql, params);
    const storeKey = this.planCacheKey(sql, params);
    if (storeKey !== null && compiled.plan && !compiled.isExplain) {
      this.planCache.set(storeKey, compiled);
    }
    return compiled;
  }

  async compileUncached(sql: string, params: readonly QueryParam[] = []): Promise<CompileResult> {
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

    const bound = this.bind(targetAst as QueryStmt, params);
    const logicalPlan = this.plan(bound);
    let cteMap = logicalPlan._cteMap || new Map<string, LogicalPlanNode>();

    await this._ensureStatistics(referencedTables(logicalPlan, cteMap));

    const optimized = this.optimize(logicalPlan);
    cteMap = this.optimizeCTEMap(cteMap, optimized);
    return { plan: optimized, outputColumns: bound.outputColumns, cteMap, isExplain, isAnalyze };
  }

  optimizeCTEMap(cteMap: Map<string, LogicalPlanNode>, consumer: LogicalPlanNode): Map<string, LogicalPlanNode> {
    if (!cteMap || cteMap.size === 0) return cteMap;
    const orderRequirements = cteScanOrderRequirements(consumer);
    for (const plan of cteMap.values()) cteScanOrderRequirements(plan, orderRequirements);

    const optimized = new Map<string, LogicalPlanNode>();
    for (const [name, plan] of cteMap) {
      optimized.set(name, this.optimize(plan, { rootOrderRequired: orderRequirements.get(name) ?? true }));
    }
    return optimized;
  }

  _applyDistributedPasses(optimizer: Optimizer, passes: DistributedPassEntry[]): void {
    for (const { method, args } of passes) {
      (optimizer[method] as (...passArgs: DistributedPassEntry['args']) => Optimizer)(...args);
    }
  }

  async _ensureStatistics(tables: Iterable<string>): Promise<void> {
    if (this.precomputedStats) return;

    const generationBefore = this.statsCache.generation;
    const collected = await this.collectStatistics(tables);
    if (!collected || this.statsCache.generation === generationBefore) return;

    this.optimizer = this.createOptimizer(collected);
    this.executor.setPhysicalPlanner(new PhysicalPlanner(collected));
    if (this._distributedPasses) {
      this._applyDistributedPasses(this.optimizer, this._distributedPasses);
    }
  }

  table(name: string): DataFrame {
    const tableDef: CatalogTable | null = this.catalog.getTable(name);
    if (!tableDef) throw new Error(`Unknown table: ${name}`);
    const plan = LogicalScan(tableDef.name, tableDef.columns, tableDef.name);
    const schema = DFSchema.fromStorageSchema(tableDef.columns, tableDef.name);
    return new DataFrame(this, plan, schema);
  }

  createDataFrame(rows: Record<string, ColumnValue>[] | ColumnValue[][], declaredSchema: ColumnSchema[] | null = null): DataFrame {
    const relation = InMemoryRelation.fromRows(rows, declaredSchema);
    const name = `${DATAFRAME_TABLE_PREFIX}${this._nextDfId()}`;
    const storageSchema: ColumnSchema[] = relation.getSchema();
    this.catalog.registerTable(name, storageSchema);
    this.catalog.registerTableStorage(name, relation);
    const plan = LogicalScan(name, storageSchema, name);
    const schema = DFSchema.fromStorageSchema(storageSchema, name);
    return new DataFrame(this, plan, schema);
  }

  sql(sqlString: string, options: SqlOptions = {}): DataFrame {
    const ast = this.parseSQL(sqlString);
    if (ast.kind === 'CreateTableStmt' || ast.kind === 'DropTableStmt'
      || ast.kind === 'ExplainStmt' || ast.kind === 'ExplainAnalyzeStmt') {
      throw new Error('sql() supports query statements only');
    }
    const binder = new Binder(this.catalog as BinderCatalog, this.functionRegistry, options.params);
    for (const frame of options.frames || []) {
      binder.cteScopes.set(frame.name.toUpperCase(), {
        name: frame.name,
        columns: frame.columns,
        bound: { prebuiltPlan: frame.plan } as PrebuiltCteBound,
      });
    }
    const bound = binder.bind(ast);
    const logicalPlan = this.plan(bound);
    let cteMap: Map<string, LogicalPlanNode> | null = logicalPlan._cteMap || null;
    for (const frame of options.frames || []) {
      if (!frame.cteMap) continue;
      cteMap = cteMap || new Map<string, LogicalPlanNode>();
      for (const [k, v] of frame.cteMap) if (!cteMap.has(k)) cteMap.set(k, v);
    }
    const schema = DFSchema.fromFields(bound.outputColumns.map((c: OutputColumn, i: number) => ({
      name: c.name,
      dataType: c.dataType as DataType,
      index: i,
      tableAlias: '',
    })));
    return new DataFrame(this, logicalPlan, schema, cteMap);
  }

  async _formatPlan(plan: LogicalPlanNode): Promise<string> {
    const { formatPlan } = await import('../planner/plan-formatter.js');
    const { physicalPlanToString } = await import('../execution/physical-plan.js');
    const physical = this.executor.physicalPlanner.plan(plan);
    return `${formatPlan(plan)}
Physical Plan:
${physicalPlanToString(physical)}`;
  }

  async _explainPlanResult(plan: LogicalPlanNode): Promise<RunRowsResult> {
    const planStr = await this._formatPlan(plan);
    return { rows: [{ 'EXPLAIN_PLAN': planStr }], columns: ['EXPLAIN_PLAN'] };
  }

  async _runPlan(plan: LogicalPlanNode, outputColumns: OutputColumn[], streaming: boolean = false, cteMap: Map<string, LogicalPlanNode> | null = null): Promise<QueryResult> {
    await this._ensureStatistics(referencedTables(plan, cteMap));
    const optimized = this.optimize(plan);
    this.executor.cteDefinitions = this.optimizeCTEMap(cteMap || new Map<string, LogicalPlanNode>(), optimized);
    const { sink, columnNames } = await this.executor.execute(optimized, outputColumns as ExecutorColumns, streaming);
    return new QueryResult(columnNames, sink);
  }

  async run(sql: string, params: readonly QueryParam[] = []): Promise<DDLResult | RunRowsResult> {
    const compiled = await this.compile(sql, params);

    if (compiled.ddl) {
      return this.executeDDL(compiled.ddl);
    }

    const { plan, outputColumns, cteMap, isExplain, isAnalyze } = compiled;

    if (isExplain && !isAnalyze) {
      return this._explainPlanResult(plan);
    }

    if (isAnalyze) {
      const planStr = await this._formatPlan(plan);
      const startTime = performance.now();
      this.executor.cteDefinitions = cteMap;
      const { sink, columnNames } = await this.executor.execute(plan, outputColumns as ExecutorColumns);
      const result = new QueryResult(columnNames, sink);
      const rows = await result.toArray();
      const elapsed = (performance.now() - startTime).toFixed(2);
      const analyzeStr = `${planStr}\nExecution Time: ${elapsed} ms\nRows Returned: ${rows.length}`;
      return { rows: [{ 'EXPLAIN_ANALYZE': analyzeStr }], columns: ['EXPLAIN_ANALYZE'] };
    }

    this._activeCancel = new AbortController();
    try {
      this.executor.cteDefinitions = cteMap;
      const { sink, columnNames } = await this.executor.execute(plan, outputColumns as ExecutorColumns);
      const result = new QueryResult(columnNames, sink);
      return { rows: await result.toArray(), columns: columnNames, rowKeys: result.rowKeys };
    } finally {
      this._activeCancel = null;
    }
  }

  cancel(): void {
    if (this._activeCancel) {
      this._activeCancel.abort();
    }
  }

  async executeDDL(ddl: DDLStmt): Promise<DDLResult> {
    if (ddl.kind === 'CreateTableStmt') {
      return this.executeCreateTable(ddl);
    }
    if (ddl.kind === 'DropTableStmt') {
      return this.executeDropTable(ddl);
    }
    throw new Error(`Unknown DDL: ${(ddl as DDLStmt).kind}`);
  }

  async executeCreateTable(stmt: CreateTableStmtNode): Promise<DDLResult> {
    const tableName = stmt.name.toUpperCase();

    if (this.catalog.getTable(tableName)) {
      if (stmt.ifNotExists) {
        return { rows: [], columns: [], message: `Table ${tableName} already exists` };
      }
      throw new Error(`Table ${tableName} already exists`);
    }

    if (stmt.as) {
      return this.createTableAsSelect(tableName, stmt.as);
    }

    const resolveType = (typeName: TypeNameNode): DataType => {
      const map: Record<string, DataType> = {
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

    const columns: ColumnSchema[] = (stmt.columns ?? []).map((col: ColumnDefNode) => ({
      name: col.name.toUpperCase(),
      dataType: resolveType(col.typeName),
    }));

    const pageStore = this.storageBackend.createPageStore(this.tempManager.allocate('buffer', tableName));
    const table = new Table(tableName, columns, pageStore);
    this.catalog.registerTable(tableName, columns);
    this.catalog.registerTableStorage(tableName, table);

    return { rows: [], columns: [], message: `Table ${tableName} created` };
  }

  compileQueryStatement(query: QueryStmt): { plan: LogicalPlanNode; outputColumns: OutputColumn[]; cteMap: Map<string, LogicalPlanNode> } {
    const bound = this.bind(query);
    const logicalPlan = this.plan(bound);
    return {
      plan: logicalPlan,
      outputColumns: bound.outputColumns,
      cteMap: logicalPlan._cteMap || new Map<string, LogicalPlanNode>(),
    };
  }

  async createTableAsSelect(tableName: string, query: QueryStmt): Promise<DDLResult> {
    const { plan, outputColumns, cteMap } = this.compileQueryStatement(query);
    const result = await this._runPlan(plan, outputColumns, false, cteMap);
    return this.materializeTableFromResult(tableName, result, outputColumns);
  }

  async materializeTableFromResult(tableName: string, result: QueryResult, outputColumns: OutputColumn[]): Promise<DDLResult> {
    const columnNames = result.columns;

    const seen = new Set<string>();
    for (const name of columnNames) {
      const upper = name.toUpperCase();
      if (seen.has(upper)) {
        throw new Error(`Duplicate column name "${name}" in CREATE TABLE ... AS — use an explicit alias`);
      }
      seen.add(upper);
    }

    const fallbackTypes = (): ColumnSchema[] =>
      columnNames.map((name: string, i: number) => ({
        name: name.toUpperCase(),
        dataType: (outputColumns[i]?.dataType ?? DataType.VARCHAR) as DataType,
      }));

    const pageStore = this.storageBackend.createPageStore(this.tempManager.allocate('buffer', tableName));
    let table: Table | null = null;
    let columns: ColumnSchema[] | null = null;
    let rowCount = 0;

    for await (const chunk of result.chunks()) {
      if (!table) {
        columns = columnNames.map((name: string, j: number) => ({
          name: name.toUpperCase(),
          dataType: chunk.columns[j].dataType,
        }));
        table = new Table(tableName, columns, pageStore);
      }
      if (chunk.size === 0) continue;
      const rows = chunk.toRows();
      for (const row of rows) {
        for (let j = 0; j < row.length; j++) {
          row[j] = coerceForStorage(row[j], columns![j].dataType);
        }
      }
      await table.insertRows(rows);
      rowCount += chunk.size;
    }

    if (!table) {
      columns = fallbackTypes();
      table = new Table(tableName, columns, pageStore);
    }
    await table.flush();

    this.catalog.registerTable(tableName, columns!);
    this.catalog.registerTableStorage(tableName, table);

    return { rows: [], columns: [], message: `Table ${tableName} created with ${rowCount} rows` };
  }

  executeDropTable(stmt: DropTableStmtNode): DDLResult {
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

  async stream(sql: string): Promise<DDLResult | RunRowsResult | QueryResult> {
    const compiled = await this.compile(sql);
    if (compiled.ddl) return this.executeDDL(compiled.ddl);

    const { plan, outputColumns, cteMap, isExplain, isAnalyze } = compiled;

    if (isExplain && !isAnalyze) {
      return this._explainPlanResult(plan);
    }

    this.executor.cteDefinitions = cteMap;
    const { sink, columnNames } = await this.executor.execute(plan, outputColumns as ExecutorColumns, true);
    return new QueryResult(columnNames, sink);
  }

  async buildIndexes(): Promise<void> {
    for (const tableName of this.catalog.listTables()) {
      const tableDef = this.catalog.getTable(tableName) as CatalogTable;
      if (!tableDef.primaryKey || tableDef.primaryKey.length === 0) continue;

      const storage = this.catalog.getTableStorage(tableName);
      if (!storage || !isPagedTableStorage(storage)) continue;

      for (const pkCol of tableDef.primaryKey) {
        const colIdx = tableDef.columns.findIndex((c: ColumnSchema) => c.name.toUpperCase() === pkCol.toUpperCase());
        if (colIdx < 0) continue;

        const colDef = tableDef.columns[colIdx];
        const btree = new BTreeIndex(colDef.dataType);

        await storage.flush();
        for (let p = 0; p < storage.pageIds.length; p++) {
          const pageId = storage.pageIds[p];
          const chunk = await storage.pageCache.fetchPage(pageId, true);
          if (!chunk) continue;
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

  async enableWasm(): Promise<void> {
    try {
      const { getGlobalLoader } = await import('../wasm/loader.js');
      const loader = await getGlobalLoader();
      await loader.loadModule('core');
      const { registerAllKernels } = await import('../wasm/register-kernels.js');
      registerAllKernels();
      this.wasmEnabled = true;
    } catch (error) {
      console.warn('[wasm] Failed to enable WebAssembly acceleration:', error);
      this.wasmEnabled = false;
    }
  }

  async enableParallel(): Promise<boolean> {
    const { Config } = await import('../config.js');
    if (Config.parallelWorkers <= 1) return false;

    try {
      const { getGlobalLoader } = await import('../wasm/loader.js');
      const loader = await getGlobalLoader({ shared: true });
      await loader.loadModule('core');

      const regionAllocator = loader.initRegions(Config.regionSize);

      const { registerAllKernels } = await import('../wasm/register-kernels.js');
      registerAllKernels();
      this.wasmEnabled = true;

      const wasmModule = loader.getModule('core');
      const { WorkerPool } = await import('../parallel/worker-pool.js');
      const pool = new WorkerPool({
        maxWorkers: Config.parallelWorkers,
        wasmModule: wasmModule!,
        wasmMemory: loader.memory!,
        regionAllocator,
      });
      await pool.init();

      const { globalDispatch } = await import('../wasm/dispatch.js');
      const { ParallelDispatch } = await import('../parallel/parallel-dispatch.js');
      const parallelDispatch = new ParallelDispatch(pool, regionAllocator, globalDispatch);

      const { FragmentPool } = await import('../parallel/fragment-pool.js');
      const fragmentPool = new FragmentPool(Config.parallelWorkers, Config.aggMorselRows);

      this.executor.setParallelContext(pool, parallelDispatch, fragmentPool);
      this.workerPool = pool;
      this.fragmentPool = fragmentPool;
      this.parallelEnabled = true;
      return true;
    } catch (_) {
      this.parallelEnabled = false;
      return false;
    }
  }

  async enableDistributed(clusterConfig: DistributedClusterConfig = {}): Promise<QueryCoordinator> {
    const { NodeDescriptor, NodeRole } = await import('../distributed/cluster/node-descriptor.js');
    const { ClusterManager } = await import('../distributed/cluster/cluster-manager.js');
    const { PartitionMap } = await import('../distributed/partition/partition-map.js');
    const { DistributionAwareJoin } = await import('../distributed/optimizer/distribution-aware-join.js');
    const { PartialAggregatePass } = await import('../distributed/optimizer/partial-aggregate.js');
    const { DistributedSortPass } = await import('../distributed/optimizer/distributed-sort.js');
    const { DistributedDistinctPass } = await import('../distributed/optimizer/distributed-distinct.js');
    const { DistributedSetOpPass } = await import('../distributed/optimizer/distributed-setop.js');
    const { DistributedLimitPass } = await import('../distributed/optimizer/distributed-limit.js');
    const { QueryCoordinator } = await import('../distributed/execution/coordinator.js');

    const localNode = new NodeDescriptor({
      nodeId: clusterConfig.nodeId || `node-${Date.now()}`,
      host: clusterConfig.host || '127.0.0.1',
      port: clusterConfig.port || Config.clusterPort,
      role: clusterConfig.role || NodeRole.HYBRID,
      capacity: clusterConfig.capacity,
    });

    const clusterManager = new ClusterManager(localNode);
    const partitionMap = new PartitionMap();
    const statsMap = this.precomputedStats || new Map();

    const makeDistributedPasses = (): DistributedPassEntry[] => [
      { method: 'insertPassAfter', args: [PLAN_PROPERTIES_PASS, new DistributionAwareJoin(partitionMap, statsMap)] },
      { method: 'registerPass', args: [new PartialAggregatePass()] },
      { method: 'registerPass', args: [new DistributedSortPass()] },
      { method: 'registerPass', args: [new DistributedDistinctPass(partitionMap)] },
      { method: 'registerPass', args: [new DistributedSetOpPass(partitionMap)] },
      { method: 'registerPass', args: [new DistributedLimitPass(partitionMap)] },
    ];

    this._applyDistributedPasses(this.optimizer, makeDistributedPasses());
    this._distributedPasses = makeDistributedPasses();

    let transport = clusterConfig.transport || null;
    if (!transport) {
      const { HttpTransport } = await import('../distributed/transport/http-transport.js');
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

  async shutdown(): Promise<void> {
    if (this.workerPool) {
      await this.workerPool.shutdown();
      this.workerPool = null;
    }
    if (this.fragmentPool) {
      await this.fragmentPool.close();
      this.fragmentPool = null;
    }
    if (this.distributed?.transport) {
      await this.distributed.transport.stop();
    }
    this.tempManager.cleanup();
  }
}
