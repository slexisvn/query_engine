import { describe, it, expect } from 'vitest';
import { toPlanView } from '../../src/engine/plan-view.js';
import { trace } from './helpers.js';

function nodeTitled(sql: string, title: string) {
  const optimize = trace(sql).subjects[0].optimize;
  const view = toPlanView(optimize.snapshots[0].display);
  const stack = [view];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.title === title) return node;
    stack.push(...node.children);
  }
  throw new Error(`no ${title} node in the plan for ${sql}`);
}

function balanced(text: string): boolean {
  let depth = 0;
  for (const character of text) {
    if (character === '(') depth++;
    else if (character === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

describe('plan view labels', () => {
  it('lifts a single wrapping group into the detail line', () => {
    const filter = nodeTitled("SELECT C_NAME FROM CUSTOMER WHERE C_ACCTBAL > 10", 'Filter');
    expect(filter.detail).toBe('condition: (CUSTOMER.C_ACCTBAL > 10)');
  });

  it('keeps both groups of an aggregate label balanced', () => {
    const aggregate = nodeTitled(
      'SELECT C_MKTSEGMENT, SUM(C_ACCTBAL) FROM CUSTOMER GROUP BY C_MKTSEGMENT',
      'Aggregate',
    );
    expect(aggregate.detail.startsWith('(group by:')).toBe(true);
    expect(balanced(aggregate.detail)).toBe(true);
  });

  it('lists the columns a scan reads', () => {
    const scan = nodeTitled('SELECT C_NAME FROM CUSTOMER', 'Seq Scan on CUSTOMER as CUSTOMER');
    expect(scan.detail).toBe('reads C_CUSTKEY, C_NAME, C_ADDRESS, C_NATIONKEY, C_PHONE, C_ACCTBAL, C_MKTSEGMENT, C_COMMENT');
  });

  it('shows a pruned scan reading fewer columns', () => {
    const pipeline = trace('SELECT C_NAME FROM CUSTOMER');
    const optimize = pipeline.subjects[0].optimize;
    const step = optimize.steps.find(candidate => candidate.pass === 'ProjectionPushdown' && candidate.changed);
    if (!step) throw new Error('ProjectionPushdown did not fire');

    const columnsAt = (index: number) => {
      const view = toPlanView(optimize.snapshots[index].display);
      const stack = [view];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (node.title.startsWith('Seq Scan')) return node.detail;
        stack.push(...node.children);
      }
      return '';
    };

    expect(columnsAt(step.from)).toContain('C_ADDRESS');
    expect(columnsAt(step.to)).toBe('reads C_NAME');
  });

  it('shows the pruning filter a scan carries', () => {
    const pipeline = trace("SELECT O_ORDERKEY FROM ORDERS WHERE O_TOTALPRICE > 500");
    const optimize = pipeline.subjects[0].optimize;
    const step = optimize.steps.find(candidate => candidate.pass === 'ScanPruning' && candidate.changed);
    if (!step) throw new Error('ScanPruning did not fire');

    const scanDetail = (index: number) => {
      const stack = [toPlanView(optimize.snapshots[index].display)];
      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        if (node.title.startsWith('Seq Scan')) return node.detail;
        stack.push(...node.children);
      }
      return '';
    };

    expect(scanDetail(step.from)).not.toContain('skips blocks');
    expect(scanDetail(step.to)).toContain("skips blocks that fail (ORDERS.O_TOTALPRICE > 500)");
  });

  it('keeps the read list alongside the pruning filter', () => {
    const pipeline = trace("SELECT O_ORDERKEY FROM ORDERS WHERE O_TOTALPRICE > 500");
    const optimize = pipeline.subjects[0].optimize;
    const view = toPlanView(optimize.snapshots[optimize.snapshots.length - 1].display);
    const stack = [view];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (node.title.startsWith('Seq Scan')) {
        expect(node.detail).toContain('reads ');
        expect(node.detail).toContain(' · ');
        return;
      }
      stack.push(...node.children);
    }
    throw new Error('no scan in the plan');
  });

  it('spells a date literal out instead of showing epoch days', () => {
    const filter = nodeTitled("SELECT O_ORDERKEY FROM ORDERS WHERE O_ORDERDATE < DATE '1995-03-15'", 'Filter');
    expect(filter.detail).toContain("DATE '1995-03-15'");
  });
});
