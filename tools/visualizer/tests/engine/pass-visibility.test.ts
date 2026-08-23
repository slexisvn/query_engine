import { describe, it, expect } from 'vitest';
import { createDefaultOptimizer } from '@engine/optimizer/optimizer-pipeline.js';
import { planSignature } from '@engine/optimizer/plan-signature.js';
import { CTEOptimization } from '@engine/optimizer/passes/cte-optimization.js';
import { NodeMerge } from '@engine/optimizer/passes/node-merge.js';
import { PredicateDedup } from '@engine/optimizer/passes/predicate-dedup.js';
import { PlanProperties } from '@engine/optimizer/passes/plan-properties.js';
import {
  JoinType, LogicalCTEAnchor, LogicalCTEScan,
  LogicalFilter, LogicalJoin, LogicalScan,
} from '@engine/planner/logical-plan.js';
import { BoundExprKind } from '@engine/binder/expression-binder.js';
import { buildStatistics, createDemoCatalog, DEFAULT_ROW_COUNTS } from '../../src/engine/demo-catalog.js';
import { traceQuery } from '../../src/engine/trace.js';
import { planViewToText, toPlanView } from '../../src/engine/plan-view.js';
import { EXAMPLES } from '../../src/content/examples.js';
import type { LogicalPlanNode } from '@engine/planner/logical-plan.js';

const SQL_REACHABLE: readonly string[] = [
  'SELECT O_ORDERKEY FROM ORDERS WHERE O_TOTALPRICE > 500',
  "SELECT C_NAME FROM CUSTOMER WHERE C_ACCTBAL > 10 AND C_MKTSEGMENT = 'BUILDING'",
  'SELECT o.O_ORDERKEY FROM ORDERS o WHERE o.O_CUSTKEY IN (SELECT c.C_CUSTKEY FROM CUSTOMER c WHERE c.C_ACCTBAL > 0)',
  'SELECT c.C_NAME FROM CUSTOMER c LEFT JOIN ORDERS o ON o.O_CUSTKEY = c.C_CUSTKEY WHERE o.O_TOTALPRICE > c.C_ACCTBAL',
  'SELECT C_NAME FROM CUSTOMER WHERE 1 = 0',
  'SELECT o.O_ORDERKEY FROM ORDERS o JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY AND (o.O_TOTALPRICE > 1 OR l.L_QUANTITY > 2)',
  'SELECT DISTINCT O_ORDERKEY FROM ORDERS',
  'SELECT C_NAME FROM CUSTOMER ORDER BY C_CUSTKEY LIMIT 5',
  'SELECT o.O_ORDERKEY FROM ORDERS o LEFT JOIN CUSTOMER c ON c.C_CUSTKEY = o.O_CUSTKEY',
  'SELECT L_ORDERKEY FROM LINEITEM UNION ALL SELECT O_ORDERKEY FROM ORDERS LIMIT 3',
  'SELECT COUNT(*) FROM (SELECT * FROM ORDERS ORDER BY O_TOTALPRICE) t',
  'SELECT o.O_ORDERKEY FROM ORDERS o JOIN LINEITEM l ON l.L_ORDERKEY = o.O_ORDERKEY WHERE o.O_ORDERKEY = 42',
  'SELECT l.L_ORDERKEY, SUM(l.L_QUANTITY) FROM LINEITEM l JOIN ORDERS o ON o.O_ORDERKEY = l.L_ORDERKEY GROUP BY l.L_ORDERKEY',
];

const PASSES_REACHED_BY_SQL: readonly string[] = [
  'AggregatePushdown', 'DistinctElimination', 'EmptyPropagation', 'ExpressionSimplifier', 'FilterOrdering',
  'HavingPushdown', 'IndexSelection', 'JoinElimination', 'JoinReorder', 'JoinResidualSplit',
  'LimitPushdown', 'OuterToInnerJoin', 'PredicateInference', 'PredicatePushdown',
  'ProjectionPushdown', 'ScanPruning', 'SortElimination', 'SubqueryUnnesting', 'TopNFusion',
];

const PASSES_REACHED_DIRECTLY: readonly string[] = [
  'NodeMerge', 'PredicateDedup', 'CTEOptimization',
];

const ANNOTATION_ONLY: readonly string[] = ['PlanProperties'];

