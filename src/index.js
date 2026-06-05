import { parse } from './parser/parser.js';
import { Binder } from './binder/binder.js';
import { createLogicalPlan } from './planner/logical-planner.js';
import { defaultFunctionRegistry } from './catalog/function-registry.js';
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

export class QueryEngine {
  constructor(catalog, options = {}) {
    this.catalog = catalog;
    this.functionRegistry = defaultFunctionRegistry;
    this.tempManager = new TempDirectoryManager(options.tempDir ? { baseDir: options.tempDir } : {});
    this.executor = new QueryExecutor(catalog, this.tempManager);
    this.wasmEnabled = false;

    this.precomputedStats = options.statistics || null;
    this.optimizer = this.createOptimizer(this.precomputedStats);
  }

  close() {
    this.tempManager.cleanup();
  }

  async collectStatistics() {
    const stats = new Map();
    for (const name of this.catalog.listTables()) {
      const storage = this.catalog.getTableStorage(name);
      if (storage) {
        stats.set(name.toUpperCase(), await StatisticsCollector.collect(storage));
      }
    }
    return stats.size > 0 ? stats : null;
  }

  createOptimizer(statistics) {
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
    optimizer.registerPass(new IndexSelection(this.catalog, statistics));
    optimizer.registerPass(new JoinResidualSplit());
    optimizer.registerPass(new PhysicalDesign(statistics || new Map()));
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
    let targetAst = ast;

    if (ast.kind === 'ExplainStmt') {
      isExplain = true;
      targetAst = ast.query;
    }

    const bound = this.bind(targetAst);
    const logicalPlan = this.plan(bound);
    let cteMap = logicalPlan._cteMap || new Map();
    
    let currentStats = this.precomputedStats;
    if (!currentStats) {
      currentStats = await this.collectStatistics();
      this.optimizer = this.createOptimizer(currentStats);
    }
    
    const optimized = this.optimize(logicalPlan);
    cteMap = this.optimizeCTEMap(cteMap);
    return { plan: optimized, outputColumns: bound.outputColumns, cteMap, isExplain };
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
    const { plan, outputColumns, cteMap, isExplain } = await this.compile(sql);

    if (isExplain) {
      const { formatPlan } = await import('./planner/plan-formatter.js');
      const planStr = formatPlan(plan);
      return { rows: [{ 'EXPLAIN_PLAN': planStr }], columns: ['EXPLAIN_PLAN'] };
    }

    this.executor.cteDefinitions = cteMap;
    const { sink, columnNames } = await this.executor.execute(plan, outputColumns);
    const result = new QueryResult(columnNames, sink);
    return { rows: await result.toArray(), columns: columnNames };
  }

  async stream(sql) {
    const { plan, outputColumns, cteMap, isExplain } = await this.compile(sql);

    if (isExplain) {
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
}
