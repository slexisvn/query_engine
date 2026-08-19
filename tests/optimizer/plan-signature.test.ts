import { describe, it, expect } from 'vitest';
import { planSignature } from '../../src/optimizer/plan-signature.js';
import { LogicalScan, LogicalFilter, LogicalJoin, JoinType } from '../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

function col(table, name) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: name };
}

function gt(left, value) {
  return { kind: BoundExprKind.BINARY, op: '>', left, right: { kind: BoundExprKind.LITERAL, value } };
}

function scan(table) {
  return LogicalScan(table, [{ name: 'ID', dataType: 'INT32' }], table);
}

describe('planSignature', () => {
  it('gives structurally identical plans the same signature', () => {
    expect(planSignature(scan('ORDERS'))).toBe(planSignature(scan('ORDERS')));
  });

  it('distinguishes plans that scan different tables', () => {
    expect(planSignature(scan('ORDERS'))).not.toBe(planSignature(scan('CUSTOMER')));
  });

  it('distinguishes plans whose filter predicates differ', () => {
    const cheap = LogicalFilter(gt(col('O', 'PRICE'), 10), scan('ORDERS'));
    const dear = LogicalFilter(gt(col('O', 'PRICE'), 20), scan('ORDERS'));

    expect(planSignature(cheap)).not.toBe(planSignature(dear));
  });

  it('distinguishes plans whose filters sit at different depths', () => {
    const shallow = LogicalFilter(gt(col('O', 'PRICE'), 10), scan('ORDERS'));
    const deep = LogicalFilter(gt(col('O', 'PRICE'), 10), LogicalFilter(gt(col('O', 'PRICE'), 10), scan('ORDERS')));

    expect(planSignature(shallow)).not.toBe(planSignature(deep));
  });

  it('distinguishes join types', () => {
    const inner = LogicalJoin(JoinType.INNER, null, scan('A'), scan('B'));
    const left = LogicalJoin(JoinType.LEFT, null, scan('A'), scan('B'));

    expect(planSignature(inner)).not.toBe(planSignature(left));
  });

  it('ignores internal annotation fields so metadata churn does not block convergence', () => {
    const plain = scan('ORDERS');
    const annotated = { ...scan('ORDERS'), _cardinality: 42, _cost: 3.5, _sortedBy: ['ID'] };

    expect(planSignature(annotated)).toBe(planSignature(plain));
  });

  it('survives plans carrying bigint literals', () => {
    const plan = LogicalFilter(gt(col('O', 'ID'), BigInt('9007199254740993')), scan('ORDERS'));
    expect(() => planSignature(plan)).not.toThrow();
  });

  it('distinguishes bigint literals that differ beyond double precision', () => {
    const low = LogicalFilter(gt(col('O', 'ID'), BigInt('9007199254740993')), scan('ORDERS'));
    const high = LogicalFilter(gt(col('O', 'ID'), BigInt('9007199254740994')), scan('ORDERS'));

    expect(planSignature(low)).not.toBe(planSignature(high));
  });

  it('ignores the internal CTE map that holds non-serialisable values', () => {
    const withCteMap = { ...scan('ORDERS'), _cteMap: new Map([['X', scan('CUSTOMER')]]) };
    expect(planSignature(withCteMap)).toBe(planSignature(scan('ORDERS')));
  });
});
