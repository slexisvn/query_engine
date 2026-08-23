import type { AggregateDecomposition } from '../distributed/distributed-types.js';

export interface AggregateLike {
  name?: string;
  func?: string;
  distinct?: boolean;
  isCountStar?: boolean;
}

export const DECOMPOSABLE_FUNCTIONS = new Map<string, AggregateDecomposition>([
  ['SUM', { partial: 'SUM', final: 'SUM' }],
  ['COUNT', { partial: 'COUNT', final: 'SUM' }],
  ['COUNT_STAR', { partial: 'COUNT_STAR', final: 'SUM' }],
  ['MIN', { partial: 'MIN', final: 'MIN' }],
  ['MAX', { partial: 'MAX', final: 'MAX' }],
  ['AVG', { partial: 'AVG_PARTIAL', final: 'AVG_FINAL' }],
]);

const MULTI_COLUMN_PARTIALS: ReadonlySet<string> = new Set(['AVG']);

export const SINGLE_COLUMN_PARTIAL_FUNCTIONS: ReadonlySet<string> =
  new Set([...DECOMPOSABLE_FUNCTIONS.keys()].filter(name => !MULTI_COLUMN_PARTIALS.has(name)));

export function aggregateFunctionName(agg: AggregateLike): string {
  if (agg.isCountStar) return 'COUNT_STAR';
  return (agg.name ?? agg.func ?? '').toUpperCase();
}

export function decompositionOf(agg: AggregateLike): AggregateDecomposition | undefined {
  return DECOMPOSABLE_FUNCTIONS.get(aggregateFunctionName(agg));
}
