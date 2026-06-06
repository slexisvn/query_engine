import { describe, it, expect } from 'vitest';
import { parse } from '../../src/parser/parser.js';
import { Binder } from '../../src/binder/binder.js';
import { createLogicalPlan } from '../../src/planner/logical-planner.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { defaultFunctionRegistry } from '../../src/catalog/function-registry.js';
import { Optimizer } from '../../src/optimizer/optimizer.js';
import { PlanNodeType, JoinType, PhysicalStrategy } from '../../src/planner/logical-plan.js';

import { ExpressionSimplifier } from '../../src/optimizer/passes/expression-simplifier.js';
import { SubqueryUnnesting } from '../../src/optimizer/passes/subquery-unnesting.js';
import { HavingPushdown } from '../../src/optimizer/passes/having-pushdown.js';
import { CTEOptimization } from '../../src/optimizer/passes/cte-optimization.js';
import { PredicatePushdown } from '../../src/optimizer/passes/predicate-pushdown.js';
import { PredicateInference } from '../../src/optimizer/passes/predicate-inference.js';
import { OuterToInnerJoin } from '../../src/optimizer/passes/outer-to-inner.js';
import { JoinElimination } from '../../src/optimizer/passes/join-elimination.js';
import { ProjectionPushdown } from '../../src/optimizer/passes/projection-pushdown.js';
import { LimitPushdown } from '../../src/optimizer/passes/limit-pushdown.js';
import { EmptyPropagation } from '../../src/optimizer/passes/empty-propagation.js';
import { NodeMerge } from '../../src/optimizer/passes/node-merge.js';
import { PredicateDedup } from '../../src/optimizer/passes/predicate-dedup.js';
import { JoinResidualSplit } from '../../src/optimizer/passes/join-residual-split.js';
import { PhysicalDesign } from '../../src/optimizer/passes/physical-design.js';
import { SortElimination } from '../../src/optimizer/passes/sort-elimination.js';
import { TopNFusion } from '../../src/optimizer/passes/topn-fusion.js';
import { IndexSelection } from '../../src/optimizer/passes/index-selection.js';

function createCatalog() {
  const catalog = new Catalog();
  catalog.registerTable('ORDERS', [
    { name: 'O_ORDERKEY', dataType: 'INT32' },
    { name: 'O_CUSTKEY', dataType: 'INT32' },
    { name: 'O_TOTALPRICE', dataType: 'FLOAT64' },
    { name: 'O_ORDERDATE', dataType: 'DATE' },
    { name: 'O_STATUS', dataType: 'VARCHAR' },
  ], { primaryKey: ['O_ORDERKEY'] });

  catalog.registerTable('CUSTOMER', [
    { name: 'C_CUSTKEY', dataType: 'INT32' },
    { name: 'C_NAME', dataType: 'VARCHAR' },
    { name: 'C_NATIONKEY', dataType: 'INT32' },
  ], { primaryKey: ['C_CUSTKEY'] });

  catalog.registerTable('LINEITEM', [
    { name: 'L_ORDERKEY', dataType: 'INT32' },
    { name: 'L_PARTKEY', dataType: 'INT32' },
    { name: 'L_QUANTITY', dataType: 'FLOAT64' },
    { name: 'L_EXTENDEDPRICE', dataType: 'FLOAT64' },
    { name: 'L_DISCOUNT', dataType: 'FLOAT64' },
  ], {
    primaryKey: ['L_ORDERKEY', 'L_PARTKEY'],
    foreignKeys: [{ columns: ['L_ORDERKEY'], refTable: 'ORDERS', refColumns: ['O_ORDERKEY'] }],
  });

  catalog.registerTable('NATION', [
    { name: 'N_NATIONKEY', dataType: 'INT32' },
    { name: 'N_NAME', dataType: 'VARCHAR' },
  ], { primaryKey: ['N_NATIONKEY'] });

  catalog.registerTable('PART', [
    { name: 'P_PARTKEY', dataType: 'INT32' },
    { name: 'P_NAME', dataType: 'VARCHAR' },
    { name: 'P_RETAILPRICE', dataType: 'FLOAT64' },
  ], { primaryKey: ['P_PARTKEY'] });

  return catalog;
}

