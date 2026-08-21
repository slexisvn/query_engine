import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HashJoinBuild, HashJoinProbe } from '../../../src/execution/operators/hash-join.js';
import { SpillManager } from '../../../src/storage/spill-manager/spill-manager.js';
import { MemoryStorage } from '../../../src/storage/spill-manager/memory-storage.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { JoinType } from '../../../src/planner/logical-plan.js';
import { Config } from '../../../src/config.js';
import { captureMemoryLimit, limitResidentRows } from '../../helpers/memory-limits.js';
import { DataType } from '../../../src/storage/data-type.js';

function makeChunk(colDefs) {
  const size = colDefs[0].values.length;
  const cols = colDefs.map(({ type, values }) => {
    const col = new Column(type, values.length);
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return col;
  });
  return new DataChunk(cols, size);
}

function memSpill() {
  return new SpillManager(new MemoryStorage());
}

function keyAt(colIdx) {
  return (chunk, row) => chunk.columns[colIdx].get(row);
}

async function runJoin(buildChunks, probeChunks, joinType, buildKeyIdx = 0, probeKeyIdx = 0, opts = {}) {
  const build = new HashJoinBuild(
    [keyAt(buildKeyIdx)],
    joinType,
    opts.uniqueKeys || false,
    memSpill()
  );
  for (const c of buildChunks) await build.consume(c);
  await build.finalize();

  const buildColCount = buildChunks[0].columns.length;
  const probeColCount = probeChunks[0].columns.length;
  const probe = new HashJoinProbe(build, [keyAt(probeKeyIdx)], buildColCount, probeColCount, joinType, opts.condition || null);

  const results = [];
  for (const c of probeChunks) {
    const r = await probe.process(c);
    if (r && r.size > 0) results.push(r);
  }
  return results.flatMap(c => c.toRows());
}

