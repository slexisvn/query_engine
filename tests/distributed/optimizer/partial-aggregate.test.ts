import { describe, it, expect } from 'vitest';
import { PartialAggregatePass, DECOMPOSABLE_FUNCTIONS } from '../../../src/distributed/optimizer/partial-aggregate.js';
import { PlanNodeType, LogicalScan, LogicalAggregate } from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

function colRef(name) {
  return { kind: BoundExprKind.COLUMN_REF, columnName: name, tableAlias: 'T' };
}

function makeAgg(func, args = [], opts = {}) {
  return { func, args, name: func, isCountStar: opts.isCountStar || false, isDistinct: opts.isDistinct || false };
}

describe('PartialAggregatePass', () => {
  const pass = new PartialAggregatePass();

  it('skips non-distributed plans', () => {
    const scan = LogicalScan('T', []);
    const agg = LogicalAggregate([colRef('STATUS')], [makeAgg('SUM', [colRef('AMT')])], scan);

    const result = pass.apply(agg);
    expect(result.type).toBe(PlanNodeType.AGGREGATE);
  });

  it('decomposes SUM into partial + final', () => {
    const scan = LogicalScan('T', []);
    const agg = LogicalAggregate([colRef('STATUS')], [makeAgg('SUM', [colRef('AMT')])], scan);
    agg._distributed = true;

    const result = pass.apply(agg);
    expect(result.type).toBe(PlanNodeType.FINAL_AGGREGATE);
    expect(result.children[0].type).toBe(PlanNodeType.EXCHANGE);
    expect(result.children[0].children[0].type).toBe(PlanNodeType.PARTIAL_AGGREGATE);
  });

  it('decomposes COUNT into partial COUNT + final SUM', () => {
    const scan = LogicalScan('T', []);
    const agg = LogicalAggregate([colRef('STATUS')], [makeAgg('COUNT', [colRef('ID')])], scan);
    agg._distributed = true;

    const result = pass.apply(agg);
    expect(result.type).toBe(PlanNodeType.FINAL_AGGREGATE);
    expect(result.aggregates[0].func).toBe('SUM');

    const partial = result.children[0].children[0];
    expect(partial.aggregates[0].func).toBe('COUNT');
  });

  it('decomposes MIN and MAX preserving function', () => {
    const scan = LogicalScan('T', []);
    const aggs = [makeAgg('MIN', [colRef('PRICE')]), makeAgg('MAX', [colRef('PRICE')])];
    const aggNode = LogicalAggregate([colRef('CAT')], aggs, scan);
    aggNode._distributed = true;

    const result = pass.apply(aggNode);
    expect(result.aggregates[0].func).toBe('MIN');
    expect(result.aggregates[1].func).toBe('MAX');
  });

  it('decomposes AVG into SUM+COUNT partial and AVG_FINAL final', () => {
    const scan = LogicalScan('T', []);
    const agg = LogicalAggregate([colRef('G')], [makeAgg('AVG', [colRef('V')])], scan);
    agg._distributed = true;

    const result = pass.apply(agg);
    expect(result.aggregates[0].func).toBe('AVG_FINAL');

    const partial = result.children[0].children[0];
    expect(partial.aggregates[0].func).toBe('AVG_PARTIAL');
  });

  it('decomposes COUNT_STAR', () => {
    const scan = LogicalScan('T', []);
    const agg = LogicalAggregate([], [makeAgg('COUNT', [], { isCountStar: true })], scan);
    agg._distributed = true;

    const result = pass.apply(agg);
    expect(result.type).toBe(PlanNodeType.FINAL_AGGREGATE);
  });

  it('preserves non-decomposable aggregates', () => {
    const scan = LogicalScan('T', []);
    const agg = LogicalAggregate([colRef('G')], [makeAgg('GROUP_CONCAT', [colRef('V')])], scan);
    agg._distributed = true;

    const result = pass.apply(agg);
    expect(result.type).toBe(PlanNodeType.AGGREGATE);
  });

  it('uses exchange with HASH_SHUFFLE on group-by keys', () => {
    const scan = LogicalScan('T', []);
    const agg = LogicalAggregate([colRef('STATUS')], [makeAgg('SUM', [colRef('AMT')])], scan);
    agg._distributed = true;

    const result = pass.apply(agg);
    const exchange = result.children[0];
    expect(exchange.type).toBe(PlanNodeType.EXCHANGE);
    expect(exchange.exchangeType).toBe('hash_shuffle');
  });

  it('splits a GROUP BY that has no aggregate functions', () => {
    const scan = LogicalScan('T', []);
    const agg = LogicalAggregate([colRef('G')], [], scan);
    agg._distributed = true;

    const result = pass.apply(agg);
    expect(result.type).toBe(PlanNodeType.FINAL_AGGREGATE);
    const exchange = result.children[0];
    expect(exchange.type).toBe(PlanNodeType.EXCHANGE);
    expect(exchange.exchangeType).toBe('hash_shuffle');
    expect(exchange.children[0].type).toBe(PlanNodeType.PARTIAL_AGGREGATE);
  });

  it('leaves an aggregate with neither group keys nor aggregates alone', () => {
    const scan = LogicalScan('T', []);
    const agg = LogicalAggregate([], [], scan);
    agg._distributed = true;

    expect(pass.apply(agg).type).toBe(PlanNodeType.AGGREGATE);
  });

  it('DECOMPOSABLE_FUNCTIONS has correct mappings', () => {
    expect(DECOMPOSABLE_FUNCTIONS.get('SUM')).toEqual({ partial: 'SUM', final: 'SUM' });
    expect(DECOMPOSABLE_FUNCTIONS.get('COUNT')).toEqual({ partial: 'COUNT', final: 'SUM' });
    expect(DECOMPOSABLE_FUNCTIONS.get('MIN')).toEqual({ partial: 'MIN', final: 'MIN' });
    expect(DECOMPOSABLE_FUNCTIONS.get('MAX')).toEqual({ partial: 'MAX', final: 'MAX' });
    expect(DECOMPOSABLE_FUNCTIONS.get('AVG')).toEqual({ partial: 'AVG_PARTIAL', final: 'AVG_FINAL' });
  });
});
