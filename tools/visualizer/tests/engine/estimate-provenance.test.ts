import { describe, it, expect } from 'vitest';
import { buildStatistics, DEFAULT_ROW_COUNTS } from '../../src/engine/demo-catalog.js';
import { columnFactOf, qualifiedName } from '../../src/engine/column-facts.js';
import { aliasToTable, explainEstimate, indexScannedTables } from '../../src/engine/estimate-provenance.js';
import { flattenPlanView, toPlanView } from '../../src/engine/plan-view.js';
import { mainTrace, trace } from './helpers.js';
import type { PlanViewNode } from '../../src/engine/plan-view.js';

const FILTERED_JOIN = `
  SELECT c.C_NAME, o.O_TOTALPRICE
  FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
  WHERE c.C_MKTSEGMENT = 'BUILDING'
`;

const STATISTICS = buildStatistics(DEFAULT_ROW_COUNTS);

function finalView(sql: string): PlanViewNode {
  const optimize = mainTrace(trace(sql));
  return toPlanView(optimize.snapshots[optimize.snapshots.length - 1].display);
}

function snapshotView(sql: string, at: number): PlanViewNode {
  return toPlanView(mainTrace(trace(sql)).snapshots[at].display);
}

function nodeTitled(root: PlanViewNode, title: string): PlanViewNode {
  const found = flattenPlanView(root).find(node => node.title === title);
  if (!found) throw new Error(`no ${title} node`);
  return found;
}

describe('column facts', () => {
  it('reads what the estimator knows about a column', () => {
    const fact = columnFactOf(STATISTICS, 'CUSTOMER', 'C_MKTSEGMENT');

    expect(fact.known).toBe(true);
    expect(fact.ndv).toBeGreaterThan(0);
    expect(qualifiedName(fact)).toBe('CUSTOMER.C_MKTSEGMENT');
  });

  it('matches a column whatever case it is asked for in', () => {
    expect(columnFactOf(STATISTICS, 'customer', 'c_mktsegment').ndv)
      .toBe(columnFactOf(STATISTICS, 'CUSTOMER', 'C_MKTSEGMENT').ndv);
  });

  it('says plainly when it knows nothing', () => {
    const fact = columnFactOf(STATISTICS, 'CUSTOMER', 'NO_SUCH_COLUMN');

    expect(fact.known).toBe(false);
    expect(fact.ndv).toBeNull();
    expect(fact.histogramBuckets).toBeNull();
  });

  it('knows nothing about a table that was never collected', () => {
    expect(columnFactOf(STATISTICS, 'NOT_A_TABLE', 'X').known).toBe(false);
  });
});

describe('mapping aliases back to tables', () => {
  it('resolves the alias a query gave a table', () => {
    const optimize = mainTrace(trace(FILTERED_JOIN));
    const aliases = aliasToTable(optimize.snapshots[0].plan);

    expect(aliases.get('C')).toBe('CUSTOMER');
    expect(aliases.get('O')).toBe('ORDERS');
  });

  it('falls back to the table name when no alias was given', () => {
    const optimize = mainTrace(trace('SELECT C_NAME FROM CUSTOMER'));
    const aliases = aliasToTable(optimize.snapshots[0].plan);

    expect(aliases.get('CUSTOMER')).toBe('CUSTOMER');
  });
});

