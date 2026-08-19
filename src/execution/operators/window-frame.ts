import type { BoundFrameBound, BoundWindowFrame } from '../../binder/expression-binder.js';
import type { EvalValue } from '../execution-types.js';

export interface FrameRanges {
  starts: Int32Array;
  ends: Int32Array;
}

export interface PeerGroups {
  first: Int32Array;
  last: Int32Array;
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

function boundIndex(bound: BoundFrameBound, index: number, length: number, mode: string, peers: PeerGroups, isStart: boolean): number {
  switch (bound.type) {
    case 'UNBOUNDED_PRECEDING':
      return 0;
    case 'UNBOUNDED_FOLLOWING':
      return length - 1;
    case 'CURRENT_ROW':
      if (mode === 'ROWS') return index;
      return isStart ? peers.first[index] : peers.last[index];
    case 'PRECEDING':
      if (mode !== 'ROWS') throw new Error('RANGE frames with PRECEDING offsets are not supported');
      return index - bound.offset!;
    case 'FOLLOWING':
      if (mode !== 'ROWS') throw new Error('RANGE frames with FOLLOWING offsets are not supported');
      return index + bound.offset!;
  }
}

export function frameRangesOf(frame: BoundWindowFrame, length: number, peers: PeerGroups): FrameRanges {
  const starts = new Int32Array(length);
  const ends = new Int32Array(length);
  for (let i = 0; i < length; i++) {
    starts[i] = Math.max(0, boundIndex(frame.start, i, length, frame.mode, peers, true));
    ends[i] = Math.min(length - 1, boundIndex(frame.end, i, length, frame.mode, peers, false));
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
