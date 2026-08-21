import { describe, it, expect } from 'vitest';
import { runBufferedSerialJoin } from '../../../src/execution/builders/join-builder.js';
import { HashJoinBuild, HashJoinProbe } from '../../../src/execution/operators/hash-join.js';
import { SpillManager } from '../../../src/storage/spill-manager/spill-manager.js';
import { MemoryStorage } from '../../../src/storage/spill-manager/memory-storage.js';
import { JoinType } from '../../../src/planner/logical-plan.js';
import { isBuildSidePreserved } from '../../../src/planner/join-build-side.js';
import { chooseJoinBuildSide } from '../../../src/planner/join-build-side.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { DataType } from '../../../src/storage/data-type.js';

function intChunk(values) {
  const col = new Column(DataType.INT32, Math.max(values.length, 1));
  for (let i = 0; i < values.length; i++) col.set(i, values[i]);
  col.length = values.length;
  return new DataChunk([col], values.length);
}

const firstColumn = (chunk, row) => chunk.columns[0].get(row);

function joinPair(joinType, buildPreserved, buildValues, probeValues) {
  const makeBuild = () => new HashJoinBuild(
    [firstColumn], joinType, false, new SpillManager(new MemoryStorage()), buildPreserved, 0,
  );
  const makeProbe = (build) => new HashJoinProbe(build, [firstColumn], 1, 1, joinType, null);
  return runBufferedSerialJoin(makeBuild, makeProbe, [intChunk(buildValues)], [intChunk(probeValues)], buildPreserved, 1);
}

function rowsOf(chunks) {
  return chunks.flatMap(chunk => chunk.toRows());
}

describe('runBufferedSerialJoin', () => {
  it('emits no build-only rows for a LEFT join whose preserved side is the probe', async () => {
    const buildPreserved = isBuildSidePreserved(JoinType.LEFT, chooseJoinBuildSide(JoinType.LEFT, 100, 100) === 'left');
    const rows = rowsOf(await joinPair(JoinType.LEFT, buildPreserved, [2, 9], [1, 2, 3]));

    expect(rows.map(row => row[1]).sort()).toEqual([1, 2, 3]);
    expect(rows.every(row => row[1] !== null)).toBe(true);
  });

  it('emits unmatched build rows when the build side is the preserved side', async () => {
    const rows = rowsOf(await joinPair(JoinType.FULL, true, [2, 9], [1, 2, 3]));

    expect(rows).toContainEqual([9, null]);
    expect(rows).toContainEqual([null, 1]);
    expect(rows).toContainEqual([2, 2]);
    expect(rows.length).toBe(4);
  });

  it('emits only matches for an inner join', async () => {
    const rows = rowsOf(await joinPair(JoinType.INNER, false, [2, 9], [1, 2, 3]));

    expect(rows).toEqual([[2, 2]]);
  });
});

describe('isBuildSidePreserved', () => {
  it('preserves the build side of a FULL join regardless of which child it is', () => {
    expect(isBuildSidePreserved(JoinType.FULL, true)).toBe(true);
    expect(isBuildSidePreserved(JoinType.FULL, false)).toBe(true);
  });

  it('preserves the build side of a LEFT join only when it is the left child', () => {
    expect(isBuildSidePreserved(JoinType.LEFT, true)).toBe(true);
    expect(isBuildSidePreserved(JoinType.LEFT, false)).toBe(false);
  });

  it('agrees with the build side the planner actually picks for a LEFT join', () => {
    expect(chooseJoinBuildSide(JoinType.LEFT, 1, 1000000)).toBe('right');
    expect(isBuildSidePreserved(JoinType.LEFT, false)).toBe(false);
  });

  it('never preserves the build side of an inner or semi join', () => {
    expect(isBuildSidePreserved(JoinType.INNER, true)).toBe(false);
    expect(isBuildSidePreserved(JoinType.SEMI, false)).toBe(false);
  });
});
