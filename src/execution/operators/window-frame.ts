import type { BoundFrameBound, BoundWindowFrame, FrameMode } from '../../binder/expression-binder.js';
import { toNumericValue } from '../../storage/data-type.js';
import type { ColumnValue } from '../../storage/data-type.js';
import type { EvalValue } from '../execution-types.js';

export interface FrameRanges {
  starts: Int32Array;
  ends: Int32Array;
}

export interface PeerGroups {
  first: Int32Array;
  last: Int32Array;
}

export interface FrameInput {
  length: number;
  peers: PeerGroups;
  orderValues: readonly EvalValue[] | null;
  ascending: boolean;
}

interface GroupIndex {
  of: Int32Array;
  first: Int32Array;
  last: Int32Array;
  count: number;
}

interface RangeIndex {
  values: Float64Array;
  lo: number;
  hi: number;
  ascending: boolean;
}

const EMPTY_BEFORE = -1;

function groupIndexOf(peers: PeerGroups, length: number): GroupIndex {
  const of = new Int32Array(length);
  const first = new Int32Array(length);
  const last = new Int32Array(length);
  let count = 0;

  for (let i = 0; i < length; i++) {
    if (peers.first[i] === i) {
      first[count] = i;
      last[count] = peers.last[i];
      count++;
    }
    of[i] = count - 1;
  }

  return { of, first, last, count };
}

function rangeIndexOf(input: FrameInput): RangeIndex {
  const { orderValues, length, ascending } = input;
  if (!orderValues) {
    throw new Error('RANGE frames with value offsets require exactly one ORDER BY column');
  }

  const values = new Float64Array(length);
  let lo = length;
  let hi = EMPTY_BEFORE;

  for (let i = 0; i < length; i++) {
    const numeric = toNumericValue(orderValues[i] as ColumnValue);
    if (numeric === null) {
      values[i] = NaN;
      continue;
    }
    values[i] = numeric;
    if (i < lo) lo = i;
    hi = i;
  }

  if (hi === EMPTY_BEFORE) return { values, lo: 0, hi: EMPTY_BEFORE, ascending };
  return { values, lo, hi, ascending };
}

function lowerBound(index: RangeIndex, holds: (value: number) => boolean): number {
  let low = index.lo;
  let high = index.hi + 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (holds(index.values[mid])) high = mid;
    else low = mid + 1;
  }
  return low;
}

function upperBound(index: RangeIndex, holds: (value: number) => boolean): number {
  let low = index.lo - 1;
  let high = index.hi;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (holds(index.values[mid])) low = mid;
    else high = mid - 1;
  }
  return low;
}

function rangeBound(index: RangeIndex, peers: PeerGroups, row: number, offset: number, preceding: boolean, isStart: boolean): number {
  const current = index.values[row];
  if (Number.isNaN(current)) return isStart ? peers.first[row] : peers.last[row];

  const signed = index.ascending === preceding ? -offset : offset;
  const boundValue = current + signed;

  if (isStart) {
    return index.ascending
      ? lowerBound(index, (value) => value >= boundValue)
      : lowerBound(index, (value) => value <= boundValue);
  }
  return index.ascending
    ? upperBound(index, (value) => value <= boundValue)
    : upperBound(index, (value) => value >= boundValue);
}

function groupBound(groups: GroupIndex, row: number, offset: number, preceding: boolean, isStart: boolean): number {
  const target = groups.of[row] + (preceding ? -offset : offset);
  if (target < 0) return isStart ? 0 : EMPTY_BEFORE;
  const lastGroup = groups.count - 1;
  if (target > lastGroup) return groups.last[lastGroup] + (isStart ? 1 : 0);
  return isStart ? groups.first[target] : groups.last[target];
}

export const DEFAULT_FRAME: BoundWindowFrame = {
  mode: 'RANGE',
  start: { type: 'UNBOUNDED_PRECEDING', offset: null },
  end: { type: 'CURRENT_ROW', offset: null },
};

export function peerGroupsOf(length: number, samePeer: (a: number, b: number) => boolean): PeerGroups {
  const first = new Int32Array(length);
  const last = new Int32Array(length);
  let groupStart = 0;
  for (let i = 1; i <= length; i++) {
    if (i < length && samePeer(i, i - 1)) continue;
    for (let j = groupStart; j < i; j++) {
      first[j] = groupStart;
      last[j] = i - 1;
    }
    groupStart = i;
  }
  return { first, last };
}

interface FrameScope {
  mode: FrameMode;
  peers: PeerGroups;
  groups: GroupIndex | null;
  range: RangeIndex | null;
}

function offsetBound(scope: FrameScope, bound: BoundFrameBound, index: number, preceding: boolean, isStart: boolean): number {
  const offset = bound.offset!;
  if (scope.mode === 'ROWS') return index + (preceding ? -offset : offset);
  if (scope.mode === 'GROUPS') return groupBound(scope.groups!, index, offset, preceding, isStart);
  return rangeBound(scope.range!, scope.peers, index, offset, preceding, isStart);
}

