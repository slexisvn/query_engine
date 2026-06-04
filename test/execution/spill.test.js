import { describe, it, expect } from 'vitest';
import { SortOperator } from '../../src/execution/operators/sort.js';
import { HashJoinBuild, HashJoinProbe } from '../../src/execution/operators/hash-join.js';
import { DataChunk } from '../../src/storage/chunk.js';
import { Column } from '../../src/storage/column.js';
import { JoinType } from '../../src/planner/logical-plan.js';

describe('Out-of-Core Execution', () => {
  it('should spill and merge in SortOperator when exceeding MAX_ROWS_IN_RAM', async () => {
    // Set a tiny memory limit
    process.env.MAX_ROWS_IN_RAM = '10';
    
    // Create an array of 50 chunks, each with 5 rows (total 250 rows).
    // This will create at least 25 runs!
    const keyExtractors = [{ eval: (c, r) => c.columns[0].get(r), direction: 'ASC' }];
    const sortOp = new SortOperator(keyExtractors);
    
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
    
    // Validate results are sorted
    let allRows = [];
    for (const chunk of results) {
      for (let i = 0; i < chunk.size; i++) {
        allRows.push(chunk.columns[0].get(i));
      }
    }
    
    expect(allRows.length).toBe(250);
    for (let i = 0; i < 249; i++) {
      expect(allRows[i]).toBeLessThanOrEqual(allRows[i+1]);
    }
    
    // Clear limit
    delete process.env.MAX_ROWS_IN_RAM;
  });

  it('should spill and join in HashJoin when exceeding MAX_ROWS_IN_RAM', async () => {
    process.env.MAX_ROWS_IN_RAM = '10';
    
    const buildExts = [(c, r) => c.columns[0].get(r)];
    const probeExts = [(c, r) => c.columns[0].get(r)];
    
    const buildSide = new HashJoinBuild(buildExts, JoinType.INNER, false);
    const probeOp = new HashJoinProbe(buildSide, probeExts, 1, 1, JoinType.INNER);
    
    await buildSide.init();
    await probeOp.init();
    
    // Build side: 100 rows, keys 1-100
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
    
    // Probe side: 100 rows, keys 1-100 but descending
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
    
    delete process.env.MAX_ROWS_IN_RAM;
  });
});