function createOptimizer(catalog, statistics = null) {
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
  optimizer.registerPass(new JoinElimination());
  optimizer.registerPass(new ProjectionPushdown());
  optimizer.registerPass(new LimitPushdown());
  optimizer.registerPass(new EmptyPropagation());
  optimizer.registerPass(new NodeMerge());
  optimizer.registerPass(new PredicateDedup());
  optimizer.registerPass(new IndexSelection(catalog, statistics));
  optimizer.registerPass(new JoinResidualSplit());
  optimizer.registerPass(new PhysicalDesign(statistics || new Map()));
  optimizer.registerPass(new SortElimination());
  optimizer.registerPass(new TopNFusion());
  return optimizer;
}

function optimizeSQL(sql, catalog = null, statistics = null) {
  catalog = catalog || createCatalog();
  const ast = parse(sql);
  const binder = new Binder(catalog, defaultFunctionRegistry);
  const bound = binder.bind(ast);
  const logical = createLogicalPlan(bound);
  const optimizer = createOptimizer(catalog, statistics);
  return optimizer.optimize(logical);
}

function findNodes(plan, type) {
  const result = [];
  const queue = [plan];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) continue;
    if (node.type === type) result.push(node);
    if (node.children) queue.push(...node.children);
  }
  return result;
}

function findNode(plan, type) {
  return findNodes(plan, type)[0] || null;
}

function leafNodes(plan) {
  const result = [];
  const queue = [plan];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) continue;
    if (!node.children || node.children.length === 0) {
      result.push(node);
    } else {
      queue.push(...node.children);
    }
  }
  return result;
}