function boundIndex(scope: FrameScope, bound: BoundFrameBound, index: number, length: number, isStart: boolean): number {
  switch (bound.type) {
    case 'UNBOUNDED_PRECEDING':
      return 0;
    case 'UNBOUNDED_FOLLOWING':
      return length - 1;
    case 'CURRENT_ROW':
      if (scope.mode === 'ROWS') return index;
      return isStart ? scope.peers.first[index] : scope.peers.last[index];
    case 'PRECEDING':
      return offsetBound(scope, bound, index, true, isStart);
    case 'FOLLOWING':
      return offsetBound(scope, bound, index, false, isStart);
  }
}

function usesOffset(frame: BoundWindowFrame): boolean {
  return frame.start.offset !== null || frame.end.offset !== null;
}

export function frameNeedsOrderValues(frame: BoundWindowFrame): boolean {
  return frame.mode === 'RANGE' && usesOffset(frame);
}

function frameScopeOf(frame: BoundWindowFrame, input: FrameInput): FrameScope {
  const needsOffset = usesOffset(frame);
  return {
    mode: frame.mode,
    peers: input.peers,
    groups: frame.mode === 'GROUPS' ? groupIndexOf(input.peers, input.length) : null,
    range: frame.mode === 'RANGE' && needsOffset ? rangeIndexOf(input) : null,
  };
}

export function frameRangesOf(frame: BoundWindowFrame, input: FrameInput): FrameRanges {
  const { length } = input;
  const starts = new Int32Array(length);
  const ends = new Int32Array(length);
  if (length === 0) return { starts, ends };

  const scope = frameScopeOf(frame, input);
  for (let i = 0; i < length; i++) {
    starts[i] = Math.max(0, boundIndex(scope, frame.start, i, length, true));
    ends[i] = Math.min(length - 1, boundIndex(scope, frame.end, i, length, false));
  }
  return { starts, ends };
}

interface PrefixSums {
  sums: Float64Array;
  counts: Int32Array;
}

function prefixSumsOf(values: EvalValue[]): PrefixSums {
  const sums = new Float64Array(values.length + 1);
  const counts = new Int32Array(values.length + 1);
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const present = value !== null && value !== undefined;
    sums[i + 1] = sums[i] + (present ? Number(value) : 0);
    counts[i + 1] = counts[i] + (present ? 1 : 0);
  }
  return { sums, counts };
}

function slidingExtreme(values: EvalValue[], ranges: FrameRanges, keepLeft: (candidate: EvalValue, incoming: EvalValue) => boolean): EvalValue[] {
  const length = values.length;
  const result: EvalValue[] = new Array(length);
  const deque: number[] = [];
  let head = 0;
  let filled = 0;

  for (let i = 0; i < length; i++) {
    const end = ranges.ends[i];
    while (filled <= end) {
      const value = values[filled];
      if (value !== null && value !== undefined) {
        while (deque.length > head && !keepLeft(values[deque[deque.length - 1]], value)) deque.pop();
        deque.push(filled);
      }
      filled++;
    }
    while (deque.length > head && deque[head] < ranges.starts[i]) head++;
    result[i] = ranges.starts[i] > end || deque.length === head ? null : values[deque[head]];
  }

  return result;
}

export type FrameAggregator = (values: EvalValue[], ranges: FrameRanges) => EvalValue[];

function emptyFrame(ranges: FrameRanges, index: number): boolean {
  return ranges.starts[index] > ranges.ends[index];
}

export const FRAME_AGGREGATORS: ReadonlyMap<string, FrameAggregator> = new Map<string, FrameAggregator>([
  ['SUM', (values, ranges) => {
    const prefix = prefixSumsOf(values);
    return values.map((_value, i) => {
      if (emptyFrame(ranges, i)) return null;
      const count = prefix.counts[ranges.ends[i] + 1] - prefix.counts[ranges.starts[i]];
      return count === 0 ? null : prefix.sums[ranges.ends[i] + 1] - prefix.sums[ranges.starts[i]];
    });
  }],
  ['AVG', (values, ranges) => {
    const prefix = prefixSumsOf(values);
    return values.map((_value, i) => {
      if (emptyFrame(ranges, i)) return null;
      const count = prefix.counts[ranges.ends[i] + 1] - prefix.counts[ranges.starts[i]];
      return count === 0 ? null : (prefix.sums[ranges.ends[i] + 1] - prefix.sums[ranges.starts[i]]) / count;
    });
  }],
  ['COUNT', (values, ranges) => {
    const prefix = prefixSumsOf(values);
    return values.map((_value, i) =>
      emptyFrame(ranges, i) ? 0 : prefix.counts[ranges.ends[i] + 1] - prefix.counts[ranges.starts[i]]);
  }],
  ['COUNT_STAR', (values, ranges) =>
    values.map((_value, i) => (emptyFrame(ranges, i) ? 0 : ranges.ends[i] - ranges.starts[i] + 1))],
  ['MIN', (values, ranges) => slidingExtreme(values, ranges, (candidate, incoming) => (candidate as number) <= (incoming as number))],
  ['MAX', (values, ranges) => slidingExtreme(values, ranges, (candidate, incoming) => (candidate as number) >= (incoming as number))],
]);