describe('explaining an estimate', () => {
  it('derives the selectivity the estimator applied', () => {
    const root = finalView(FILTERED_JOIN);
    const filter = nodeTitled(root, 'Filter');
    const explained = explainEstimate(filter, filter.node, STATISTICS);

    expect(explained.inputRows).toBe(filter.children[0].cardinality);
    expect(explained.outputRows).toBe(filter.cardinality);
    expect(explained.selectivity).toBeCloseTo((filter.cardinality as number) / (filter.children[0].cardinality as number));
  });

  it('names the column the predicate reads and the stats behind it', () => {
    const root = finalView(FILTERED_JOIN);
    const filter = nodeTitled(root, 'Filter');
    const explained = explainEstimate(filter, root.node, STATISTICS);

    expect(explained.facts.map(qualifiedName)).toContain('CUSTOMER.C_MKTSEGMENT');
    expect(explained.facts.every(fact => fact.known)).toBe(true);
  });

  it('resolves both sides of a join condition to their own tables', () => {
    const root = finalView(FILTERED_JOIN);
    const join = nodeTitled(root, 'Join');
    const explained = explainEstimate(join, root.node, STATISTICS);

    expect(explained.facts.map(qualifiedName).sort()).toEqual(['CUSTOMER.C_CUSTKEY', 'ORDERS.O_CUSTKEY']);
  });

  it('measures a join against the cross product of its inputs', () => {
    const root = finalView(FILTERED_JOIN);
    const join = nodeTitled(root, 'Join');
    const explained = explainEstimate(join, root.node, STATISTICS);
    const product = join.children.reduce((total, child) => total * (child.cardinality as number), 1);

    expect(explained.inputRows).toBe(product);
    expect(explained.selectivity).toBeLessThan(1);
  });

  it('leaves selectivity unset for a leaf with no input', () => {
    const root = finalView('SELECT C_NAME FROM CUSTOMER');
    const scan = flattenPlanView(root).find(node => node.children.length === 0);
    const explained = explainEstimate(scan as PlanViewNode, root.node, STATISTICS);

    expect(explained.inputRows).toBeNull();
    expect(explained.selectivity).toBeNull();
  });

  it('marks a referenced column that the table has an index on', () => {
    const root = finalView(FILTERED_JOIN);
    const join = nodeTitled(root, 'Join');
    const indexed = new Set(['CUSTOMER.C_CUSTKEY', 'ORDERS.O_ORDERKEY']);
    const explained = explainEstimate(join, root.node, STATISTICS, indexed);

    const byName = new Map(explained.facts.map(fact => [qualifiedName(fact), fact.indexed]));
    expect(byName.get('CUSTOMER.C_CUSTKEY')).toBe(true);
    expect(byName.get('ORDERS.O_CUSTKEY')).toBe(false);
  });

  it('flags a filter that reads sequentially despite an index on its column', () => {
    const root = finalView("SELECT C_NAME FROM CUSTOMER WHERE C_MKTSEGMENT = 'BUILDING' AND C_CUSTKEY > 4");
    const filter = nodeTitled(root, 'Filter');
    const explained = explainEstimate(filter, root.node, STATISTICS, new Set(['CUSTOMER.C_CUSTKEY']));

    expect(filter.children[0].title).toContain('Seq Scan');
    expect(explained.readsSequentially).toBe(true);
  });

  it('does not flag a filter whose columns carry no index', () => {
    const root = finalView("SELECT C_NAME FROM CUSTOMER WHERE C_MKTSEGMENT = 'BUILDING'");
    const filter = nodeTitled(root, 'Filter');

    expect(explainEstimate(filter, root.node, STATISTICS, new Set()).readsSequentially).toBe(false);
  });

  it('stays quiet on a snapshot taken before IndexSelection has run', () => {
    const sql = 'SELECT O_ORDERKEY, O_TOTALPRICE FROM ORDERS WHERE O_ORDERKEY = 42';
    const indexed = new Set(['ORDERS.O_ORDERKEY']);
    const scanned = indexScannedTables(finalView(sql).node);
    const early = snapshotView(sql, 0);
    const filter = nodeTitled(early, 'Filter');

    expect(filter.children[0].title).toContain('Seq Scan');
    expect(scanned.has('ORDERS')).toBe(true);
    expect(explainEstimate(filter, early.node, STATISTICS, indexed, scanned).readsSequentially).toBe(false);
  });

  it('still flags a scan the optimizer left sequential to the end', () => {
    const sql = "SELECT C_NAME FROM CUSTOMER WHERE C_MKTSEGMENT = 'BUILDING' AND C_CUSTKEY > 4";
    const root = finalView(sql);
    const scanned = indexScannedTables(root.node);
    const filter = nodeTitled(root, 'Filter');

    expect(scanned.has('CUSTOMER')).toBe(false);
    expect(
      explainEstimate(filter, root.node, STATISTICS, new Set(['CUSTOMER.C_CUSTKEY']), scanned).readsSequentially,
    ).toBe(true);
  });

  it('lists each referenced column once however often it appears', () => {
    const root = finalView(`
      SELECT C_NAME FROM CUSTOMER
      WHERE C_CUSTKEY > 10 AND C_CUSTKEY < 900 AND C_MKTSEGMENT = 'BUILDING'
    `);
    const filter = flattenPlanView(root).find(node => node.title === 'Filter' || node.title === 'Seq Scan on CUSTOMER');
    const explained = explainEstimate(filter as PlanViewNode, root.node, STATISTICS);
    const names = explained.facts.map(qualifiedName);

    expect(new Set(names).size).toBe(names.length);
  });
});