const col = (table: string, column: string) =>
  ({ kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: column }) as never;
const lit = (value: number) => ({ kind: BoundExprKind.LITERAL, value, dataType: 'INT32' }) as never;
const bin = (left: unknown, op: string, right: unknown) =>
  ({ kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' }) as never;
const scan = (name: string) => LogicalScan(name, [{ name: 'ID', dataType: 'INT32' }] as never, name);

function render(plan: LogicalPlanNode): string {
  return planViewToText(toPlanView(plan)).join('\n');
}

function rewroteInvisibly(before: LogicalPlanNode, after: LogicalPlanNode): boolean {
  return planSignature(before) !== planSignature(after) && render(before) === render(after);
}

function auditSql() {
  const catalog = createDemoCatalog();
  const statistics = buildStatistics(DEFAULT_ROW_COUNTS);
  const invisible: string[] = [];
  const reached = new Set<string>();

  for (const sql of [...EXAMPLES.map(example => example.sql), ...SQL_REACHABLE]) {
    const outcome = traceQuery(sql, catalog, statistics);
    if (!outcome.ok) continue;
    for (const subject of outcome.trace.subjects) {
      for (const step of subject.optimize.steps) {
        if (!step.changed) continue;
        reached.add(step.pass);
        const before = subject.optimize.snapshots[step.from].display;
        const after = subject.optimize.snapshots[step.to].display;
        if (rewroteInvisibly(before, after)) invisible.push(`${step.pass} on ${sql}`);
      }
    }
  }

  return { invisible, reached };
}

describe('passes reachable from SQL', () => {
  const audit = auditSql();

  it('leaves no rewrite invisible in the rendered plan', () => {
    expect(audit.invisible).toEqual([]);
  });

  it('actually exercises the passes these queries were chosen for', () => {
    expect(PASSES_REACHED_BY_SQL.filter(pass => !audit.reached.has(pass))).toEqual([]);
  });
});

describe('passes no SQL in the suite reaches', () => {
  it('NodeMerge shows two filters becoming one', () => {
    const before = LogicalFilter(
      bin(col('T', 'ID'), '>', lit(1)),
      LogicalFilter(bin(col('T', 'ID'), '<', lit(9)), scan('T')),
    );
    expect(rewroteInvisibly(before, new NodeMerge().apply(before))).toBe(false);
  });

  it('PredicateDedup shows the duplicate conjunct going away', () => {
    const duplicate = bin(col('T', 'ID'), '>', lit(1));
    const before = LogicalFilter(bin(duplicate, 'AND', duplicate), scan('T'));
    expect(rewroteInvisibly(before, new PredicateDedup().apply(before))).toBe(false);
  });

  it('CTEOptimization shows a single-reference anchor being inlined', () => {
    const before = LogicalCTEAnchor('c', 1, scan('T'), LogicalCTEScan('c', 1, [] as never, 'c'));
    expect(rewroteInvisibly(before, new CTEOptimization().apply(before))).toBe(false);
  });

  it('CTEOptimization shows a shared anchor being resolved', () => {
    const consumer = LogicalJoin(
      JoinType.INNER,
      null,
      LogicalCTEScan('c', 1, [] as never, 'a'),
      LogicalCTEScan('c', 1, [] as never, 'b'),
    );
    const before = LogicalCTEAnchor('c', 1, scan('T'), consumer);
    expect(rewroteInvisibly(before, new CTEOptimization().apply(before))).toBe(false);
  });

  it('PlanProperties only annotates, so it never counts as a rewrite', () => {
    const before = LogicalFilter(bin(col('T', 'ID'), '>', lit(1)), scan('T'));
    expect(planSignature(new PlanProperties().apply(before))).toBe(planSignature(before));
  });
});

describe('the audit covers the whole pipeline', () => {
  it('accounts for every registered pass', () => {
    const registered = createDefaultOptimizer({
      catalog: createDemoCatalog(),
      statistics: buildStatistics(DEFAULT_ROW_COUNTS),
    }).listPasses();

    const audited = new Set([...PASSES_REACHED_BY_SQL, ...PASSES_REACHED_DIRECTLY, ...ANNOTATION_ONLY]);
    expect([...new Set(registered)].filter(pass => !audited.has(pass))).toEqual([]);
  });
});