describe('HashJoinBuild + HashJoinProbe', () => {
  describe('INNER JOIN', () => {
    it('joins matching rows from both sides', async () => {
      const build = makeChunk([
        { type: 'INT32', values: [1, 2, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ]);
      const probe = makeChunk([
        { type: 'INT32', values: [2, 3, 4] },
        { type: 'VARCHAR', values: ['x', 'y', 'z'] },
      ]);

      const rows = await runJoin([build], [probe], JoinType.INNER);

      expect(rows.length).toBe(2);
      const keys = rows.map(r => r[0]);
      expect(keys).toContain(2);
      expect(keys).toContain(3);
    });

    it('returns empty when no keys match', async () => {
      const build = makeChunk([{ type: 'INT32', values: [1, 2] }]);
      const probe = makeChunk([{ type: 'INT32', values: [3, 4] }]);

      const rows = await runJoin([build], [probe], JoinType.INNER);

      expect(rows.length).toBe(0);
    });

    it('produces cartesian product for duplicate keys', async () => {
      const build = makeChunk([
        { type: 'INT32', values: [1, 1] },
        { type: 'VARCHAR', values: ['a', 'b'] },
      ]);
      const probe = makeChunk([
        { type: 'INT32', values: [1, 1] },
        { type: 'VARCHAR', values: ['x', 'y'] },
      ]);

      const rows = await runJoin([build], [probe], JoinType.INNER);

      expect(rows.length).toBe(4);
    });
  });

  describe('LEFT JOIN', () => {
    it('keeps unmatched probe rows with null build columns', async () => {
      const build = makeChunk([
        { type: 'INT32', values: [1] },
        { type: 'VARCHAR', values: ['a'] },
      ]);
      const probe = makeChunk([
        { type: 'INT32', values: [1, 2] },
        { type: 'VARCHAR', values: ['x', 'y'] },
      ]);

      const rows = await runJoin([build], [probe], JoinType.LEFT);

      expect(rows.length).toBe(2);
      const unmatchedRow = rows.find(r => r[3] === 'y');
      expect(unmatchedRow[0]).toBeNull();
      expect(unmatchedRow[1]).toBeNull();
    });
  });

  describe('SEMI JOIN', () => {
    it('returns only probe rows that have a match', async () => {
      const build = makeChunk([{ type: 'INT32', values: [1, 3] }]);
      const probe = makeChunk([
        { type: 'INT32', values: [1, 2, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ]);

      const rows = await runJoin([build], [probe], JoinType.SEMI);

      expect(rows.length).toBe(2);
      const vals = rows.map(r => r[1]);
      expect(vals).toContain('a');
      expect(vals).toContain('c');
    });

    it('does not duplicate probe rows for duplicate build keys', async () => {
      const build = makeChunk([{ type: 'INT32', values: [1, 1, 1] }]);
      const probe = makeChunk([{ type: 'INT32', values: [1] }]);

      const rows = await runJoin([build], [probe], JoinType.SEMI);

      expect(rows.length).toBe(1);
    });
  });

  describe('ANTI JOIN', () => {
    it('returns only probe rows that have no match', async () => {
      const build = makeChunk([{ type: 'INT32', values: [1, 3] }]);
      const probe = makeChunk([
        { type: 'INT32', values: [1, 2, 3, 4] },
        { type: 'VARCHAR', values: ['a', 'b', 'c', 'd'] },
      ]);

      const rows = await runJoin([build], [probe], JoinType.ANTI);

      expect(rows.length).toBe(2);
      const vals = rows.map(r => r[1]);
      expect(vals).toContain('b');
      expect(vals).toContain('d');
    });
  });

  describe('MARK JOIN', () => {
    it('appends true for matched rows, false for unmatched', async () => {
      const build = makeChunk([{ type: 'INT32', values: [1, 3] }]);
      const probe = makeChunk([{ type: 'INT32', values: [1, 2, 3] }]);

      const rows = await runJoin([build], [probe], JoinType.MARK);

      expect(rows.length).toBe(3);
      const marks = new Map(rows.map(r => [r[0], r[1]]));
      expect(marks.get(1)).toBe(true);
      expect(marks.get(2)).toBe(false);
      expect(marks.get(3)).toBe(true);
    });

    it('appends null when build side has null keys', async () => {
      const build = makeChunk([{ type: 'INT32', values: [1, null] }]);
      const probe = makeChunk([{ type: 'INT32', values: [2] }]);

      const rows = await runJoin([build], [probe], JoinType.MARK);

      expect(rows[0][1]).toBeNull();
    });
  });

  describe('null key handling', () => {
    it('skips build rows with null keys', async () => {
      const build = makeChunk([
        { type: 'INT32', values: [1, null, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ]);
      const probe = makeChunk([{ type: 'INT32', values: [1, 3] }]);

      const rows = await runJoin([build], [probe], JoinType.INNER);

      expect(rows.length).toBe(2);
    });

    it('null probe key emits null build side for LEFT join', async () => {
      const build = makeChunk([{ type: 'INT32', values: [1] }]);
      const probe = makeChunk([{ type: 'INT32', values: [null] }]);

      const rows = await runJoin([build], [probe], JoinType.LEFT);

      expect(rows.length).toBe(1);
      expect(rows[0][0]).toBeNull();
    });
  });

  describe('unique keys', () => {
    it('deduplicates build side when uniqueKeys is true', async () => {
      const build = makeChunk([
        { type: 'INT32', values: [1, 1, 1] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ]);
      const probe = makeChunk([{ type: 'INT32', values: [1] }]);

      const rows = await runJoin([build], [probe], JoinType.INNER, 0, 0, { uniqueKeys: true });

      expect(rows.length).toBe(1);
    });
  });

  describe('condition evaluator', () => {
    it('filters join results with residual predicate', async () => {
      const build = makeChunk([
        { type: 'INT32', values: [1, 1] },
        { type: 'INT32', values: [10, 20] },
      ]);
      const probe = makeChunk([
        { type: 'INT32', values: [1] },
        { type: 'INT32', values: [15] },
      ]);

      const condition = (adapter, _) => adapter.row[1] < adapter.row[3];
      const rows = await runJoin([build], [probe], JoinType.INNER, 0, 0, { condition });

      expect(rows.length).toBe(1);
      expect(rows[0][1]).toBe(10);
    });
  });

  describe('emitUnmatched', () => {
    it('returns build rows not matched during probe', async () => {
      const buildSide = new HashJoinBuild([keyAt(0)], JoinType.FULL, false, memSpill(), true);
      await buildSide.consume(makeChunk([
        { type: 'INT32', values: [1, 2, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ]));
      await buildSide.finalize();

      const probe = new HashJoinProbe(buildSide, [keyAt(0)], 2, 1, JoinType.FULL);
      await probe.process(makeChunk([{ type: 'INT32', values: [1] }]));

      const unmatched = probe.buildUnmatchedChunk(buildSide.emitUnmatched()).toRows();

      expect(unmatched.length).toBe(2);
      const keys = unmatched.map(r => r[0]);
      expect(keys).toContain(2);
      expect(keys).toContain(3);
      for (const row of unmatched) {
        expect(row[2]).toBeNull();
      }
    });
  });

  describe('preserved build side with null keys', () => {
    it('emits null-key build rows as unmatched when the build side is preserved', async () => {
      const buildSide = new HashJoinBuild([keyAt(0)], JoinType.LEFT, false, memSpill(), true);
      await buildSide.consume(makeChunk([
        { type: 'INT32', values: [1, null, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ]));
      await buildSide.finalize();

      const probe = new HashJoinProbe(buildSide, [keyAt(0)], 2, 1, JoinType.LEFT);
      const matchChunk = await probe.process(makeChunk([{ type: 'INT32', values: [1] }]));
      const matchedLabels = (matchChunk ? matchChunk.toRows() : []).map(r => r[1]);

      const unmatched = probe.buildUnmatchedChunk(buildSide.emitUnmatched()).toRows();
      const unmatchedLabels = unmatched.map(r => r[1]);

      expect(matchedLabels).toEqual(['a']);
      expect(unmatchedLabels).toContain('b');
      expect(unmatchedLabels).toContain('c');
      expect(matchedLabels.length + unmatched.length).toBe(3);
      const nullKeyRow = unmatched.find(r => r[1] === 'b');
      expect(nullKeyRow[0]).toBeNull();
      expect(nullKeyRow[2]).toBeNull();
    });

    it('emits no build rows at all when the build side is not preserved', async () => {
      const buildSide = new HashJoinBuild([keyAt(0)], JoinType.LEFT, false, memSpill(), false);
      await buildSide.consume(makeChunk([
        { type: 'INT32', values: [1, null, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ]));
      await buildSide.finalize();

      const probe = new HashJoinProbe(buildSide, [keyAt(0)], 2, 1, JoinType.LEFT);
      await probe.process(makeChunk([{ type: 'INT32', values: [1] }]));

      const unmatchedLabels = buildSide.emitUnmatched().map(r => r[1]);
      expect(unmatchedLabels).toEqual([]);
    });
  });

  describe('spill path', () => {
    const BUILD_SCHEMA = [DataType.INT32, DataType.FLOAT64];
    let restoreMemoryLimit;

    beforeEach(() => { restoreMemoryLimit = captureMemoryLimit(); });
    afterEach(() => { restoreMemoryLimit(); });

    it('produces correct INNER join results after spill and reload', async () => {
      limitResidentRows(BUILD_SCHEMA, 5);

      const buildData = [];
      for (let i = 0; i < 50; i++) buildData.push(i);
      const build = makeChunk([
        { type: 'INT32', values: buildData },
        { type: 'FLOAT64', values: buildData.map(v => v * 10) },
      ]);

      const probeData = [0, 10, 20, 30, 40, 99];
      const probe = makeChunk([
        { type: 'INT32', values: probeData },
        { type: 'VARCHAR', values: probeData.map(v => `p${v}`) },
      ]);

      const spillMgr = memSpill();
      const buildSide = new HashJoinBuild([keyAt(0)], JoinType.INNER, false, spillMgr);
      await buildSide.consume(build);
      expect(buildSide.partitions.some(p => p.spilled)).toBe(true);
      await buildSide.finalize();

      const probeSide = new HashJoinProbe(buildSide, [keyAt(0)], 2, 2, JoinType.INNER);
      const inMemResults = [];
      const r = await probeSide.process(probe);
      if (r && r.size > 0) inMemResults.push(...r.toRows());

      const spillResults = [];
      const sink = {
        async consume(chunk) { spillResults.push(...chunk.toRows()); }
      };
      await probeSide.finalize(sink);

      const allRows = [...inMemResults, ...spillResults];
      const matchedKeys = allRows.map(r => r[0]).sort((a, b) => a - b);
      expect(matchedKeys).toEqual([0, 10, 20, 30, 40]);

      for (const row of allRows) {
        expect(row[1]).toBe(row[0] * 10);
      }
    });
  });

  describe('multi-chunk build', () => {
    it('accumulates hash table across multiple consume calls', async () => {
      const b1 = makeChunk([{ type: 'INT32', values: [1, 2] }]);
      const b2 = makeChunk([{ type: 'INT32', values: [3, 4] }]);
      const probe = makeChunk([{ type: 'INT32', values: [1, 2, 3, 4, 5] }]);

      const rows = await runJoin([b1, b2], [probe], JoinType.INNER);

      expect(rows.length).toBe(4);
    });
  });
});

describe('HashJoin spilled outer joins', () => {
  const BUILD_SCHEMA = [DataType.INT32, DataType.FLOAT64];
  let restoreMemoryLimit;

  beforeEach(() => { restoreMemoryLimit = captureMemoryLimit(); });
  afterEach(() => { restoreMemoryLimit(); });

  function memSpill() {
    return new SpillManager(new MemoryStorage());
  }

  function buildChunk(keys) {
    return makeChunk([
      { type: 'INT32', values: keys },
      { type: 'FLOAT64', values: keys.map(k => k * 10) },
    ]);
  }

  function probeChunk(keys) {
    return makeChunk([
      { type: 'INT32', values: keys },
      { type: 'VARCHAR', values: keys.map(k => `p${k}`) },
    ]);
  }

  async function runLeftJoin({ buildKeys, probeKeys, residentRows }) {
    if (residentRows !== null) limitResidentRows(BUILD_SCHEMA, residentRows);

    const spill = memSpill();
    const build = new HashJoinBuild([keyAt(0)], JoinType.LEFT, false, spill, true);
    await build.consume(buildChunk(buildKeys));
    await build.finalize();

    const probe = new HashJoinProbe(build, [keyAt(0)], 2, 2, JoinType.LEFT);
    const out = [];
    const inMemory = await probe.process(probeChunk(probeKeys));
    if (inMemory && inMemory.size > 0) out.push(...inMemory.toRows());

    const unmatched = build.emitUnmatched();
    if (unmatched.length > 0) out.push(...probe.buildUnmatchedChunk(unmatched).toRows());

    await probe.finalize({ async consume(chunk) { out.push(...chunk.toRows()); } });
    return out;
  }

  it('keeps every build row of a LEFT join when nothing spills', async () => {
    const rows = await runLeftJoin({
      buildKeys: [1, 2, 3, 4, 5, 6, 7, 8],
      probeKeys: [2, 4],
      residentRows: null,
    });

    expect(rows).toHaveLength(8);
  });

  it('keeps every build row of a LEFT join when partitions spill', async () => {
    const buildKeys = Array.from({ length: 60 }, (_, i) => i + 1);
    const rows = await runLeftJoin({ buildKeys, probeKeys: [3, 17, 42], residentRows: 4 });

    expect(rows).toHaveLength(60);
  });

  it('pads unmatched LEFT join build rows with nulls after spilling', async () => {
    const buildKeys = Array.from({ length: 40 }, (_, i) => i + 1);
    const rows = await runLeftJoin({ buildKeys, probeKeys: [5], residentRows: 3 });

    const unmatched = rows.filter(r => r[2] === null);
    expect(unmatched).toHaveLength(39);
  });

  it('matches the unspilled LEFT join result exactly when spilling', async () => {
    const buildKeys = Array.from({ length: 50 }, (_, i) => i + 1);
    const probeKeys = [1, 9, 25, 50];

    const expected = await runLeftJoin({ buildKeys, probeKeys, residentRows: null });
    const actual = await runLeftJoin({ buildKeys, probeKeys, residentRows: 4 });

    const key = rows => rows.map(r => JSON.stringify(r)).sort();
    expect(key(actual)).toEqual(key(expected));
  });
});

describe('HashJoin recursive repartitioning', () => {
  const BUILD_SCHEMA = [DataType.INT32, DataType.FLOAT64];
  let restoreMemoryLimit;

  beforeEach(() => { restoreMemoryLimit = captureMemoryLimit(); });
  afterEach(() => { restoreMemoryLimit(); });

  function memSpill() {
    return new SpillManager(new MemoryStorage());
  }

  async function runInnerJoin({ buildKeys, probeKeys, residentRows }) {
    if (residentRows !== null) limitResidentRows(BUILD_SCHEMA, residentRows);

    const spill = memSpill();
    const build = new HashJoinBuild([keyAt(0)], JoinType.INNER, false, spill);
    await build.consume(makeChunk([
      { type: 'INT32', values: buildKeys },
      { type: 'FLOAT64', values: buildKeys.map(k => k * 10) },
    ]));
    await build.finalize();

    const probe = new HashJoinProbe(build, [keyAt(0)], 2, 2, JoinType.INNER);
    const out = [];
    const inMemory = await probe.process(makeChunk([
      { type: 'INT32', values: probeKeys },
      { type: 'VARCHAR', values: probeKeys.map(k => `p${k}`) },
    ]));
    if (inMemory && inMemory.size > 0) out.push(...inMemory.toRows());

    await probe.finalize({ async consume(chunk) { out.push(...chunk.toRows()); } });
    return { rows: out, probe };
  }

  it('produces the same rows as an unspilled join', async () => {
    const buildKeys = Array.from({ length: 200 }, (_, i) => i);
    const probeKeys = Array.from({ length: 60 }, (_, i) => i * 3);

    const expected = await runInnerJoin({ buildKeys, probeKeys, residentRows: null });
    const actual = await runInnerJoin({ buildKeys, probeKeys, residentRows: 3 });

    const key = r => r.rows.map(row => JSON.stringify(row)).sort();
    expect(key(actual)).toEqual(key(expected));
  });

  it('recurses when a single partition still exceeds the budget', async () => {
    const buildKeys = Array.from({ length: 300 }, (_, i) => i);
    const { probe } = await runInnerJoin({ buildKeys, probeKeys: [7, 77, 177], residentRows: 2 });

    expect(probe.repartitionDepthReached).toBeGreaterThan(0);
  });

  it('does not recurse when partitions already fit', async () => {
    const buildKeys = Array.from({ length: 40 }, (_, i) => i);
    const { probe } = await runInnerJoin({ buildKeys, probeKeys: [1, 2], residentRows: 20 });

    expect(probe.repartitionDepthReached).toBe(0);
  });

  it('stops recursing at the configured depth ceiling', async () => {
    const savedDepth = Config.hashJoinMaxRepartitionDepth;
    Config.hashJoinMaxRepartitionDepth = 1;
    try {
      const buildKeys = Array.from({ length: 400 }, (_, i) => i);
      const { rows, probe } = await runInnerJoin({ buildKeys, probeKeys: [11, 111], residentRows: 2 });

      expect(probe.repartitionDepthReached).toBeLessThanOrEqual(1);
      expect(rows).toHaveLength(2);
    } finally {
      Config.hashJoinMaxRepartitionDepth = savedDepth;
    }
  });

  it('keeps duplicate build keys intact through repartitioning', async () => {
    const buildKeys = [];
    for (let i = 0; i < 150; i++) { buildKeys.push(i % 50); }

    const { rows } = await runInnerJoin({ buildKeys, probeKeys: [7], residentRows: 2 });

    expect(rows).toHaveLength(3);
  });

  it('clears every spill handle once finished', async () => {
    limitResidentRows(BUILD_SCHEMA, 2);
    const spill = memSpill();
    const build = new HashJoinBuild([keyAt(0)], JoinType.INNER, false, spill);
    await build.consume(makeChunk([
      { type: 'INT32', values: Array.from({ length: 200 }, (_, i) => i) },
      { type: 'FLOAT64', values: Array.from({ length: 200 }, (_, i) => i) },
    ]));
    await build.finalize();

    const probe = new HashJoinProbe(build, [keyAt(0)], 2, 2, JoinType.INNER);
    await probe.process(makeChunk([
      { type: 'INT32', values: [1, 2, 3] },
      { type: 'VARCHAR', values: ['a', 'b', 'c'] },
    ]));
    await probe.finalize({ async consume() {} });

    expect(spill.storage.store.size).toBe(0);
  });
});

describe('HashJoin runtime filter', () => {
  function memSpill() {
    return new SpillManager(new MemoryStorage());
  }

  async function runJoin(joinType, buildKeys, probeKeys) {
    const spill = memSpill();
    const filterEntries = buildKeys.length >= Config.joinRuntimeFilterMinRows
      && (joinType === JoinType.INNER || joinType === JoinType.SEMI)
      ? buildKeys.length
      : 0;
    const build = new HashJoinBuild([keyAt(0)], joinType, false, spill, joinType === JoinType.LEFT, filterEntries);
    await build.consume(makeChunk([
      { type: 'INT32', values: buildKeys },
      { type: 'FLOAT64', values: buildKeys.map(k => k * 10) },
    ]));
    await build.finalize();

    const probe = new HashJoinProbe(build, [keyAt(0)], 2, 2, joinType);
    const rows = [];
    const result = await probe.process(makeChunk([
      { type: 'INT32', values: probeKeys },
      { type: 'VARCHAR', values: probeKeys.map(k => `p${k}`) },
    ]));
    if (result && result.size > 0) rows.push(...result.toRows());
    await probe.finalize({ async consume(chunk) { rows.push(...chunk.toRows()); } });

    return { rows, build, probe };
  }

  const bigBuild = Array.from({ length: 3000 }, (_, i) => i);

  it('builds a runtime filter once the build side is large enough', async () => {
    const { build } = await runJoin(JoinType.INNER, bigBuild, [1, 2]);
    expect(build.runtimeFilter).not.toBeNull();
  });

  it('skips the runtime filter for a small build side', async () => {
    const { build } = await runJoin(JoinType.INNER, [1, 2, 3], [1]);
    expect(build.runtimeFilter).toBeNull();
  });

  it('skips the runtime filter for a join type that keeps unmatched probe rows', async () => {
    const { build } = await runJoin(JoinType.LEFT, bigBuild, [1]);
    expect(build.runtimeFilter).toBeNull();
  });

  it('rejects probe keys that cannot match', async () => {
    const { probe } = await runJoin(JoinType.INNER, bigBuild, [900000, 900001, 900002]);
    expect(probe.runtimeFilterRejections).toBeGreaterThan(0);
  });

  it('keeps probe keys that do match', async () => {
    const { rows } = await runJoin(JoinType.INNER, bigBuild, [5, 500, 2999]);
    expect(rows).toHaveLength(3);
  });

  it('produces the same inner join result as without the filter', async () => {
    const probeKeys = [0, 7, 1500, 2999, 900000];
    const withFilter = await runJoin(JoinType.INNER, bigBuild, probeKeys);
    const withoutFilter = await runJoin(JoinType.INNER, bigBuild.slice(0, 100), probeKeys.filter(k => k < 100));

    expect(withFilter.rows.map(r => r[0]).sort((a, b) => a - b)).toEqual([0, 7, 1500, 2999]);
    expect(withoutFilter.build.runtimeFilter).toBeNull();
    expect(withoutFilter.rows.map(r => r[0]).sort((a, b) => a - b)).toEqual([0, 7]);
  });

  it('does not discard probe rows for a left outer join', async () => {
    const { probe, rows } = await runJoin(JoinType.LEFT, bigBuild, [1, 900000]);

    expect(probe.runtimeFilterRejections).toBe(0);
    expect(rows).toHaveLength(2);
  });

  it('discards for a semi join', async () => {
    const { probe } = await runJoin(JoinType.SEMI, bigBuild, [900000, 900001]);
    expect(probe.runtimeFilterRejections).toBe(2);
  });

  it('does not discard for an anti join', async () => {
    const { probe } = await runJoin(JoinType.ANTI, bigBuild, [900000, 900001]);
    expect(probe.runtimeFilterRejections).toBe(0);
  });

  it('never rejects a key that is present in the build side', async () => {
    const { probe } = await runJoin(JoinType.INNER, bigBuild, bigBuild.slice(0, 500));
    expect(probe.runtimeFilterRejections).toBe(0);
  });
});
