import { describe, it, expect } from 'vitest';
import { SetOperator, setOpPolicy } from '../../../src/execution/operators/set-op.js';
import { SetOpType } from '../../../src/planner/logical-plan.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { Column } from '../../../src/storage/column.js';
import { DataType } from '../../../src/storage/data-type.js';

function chunkOf(values) {
  const column = new Column(DataType.INT32, Math.max(1, values.length));
  values.forEach((value, index) => column.set(index, value));
  column.length = values.length;
  return new DataChunk([column], values.length);
}

function rowsOf(chunk) {
  const out = [];
  for (let i = 0; i < chunk.size; i++) out.push(chunk.columns[0].get(chunk.activeRowIndex(i)));
  return out;
}

function run(op, all, left, right) {
  const operator = new SetOperator(op, all);
  operator.consumeRight(chunkOf(right));
  return rowsOf(operator.filterLeft(chunkOf(left)));
}

describe('setOpPolicy', () => {
  it('rejects an operation it has no policy for', () => {
    expect(() => setOpPolicy(SetOpType.UNION, false)).toThrow(/No set operation policy/);
  });

  it('consumes right-side multiplicity only for the ALL variants', () => {
    expect(setOpPolicy(SetOpType.EXCEPT, true).consumesRight).toBe(true);
    expect(setOpPolicy(SetOpType.EXCEPT, false).consumesRight).toBe(false);
  });
});

describe('SetOperator EXCEPT', () => {
  it('drops values present on the right', () => {
    expect(run(SetOpType.EXCEPT, false, [1, 2, 3], [2])).toEqual([1, 3]);
  });

  it('emits each surviving value once', () => {
    expect(run(SetOpType.EXCEPT, false, [1, 1, 2], [2])).toEqual([1]);
  });

  it('subtracts multiplicities for EXCEPT ALL', () => {
    expect(run(SetOpType.EXCEPT, true, [1, 1, 1, 2], [1, 2])).toEqual([1, 1]);
  });

  it('never emits below zero for EXCEPT ALL', () => {
    expect(run(SetOpType.EXCEPT, true, [1], [1, 1, 1])).toEqual([]);
  });

  it('treats null as a matchable value', () => {
    expect(run(SetOpType.EXCEPT, false, [null, 1], [null])).toEqual([1]);
  });
});

describe('SetOperator INTERSECT', () => {
  it('keeps only shared values', () => {
    expect(run(SetOpType.INTERSECT, false, [1, 2, 3], [2, 3, 4])).toEqual([2, 3]);
  });

  it('emits each shared value once for INTERSECT DISTINCT', () => {
    expect(run(SetOpType.INTERSECT, false, [2, 2, 2], [2])).toEqual([2]);
  });

  it('emits the smaller multiplicity for INTERSECT ALL', () => {
    expect(run(SetOpType.INTERSECT, true, [2, 2, 2], [2, 2])).toEqual([2, 2]);
  });

  it('returns nothing when the right side is empty', () => {
    expect(run(SetOpType.INTERSECT, true, [1, 2], [])).toEqual([]);
  });
});

describe('SetOperator streaming', () => {
  it('carries multiplicity accounting across left chunks', () => {
    const operator = new SetOperator(SetOpType.EXCEPT, true);
    operator.consumeRight(chunkOf([1, 1]));
    const first = rowsOf(operator.filterLeft(chunkOf([1])));
    const second = rowsOf(operator.filterLeft(chunkOf([1, 1])));
    expect(first).toEqual([]);
    expect(second).toEqual([1]);
  });

  it('accumulates right side counts across chunks', () => {
    const operator = new SetOperator(SetOpType.INTERSECT, true);
    operator.consumeRight(chunkOf([5]));
    operator.consumeRight(chunkOf([5]));
    expect(rowsOf(operator.filterLeft(chunkOf([5, 5, 5])))).toEqual([5, 5]);
  });

  it('suppresses repeats across left chunks for the DISTINCT variants', () => {
    const operator = new SetOperator(SetOpType.INTERSECT, false);
    operator.consumeRight(chunkOf([7]));
    expect(rowsOf(operator.filterLeft(chunkOf([7])))).toEqual([7]);
    expect(rowsOf(operator.filterLeft(chunkOf([7])))).toEqual([]);
  });
});
