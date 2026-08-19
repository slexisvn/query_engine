import { describe, it, expect } from 'vitest';
import {
  encodePartialGroup,
  decodePartialGroup,
  partialGroupsToChunk,
  chunkToPartialGroups,
} from '../../../src/execution/operators/aggregate-state-codec.js';

function roundTrip(record) {
  return decodePartialGroup(encodePartialGroup(record));
}

describe('partial group encoding', () => {
  it('round-trips numeric group values', () => {
    expect(roundTrip({ groupValues: [1, 2.5], states: [] })).toEqual({ groupValues: [1, 2.5], states: [] });
  });

  it('round-trips string group values', () => {
    expect(roundTrip({ groupValues: ['a', 'b'], states: [] }).groupValues).toEqual(['a', 'b']);
  });

  it('round-trips null group values', () => {
    expect(roundTrip({ groupValues: [null], states: [] }).groupValues).toEqual([null]);
  });

  it('round-trips boolean group values', () => {
    expect(roundTrip({ groupValues: [true, false], states: [] }).groupValues).toEqual([true, false]);
  });

  it('round-trips a scalar accumulator state', () => {
    expect(roundTrip({ groupValues: ['k'], states: [42] }).states).toEqual([42]);
  });

  it('round-trips an average accumulator state', () => {
    expect(roundTrip({ groupValues: ['k'], states: [{ sum: 10, count: 4 }] }).states)
      .toEqual([{ sum: 10, count: 4 }]);
  });

  it('round-trips a distinct-value accumulator state', () => {
    expect(roundTrip({ groupValues: ['k'], states: [[1, 2, 3]] }).states).toEqual([[1, 2, 3]]);
  });

  it('round-trips a null accumulator state', () => {
    expect(roundTrip({ groupValues: ['k'], states: [null] }).states).toEqual([null]);
  });

  it('round-trips mixed states across several aggregates', () => {
    const record = { groupValues: ['k'], states: [7, { sum: 1, count: 1 }, ['x'], null] };
    expect(roundTrip(record)).toEqual(record);
  });

  it('preserves bigint group values exactly', () => {
    const value = BigInt('9007199254740993');
    expect(roundTrip({ groupValues: [value], states: [] }).groupValues[0]).toBe(value);
  });

  it('preserves bigint values nested inside an accumulator state', () => {
    const value = BigInt('9007199254740994');
    expect(roundTrip({ groupValues: ['k'], states: [[value]] }).states[0][0]).toBe(value);
  });

  it('keeps bigints distinct when they differ beyond double precision', () => {
    const low = encodePartialGroup({ groupValues: [BigInt('9007199254740993')], states: [] });
    const high = encodePartialGroup({ groupValues: [BigInt('9007199254740994')], states: [] });

    expect(low).not.toBe(high);
  });
});

describe('partial group chunk transport', () => {
  it('carries an empty record set', () => {
    expect(chunkToPartialGroups(partialGroupsToChunk([]))).toEqual([]);
  });

  it('reports the record count as the chunk size', () => {
    const records = [{ groupValues: ['a'], states: [1] }, { groupValues: ['b'], states: [2] }];
    expect(partialGroupsToChunk(records).size).toBe(2);
  });

  it('round-trips a single record through a chunk', () => {
    const records = [{ groupValues: ['a'], states: [{ sum: 3, count: 2 }] }];
    expect(chunkToPartialGroups(partialGroupsToChunk(records))).toEqual(records);
  });

  it('round-trips many records preserving order', () => {
    const records = Array.from({ length: 50 }, (_, i) => ({ groupValues: [`g${i}`], states: [i] }));
    expect(chunkToPartialGroups(partialGroupsToChunk(records))).toEqual(records);
  });

  it('round-trips records whose group values are heterogeneous', () => {
    const records = [
      { groupValues: [1, 'a', null], states: [1] },
      { groupValues: [2, 'b', true], states: [2] },
    ];
    expect(chunkToPartialGroups(partialGroupsToChunk(records))).toEqual(records);
  });

  it('produces a single-column chunk', () => {
    expect(partialGroupsToChunk([{ groupValues: ['a'], states: [] }]).columns).toHaveLength(1);
  });
});
