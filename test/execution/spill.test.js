import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SortOperator } from '../../src/execution/operators/sort.js';
import { HashJoinBuild, HashJoinProbe } from '../../src/execution/operators/hash-join.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { Column } from '../../src/storage/column.js';
import { JoinType } from '../../src/planner/logical-plan.js';
import { TempDirectoryManager } from '../../src/storage/temp-directory-manager.js';
import { Config } from '../../src/config.js';

let tempManager;
let savedMemoryLimit;

describe('Out-of-Core Execution', () => {
  beforeEach(() => {
    tempManager = new TempDirectoryManager();
    savedMemoryLimit = Config.memoryLimit;
    Config.memoryLimit = 10;
  });

  afterEach(() => {
    Config.memoryLimit = savedMemoryLimit;
    tempManager.cleanup();
  });

  it('should spill and merge in SortOperator when exceeding memory limit', async () => {
    const keyExtractors = [{ eval: (c, r) => c.columns[0].get(r), direction: 'ASC' }];
    const sortOp = new SortOperator(keyExtractors, null, 0, tempManager.allocate('spill', 'sort'));

    await sortOp.init();

    let value = 250;
    for (let i = 0; i < 50; i++) {
      const col = new Column('INT32', 5);
      for (let j = 0; j < 5; j++) {
        col.set(j, value--);
      }
      col.length = 5;
      const chunk = new DataChunk([col], 5);
      await sortOp.consume(chunk);
    }

    const results = await sortOp.finalize();

    let allRows = [];
    for (const chunk of results) {
      for (let i = 0; i < chunk.size; i++) {
        allRows.push(chunk.columns[0].get(i));
      }
    }

    expect(allRows.length).toBe(250);
    for (let i = 0; i < 249; i++) {
      expect(allRows[i]).toBeLessThanOrEqual(allRows[i + 1]);
    }
  });

  it('should spill and join in HashJoin when exceeding memory limit', async () => {
    const buildExts = [(c, r) => c.columns[0].get(r)];
    const probeExts = [(c, r) => c.columns[0].get(r)];

    const buildSide = new HashJoinBuild(buildExts, JoinType.INNER, false, tempManager.allocate('spill', 'join'));
    const probeOp = new HashJoinProbe(buildSide, probeExts, 1, 1, JoinType.INNER);

    await buildSide.init();
    await probeOp.init();

    for (let i = 0; i < 20; i++) {
      const col = new Column('INT32', 5);
      for (let j = 0; j < 5; j++) {
        col.set(j, (i * 5) + j + 1);
      }
      col.length = 5;
      await buildSide.consume(new DataChunk([col], 5));
    }
    await buildSide.finalize();

    const results = [];
    const sink = {
      async consume(chunk) {
        results.push(chunk);
      }
    };

    for (let i = 0; i < 20; i++) {
      const col = new Column('INT32', 5);
      for (let j = 0; j < 5; j++) {
        col.set(j, 100 - ((i * 5) + j));
      }
      col.length = 5;
      const res = await probeOp.process(new DataChunk([col], 5));
      if (res && res.size > 0) results.push(res);
    }

    await probeOp.finalize(sink);

    let totalJoined = 0;
    for (const chunk of results) {
      totalJoined += chunk.size;
    }

    expect(totalJoined).toBe(100);
  });
});