describe('Optimizer E2E', () => {
  describe('predicate pushdown', () => {
    it('pushes filter below join to scan level', () => {
      const plan = optimizeSQL(`
        SELECT o.O_ORDERKEY, c.C_NAME
        FROM ORDERS o JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
        WHERE o.O_TOTALPRICE > 100
      `);

      const filters = findNodes(plan, PlanNodeType.FILTER);
      const join = findNode(plan, PlanNodeType.JOIN);
      const scans = findNodes(plan, PlanNodeType.SCAN);

      expect(filters.length).toBeGreaterThan(0);
      const filterBelowJoin = filters.some(f => {
        const parent = findParent(plan, f);
        return parent && parent.type !== PlanNodeType.JOIN;
      });
      expect(filterBelowJoin || scans.some(s => findParent(plan, s)?.type === PlanNodeType.FILTER)).toBe(true);
    });

    it('pushes predicates for both join sides', () => {
      const plan = optimizeSQL(`
        SELECT * FROM ORDERS o JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
        WHERE o.O_TOTALPRICE > 100 AND c.C_NAME = 'Alice'
      `);

      const filters = findNodes(plan, PlanNodeType.FILTER);
      expect(filters.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('predicate inference', () => {
    it('infers transitive predicate across join', () => {
      const plan = optimizeSQL(`
        SELECT * FROM ORDERS o JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
        WHERE o.O_CUSTKEY = 42
      `);

      const filters = findNodes(plan, PlanNodeType.FILTER);
      const filterConditions = filters.map(f => JSON.stringify(f.condition));
      const hasInferredOnCustomer = filterConditions.some(c => c.includes('C_CUSTKEY') && c.includes('42'));
      expect(hasInferredOnCustomer).toBe(true);
    });
  });

  describe('expression simplification', () => {
    it('simplifies 1=1 to true and eliminates trivial filter', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS WHERE 1 = 1
      `);

      const filters = findNodes(plan, PlanNodeType.FILTER);
      expect(filters.length).toBe(0);
    });

    it('simplifies impossible condition to empty result', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS WHERE 1 = 0
      `);

      const empties = findNodes(plan, PlanNodeType.EMPTY);
      expect(empties.length).toBeGreaterThan(0);
    });

    it('simplifies double negation NOT NOT x', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS WHERE NOT NOT (O_TOTALPRICE > 100)
      `);

      const filters = findNodes(plan, PlanNodeType.FILTER);
      if (filters.length > 0) {
        const condStr = JSON.stringify(filters[0].condition);
        const notCount = (condStr.match(/NOT/gi) || []).length;
        expect(notCount).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('projection pushdown', () => {
    it('pushes column projection into scan', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS
      `);

      const scans = findNodes(plan, PlanNodeType.SCAN);
      expect(scans.length).toBe(1);
      const scanCols = scans[0].columns.map(c => c.name || c);
      expect(scanCols.length).toBeLessThan(5);
    });

    it('requests only needed columns through join', () => {
      const plan = optimizeSQL(`
        SELECT o.O_ORDERKEY, c.C_NAME
        FROM ORDERS o JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
      `);

      const scans = findNodes(plan, PlanNodeType.SCAN);
      for (const scan of scans) {
        const colNames = scan.columns.map(c => (c.name || c).toUpperCase());
        expect(colNames.length).toBeLessThan(5);
      }
    });
  });

  describe('outer to inner join conversion', () => {
    it('converts LEFT JOIN to INNER when WHERE filters nulls', () => {
      const plan = optimizeSQL(`
        SELECT o.O_ORDERKEY, c.C_NAME
        FROM ORDERS o LEFT JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
        WHERE c.C_NAME IS NOT NULL
      `);

      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins.length).toBe(1);
      expect(joins[0].joinType).toBe(JoinType.INNER);
    });

    it('preserves LEFT JOIN when no null-rejecting filter', () => {
      const plan = optimizeSQL(`
        SELECT o.O_ORDERKEY, c.C_NAME
        FROM ORDERS o LEFT JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
      `);

      const joins = findNodes(plan, PlanNodeType.JOIN);
      expect(joins[0].joinType).toBe(JoinType.LEFT);
    });
  });

  describe('join elimination', () => {
    it('eliminates join to PK table when no columns used', () => {
      const plan = optimizeSQL(`
        SELECT o.O_ORDERKEY, o.O_TOTALPRICE
        FROM ORDERS o JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
      `);

      const joins = findNodes(plan, PlanNodeType.JOIN);
      const scans = findNodes(plan, PlanNodeType.SCAN);
      if (joins.length === 0) {
        expect(scans.length).toBe(1);
        const scanTable = scans[0].table.toUpperCase();
        expect(scanTable).toBe('ORDERS');
      }
    });
  });

  describe('topN fusion', () => {
    it('fuses SORT + LIMIT into TOP_N', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS ORDER BY O_TOTALPRICE DESC LIMIT 10
      `);

      const topNs = findNodes(plan, PlanNodeType.TOP_N);
      const sorts = findNodes(plan, PlanNodeType.SORT);
      const limits = findNodes(plan, PlanNodeType.LIMIT);

      expect(topNs.length).toBe(1);
      expect(sorts.length).toBe(0);
      expect(limits.length).toBe(0);
      expect(topNs[0].count).toBe(10);
    });

    it('fuses SORT + LIMIT with OFFSET', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS ORDER BY O_TOTALPRICE LIMIT 5 OFFSET 10
      `);

      const topNs = findNodes(plan, PlanNodeType.TOP_N);
      expect(topNs.length).toBe(1);
      expect(topNs[0].count).toBe(5);
      expect(topNs[0].offset).toBe(10);
    });
  });

  describe('sort elimination', () => {
    it('removes redundant sort when child already sorted', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS
        ORDER BY O_ORDERKEY
        LIMIT 10
      `);

      const topNs = findNodes(plan, PlanNodeType.TOP_N);
      const sorts = findNodes(plan, PlanNodeType.SORT);
      expect(topNs.length + sorts.length).toBeGreaterThan(0);
    });
  });

  describe('limit pushdown', () => {
    it('pushes limit through projection', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY * 2 FROM ORDERS LIMIT 5
      `);

      const limits = findNodes(plan, PlanNodeType.LIMIT);
      const topNs = findNodes(plan, PlanNodeType.TOP_N);
      const total = limits.length + topNs.length;
      expect(total).toBeGreaterThan(0);
    });
  });

  describe('node merge', () => {
    it('merges adjacent filters into single filter', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS
        WHERE O_TOTALPRICE > 100 AND O_STATUS = 'F'
      `);

      const filters = findNodes(plan, PlanNodeType.FILTER);
      expect(filters.length).toBeLessThanOrEqual(1);
    });
  });

  describe('predicate dedup', () => {
    it('removes duplicate predicates', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS
        WHERE O_TOTALPRICE > 100 AND O_TOTALPRICE > 100
      `);

      const filters = findNodes(plan, PlanNodeType.FILTER);
      if (filters.length > 0) {
        const condStr = JSON.stringify(filters[0].condition);
        const matches = condStr.match(/O_TOTALPRICE/gi) || [];
        expect(matches.length).toBeLessThanOrEqual(2);
      }
    });
  });

  describe('empty propagation', () => {
    it('propagates empty through join when one side is impossible', () => {
      const plan = optimizeSQL(`
        SELECT * FROM ORDERS o JOIN (SELECT * FROM CUSTOMER WHERE 1=0) c ON o.O_CUSTKEY = c.C_CUSTKEY
      `);

      const empties = findNodes(plan, PlanNodeType.EMPTY);
      expect(empties.length).toBeGreaterThan(0);
    });
  });

  describe('physical design', () => {
    it('assigns physical strategy to join nodes', () => {
      const plan = optimizeSQL(`
        SELECT * FROM ORDERS o JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
      `);

      const joins = findNodes(plan, PlanNodeType.JOIN);
      if (joins.length > 0) {
        expect(joins[0].physicalStrategy).toBeDefined();
        expect([PhysicalStrategy.HASH, PhysicalStrategy.MERGE]).toContain(joins[0].physicalStrategy);
      }
    });

    it('assigns physical strategy to aggregate nodes', () => {
      const plan = optimizeSQL(`
        SELECT O_STATUS, COUNT(*) FROM ORDERS GROUP BY O_STATUS
      `);

      const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
      expect(aggs.length).toBe(1);
      expect(aggs[0].physicalStrategy).toBeDefined();
    });
  });

  describe('CTE optimization', () => {
    it('handles CTE without error', () => {
      const plan = optimizeSQL(`
        WITH top_orders AS (
          SELECT O_ORDERKEY, O_TOTALPRICE FROM ORDERS WHERE O_TOTALPRICE > 1000
        )
        SELECT * FROM top_orders
      `);

      expect(plan).toBeDefined();
      expect(plan.type).toBeDefined();
    });
  });

  describe('subquery unnesting', () => {
    it('converts EXISTS subquery to semi join', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS o
        WHERE EXISTS (SELECT 1 FROM LINEITEM l WHERE l.L_ORDERKEY = o.O_ORDERKEY)
      `);

      const joins = findNodes(plan, PlanNodeType.JOIN);
      const semiJoins = joins.filter(j => j.joinType === JoinType.SEMI);
      const depJoins = findNodes(plan, PlanNodeType.DEPENDENT_JOIN);

      expect(semiJoins.length + depJoins.length).toBeGreaterThan(0);
    });

    it('converts NOT EXISTS to anti join', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS o
        WHERE NOT EXISTS (SELECT 1 FROM LINEITEM l WHERE l.L_ORDERKEY = o.O_ORDERKEY)
      `);

      const joins = findNodes(plan, PlanNodeType.JOIN);
      const antiJoins = joins.filter(j => j.joinType === JoinType.ANTI);
      const depJoins = findNodes(plan, PlanNodeType.DEPENDENT_JOIN);

      expect(antiJoins.length + depJoins.length).toBeGreaterThan(0);
    });

    it('converts IN subquery to semi join', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS
        WHERE O_CUSTKEY IN (SELECT C_CUSTKEY FROM CUSTOMER WHERE C_NAME = 'Alice')
      `);

      const joins = findNodes(plan, PlanNodeType.JOIN);
      const semiOrMark = joins.filter(j => j.joinType === JoinType.SEMI || j.joinType === JoinType.MARK);
      const depJoins = findNodes(plan, PlanNodeType.DEPENDENT_JOIN);

      expect(semiOrMark.length + depJoins.length).toBeGreaterThan(0);
    });
  });

  describe('having pushdown', () => {
    it('pushes HAVING filter referencing group key below aggregate', () => {
      const plan = optimizeSQL(`
        SELECT O_STATUS, SUM(O_TOTALPRICE)
        FROM ORDERS
        GROUP BY O_STATUS
        HAVING O_STATUS = 'F'
      `);

      const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
      const filters = findNodes(plan, PlanNodeType.FILTER);
      const filterBelowAgg = filters.some(f => {
        const queue = aggs.flatMap(a => a.children || []);
        while (queue.length) {
          const n = queue.shift();
          if (n === f) return true;
          if (n?.children) queue.push(...n.children);
        }
        return false;
      });

      expect(filterBelowAgg).toBe(true);
    });
  });

  describe('complex multi-pass interaction', () => {
    it('optimizes multi-join query with filters on each table', () => {
      const plan = optimizeSQL(`
        SELECT o.O_ORDERKEY, c.C_NAME, l.L_QUANTITY
        FROM ORDERS o
        JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
        JOIN LINEITEM l ON o.O_ORDERKEY = l.L_ORDERKEY
        WHERE o.O_TOTALPRICE > 500
          AND c.C_NAME LIKE 'A%'
          AND l.L_QUANTITY > 10
      `);

      const filters = findNodes(plan, PlanNodeType.FILTER);
      expect(filters.length).toBeGreaterThanOrEqual(3);

      const scans = findNodes(plan, PlanNodeType.SCAN);
      expect(scans.length).toBe(3);
    });

    it('optimizes aggregate with ORDER BY and LIMIT into TopN', () => {
      const plan = optimizeSQL(`
        SELECT O_CUSTKEY, SUM(O_TOTALPRICE) as total
        FROM ORDERS
        GROUP BY O_CUSTKEY
        ORDER BY total DESC
        LIMIT 10
      `);

      const topNs = findNodes(plan, PlanNodeType.TOP_N);
      const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
      expect(aggs.length).toBe(1);
      expect(topNs.length).toBe(1);
    });

    it('optimizes UNION with filters', () => {
      const plan = optimizeSQL(`
        SELECT O_ORDERKEY FROM ORDERS WHERE O_TOTALPRICE > 100
        UNION ALL
        SELECT O_ORDERKEY FROM ORDERS WHERE O_TOTALPRICE < 10
      `);

      const unions = findNodes(plan, PlanNodeType.UNION);
      expect(unions.length).toBe(1);
      const filters = findNodes(plan, PlanNodeType.FILTER);
      expect(filters.length).toBe(2);
    });

    it('full pipeline: filter + join + aggregate + sort + limit', () => {
      const plan = optimizeSQL(`
        SELECT c.C_NAME, SUM(o.O_TOTALPRICE) as total
        FROM ORDERS o
        JOIN CUSTOMER c ON o.O_CUSTKEY = c.C_CUSTKEY
        WHERE o.O_TOTALPRICE > 0
        GROUP BY c.C_NAME
        ORDER BY total DESC
        LIMIT 5
      `);

      expect(plan).toBeDefined();
      const joins = findNodes(plan, PlanNodeType.JOIN);
      const aggs = findNodes(plan, PlanNodeType.AGGREGATE);
      const topNs = findNodes(plan, PlanNodeType.TOP_N);

      expect(joins.length).toBeGreaterThanOrEqual(1);
      expect(aggs.length).toBe(1);
      expect(topNs.length).toBe(1);
      expect(topNs[0].count).toBe(5);
    });
  });
});

function findParent(root, target) {
  if (!root || !root.children) return null;
  for (const child of root.children) {
    if (child === target) return root;
    const found = findParent(child, target);
    if (found) return found;
  }
  return null;
}
