import { describe, it, expect } from 'vitest';
import { DefaultCostModel, SortKeyClass } from '../../src/planner/cost-model.js';
import { CostRecorder, childIndexesOf, topLevelIndexes } from '../../src/planner/cost-recorder.js';

const BUILD_ROWS = 1_000;
const PROBE_ROWS = 50_000;
const OUTPUT_ROWS = 60_000;
const SORT_ROWS = 10_000;

function record(run) {
  const model = new DefaultCostModel();
  const recorder = new CostRecorder(model);
  const terms = recorder.collect(proxy => run(proxy, model));
  return { model, terms };
}

describe('recording what the cost model was asked', () => {
  it('captures the call, its arguments and its result', () => {
    const { model, terms } = record(proxy => proxy.hashProbeCost(PROBE_ROWS));

    expect(terms).toHaveLength(1);
    expect(terms[0].method).toBe('hashProbeCost');
    expect(terms[0].args).toEqual([PROBE_ROWS]);
    expect(terms[0].value).toBe(model.hashProbeCost(PROBE_ROWS));
  });

  it('returns the same number the unwrapped model returns', () => {
    const { model, terms } = record(proxy => proxy.hashJoinCost(BUILD_ROWS, PROBE_ROWS, OUTPUT_ROWS));

    expect(terms[0].value).toBe(model.hashJoinCost(BUILD_ROWS, PROBE_ROWS, OUTPUT_ROWS));
  });

  it('nests the primitives a composite cost is built from', () => {
    const { terms } = record(proxy => proxy.hashJoinCost(BUILD_ROWS, PROBE_ROWS, OUTPUT_ROWS));
    const nested = childIndexesOf(terms, 0).map(index => terms[index].method);

    expect(terms[0].depth).toBe(0);
    expect(nested).toEqual(['hashBuildCost', 'hashProbeCost', 'joinOutputCost', 'spillPenalty']);
  });

  it('adds up the nested primitives to the composite it recorded', () => {
    const { terms } = record(proxy => proxy.hashJoinCost(BUILD_ROWS, PROBE_ROWS, OUTPUT_ROWS));
    const nested = childIndexesOf(terms, 0).reduce((total, index) => total + terms[index].value, 0);

    expect(nested).toBeCloseTo(terms[0].value);
  });

  it('keeps sibling calls at the top level', () => {
    const { terms } = record(proxy => {
      proxy.scanCost(SORT_ROWS);
      proxy.filterCost(SORT_ROWS);
    });

    expect(topLevelIndexes(terms)).toEqual([0, 1]);
  });

  it('passes non-numeric arguments through untouched', () => {
    const { terms } = record(proxy => proxy.sortCost(SORT_ROWS, SortKeyClass.TEXT));

    expect(terms[0].args).toEqual([SORT_ROWS, SortKeyClass.TEXT]);
  });

  it('starts a fresh transcript for every collection', () => {
    const model = new DefaultCostModel();
    const recorder = new CostRecorder(model);

    recorder.collect(proxy => proxy.scanCost(SORT_ROWS));
    const second = recorder.collect(proxy => proxy.filterCost(SORT_ROWS));

    expect(second.map(term => term.method)).toEqual(['filterCost']);
  });

  it('unwinds the depth when a call throws', () => {
    const model = new DefaultCostModel();
    const recorder = new CostRecorder(model);

    expect(() => recorder.collect(() => { throw new Error('boom'); })).toThrow('boom');

    const after = recorder.collect(proxy => proxy.scanCost(SORT_ROWS));
    expect(after[0].depth).toBe(0);
  });

  it('leaves plain numeric fields readable through the proxy', () => {
    const model = new DefaultCostModel();
    const recorder = new CostRecorder(model);

    expect(recorder.model.C_TUPLE).toBe(model.C_TUPLE);
    expect(recorder.model.SPILL_THRESHOLD).toBe(model.SPILL_THRESHOLD);
  });
});

describe('walking a recorded transcript', () => {
  it('stops descending at the next sibling', () => {
    const { terms } = record(proxy => {
      proxy.hashJoinCost(BUILD_ROWS, PROBE_ROWS, OUTPUT_ROWS);
      proxy.scanCost(SORT_ROWS);
    });
    const tops = topLevelIndexes(terms);

    expect(tops).toHaveLength(2);
    expect(childIndexesOf(terms, tops[1])).toEqual([]);
  });

  it('reports only direct children, not grandchildren', () => {
    const { terms } = record(proxy => proxy.sortMergeJoinCost(BUILD_ROWS, PROBE_ROWS, OUTPUT_ROWS));
    const children = childIndexesOf(terms, 0);

    expect(children.every(index => terms[index].depth === 1)).toBe(true);
    expect(terms.some(term => term.depth > 1)).toBe(true);
  });
});
