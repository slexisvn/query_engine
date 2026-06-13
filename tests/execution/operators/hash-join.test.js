import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HashJoinBuild, HashJoinProbe } from '../../../src/execution/operators/hash-join.js';
import { SpillManager } from '../../../src/storage/spill-manager/spill-manager.js';
import { MemoryStorage } from '../../../src/storage/spill-manager/memory-storage.js';
import { Column } from '../../../src/storage/column.js';
import { DataChunk } from '../../../src/storage/chunk.js';
import { JoinType } from '../../../src/planner/logical-plan.js';
import { Config } from '../../../src/config.js';

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
      const buildSide = new HashJoinBuild([keyAt(0)], JoinType.FULL, false, memSpill());
      await buildSide.consume(makeChunk([
        { type: 'INT32', values: [1, 2, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ]));
      await buildSide.finalize();

      const probe = new HashJoinProbe(buildSide, [keyAt(0)], 2, 1, JoinType.FULL);
      await probe.process(makeChunk([{ type: 'INT32', values: [1] }]));

      const unmatched = buildSide.emitUnmatched(1);

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

      const unmatched = buildSide.emitUnmatched(1);
      const unmatchedLabels = unmatched.map(r => r[1]);

      expect(matchedLabels).toEqual(['a']);
      expect(unmatchedLabels).toContain('b');
      expect(unmatchedLabels).toContain('c');
      expect(matchedLabels.length + unmatched.length).toBe(3);
      const nullKeyRow = unmatched.find(r => r[1] === 'b');
      expect(nullKeyRow[0]).toBeNull();
      expect(nullKeyRow[2]).toBeNull();
    });

    it('still drops null-key build rows when the build side is not preserved', async () => {
      const buildSide = new HashJoinBuild([keyAt(0)], JoinType.LEFT, false, memSpill(), false);
      await buildSide.consume(makeChunk([
        { type: 'INT32', values: [1, null, 3] },
        { type: 'VARCHAR', values: ['a', 'b', 'c'] },
      ]));
      await buildSide.finalize();

      const probe = new HashJoinProbe(buildSide, [keyAt(0)], 2, 1, JoinType.LEFT);
      await probe.process(makeChunk([{ type: 'INT32', values: [1] }]));

      const unmatchedLabels = buildSide.emitUnmatched(1).map(r => r[1]);
      expect(unmatchedLabels).toEqual(['c']);
    });
  });

  describe('spill path', () => {
    let savedMemoryLimit;

    beforeEach(() => { savedMemoryLimit = Config.memoryLimit; });
    afterEach(() => { Config.memoryLimit = savedMemoryLimit; });

    it('produces correct INNER join results after spill and reload', async () => {
      Config.memoryLimit = 5;

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
