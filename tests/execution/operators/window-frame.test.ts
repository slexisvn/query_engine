import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FRAME,
  FRAME_AGGREGATORS,
  frameRangesOf,
  peerGroupsOf,
} from '../../../src/execution/operators/window-frame.js';

function rows(mode, start, end, length, samePeer = () => false) {
  const peers = peerGroupsOf(length, samePeer);
  const ranges = frameRangesOf({ mode, start, end }, length, peers);
  return Array.from({ length }, (_, i) => [ranges.starts[i], ranges.ends[i]]);
}

const unboundedPreceding = { type: 'UNBOUNDED_PRECEDING', offset: null };
const unboundedFollowing = { type: 'UNBOUNDED_FOLLOWING', offset: null };
const currentRow = { type: 'CURRENT_ROW', offset: null };
const onePreceding = { type: 'PRECEDING', offset: 1 };
const oneFollowing = { type: 'FOLLOWING', offset: 1 };

describe('peerGroupsOf', () => {
  it('treats every row as its own peer group when nothing matches', () => {
    const peers = peerGroupsOf(3, () => false);
    expect(Array.from(peers.first)).toEqual([0, 1, 2]);
    expect(Array.from(peers.last)).toEqual([0, 1, 2]);
  });

  it('groups adjacent peers together', () => {
    const values = ['a', 'a', 'b'];
    const peers = peerGroupsOf(3, (x, y) => values[x] === values[y]);
    expect(Array.from(peers.first)).toEqual([0, 0, 2]);
    expect(Array.from(peers.last)).toEqual([1, 1, 2]);
  });

  it('handles an empty partition', () => {
    const peers = peerGroupsOf(0, () => true);
    expect(peers.first).toHaveLength(0);
  });
});

describe('frameRangesOf', () => {
  it('expands UNBOUNDED PRECEDING to the partition start', () => {
    expect(rows('ROWS', unboundedPreceding, currentRow, 3)).toEqual([[0, 0], [0, 1], [0, 2]]);
  });

  it('expands UNBOUNDED FOLLOWING to the partition end', () => {
    expect(rows('ROWS', currentRow, unboundedFollowing, 3)).toEqual([[0, 2], [1, 2], [2, 2]]);
  });

  it('clamps a sliding ROWS frame to the partition', () => {
    expect(rows('ROWS', onePreceding, oneFollowing, 3)).toEqual([[0, 1], [0, 2], [1, 2]]);
  });

  it('extends CURRENT ROW over peers in RANGE mode', () => {
    const values = ['a', 'a', 'b'];
    expect(rows('RANGE', unboundedPreceding, currentRow, 3, (x, y) => values[x] === values[y]))
      .toEqual([[0, 1], [0, 1], [0, 2]]);
  });

  it('rejects RANGE offsets', () => {
    expect(() => rows('RANGE', onePreceding, currentRow, 3)).toThrow(/RANGE frames/);
    expect(() => rows('RANGE', currentRow, oneFollowing, 3)).toThrow(/RANGE frames/);
  });

  it('describes the SQL default frame', () => {
    expect(DEFAULT_FRAME.mode).toBe('RANGE');
    expect(DEFAULT_FRAME.start.type).toBe('UNBOUNDED_PRECEDING');
    expect(DEFAULT_FRAME.end.type).toBe('CURRENT_ROW');
  });
});

describe('FRAME_AGGREGATORS', () => {
  const ranges = (pairs) => ({
    starts: Int32Array.from(pairs.map(([start]) => start)),
    ends: Int32Array.from(pairs.map(([, end]) => end)),
  });

  it('sums a sliding frame', () => {
    const values = [1, 2, 3];
    expect(FRAME_AGGREGATORS.get('SUM')(values, ranges([[0, 1], [0, 2], [1, 2]]))).toEqual([3, 6, 5]);
  });

  it('skips nulls when summing', () => {
    const values = [1, null, 3];
    expect(FRAME_AGGREGATORS.get('SUM')(values, ranges([[0, 2], [0, 2], [0, 2]]))).toEqual([4, 4, 4]);
  });

  it('returns null for a frame with only nulls', () => {
    expect(FRAME_AGGREGATORS.get('SUM')([null], ranges([[0, 0]]))).toEqual([null]);
  });

  it('averages over non-null values in the frame', () => {
    expect(FRAME_AGGREGATORS.get('AVG')([1, null, 3], ranges([[0, 2], [0, 2], [0, 2]]))).toEqual([2, 2, 2]);
  });

  it('counts non-null values in the frame', () => {
    expect(FRAME_AGGREGATORS.get('COUNT')([1, null, 3], ranges([[0, 1], [0, 2], [2, 2]]))).toEqual([1, 2, 1]);
  });

  it('counts every row for COUNT_STAR', () => {
    expect(FRAME_AGGREGATORS.get('COUNT_STAR')([1, null, 3], ranges([[0, 1], [0, 2], [2, 2]]))).toEqual([2, 3, 1]);
  });

  it('slides MIN across a moving window', () => {
    expect(FRAME_AGGREGATORS.get('MIN')([3, 1, 2], ranges([[0, 1], [1, 2], [2, 2]]))).toEqual([1, 1, 2]);
  });

  it('slides MAX across a moving window', () => {
    expect(FRAME_AGGREGATORS.get('MAX')([3, 1, 2], ranges([[0, 1], [1, 2], [2, 2]]))).toEqual([3, 2, 2]);
  });

  it('ignores nulls in MIN', () => {
    expect(FRAME_AGGREGATORS.get('MIN')([null, 5, null], ranges([[0, 2], [0, 2], [0, 2]]))).toEqual([5, 5, 5]);
  });

  it('returns null for an empty frame and zero for counts', () => {
    const empty = ranges([[1, 0]]);
    expect(FRAME_AGGREGATORS.get('SUM')([1], empty)).toEqual([null]);
    expect(FRAME_AGGREGATORS.get('MIN')([1], empty)).toEqual([null]);
    expect(FRAME_AGGREGATORS.get('COUNT')([1], empty)).toEqual([0]);
    expect(FRAME_AGGREGATORS.get('COUNT_STAR')([1], empty)).toEqual([0]);
  });
});
