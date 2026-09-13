import { describe, it, expect } from 'vitest';
import { QueryExecutor } from '../../src/execution/query-executor.js';
import { ExecutionProfiler } from '../../src/execution/execution-profile.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { PlanNodeType } from '../../src/planner/logical-plan.js';

function mockTempManager() {
  return { allocate: (category, label) => `${category}/${label}` };
}

function newExecutor() {
  return new QueryExecutor(new Catalog(), mockTempManager());
}

const scanPlan = (table) => ({ type: PlanNodeType.SCAN, table, columns: null, children: [] });

describe('ExecutionContext', () => {
  it('clears every spill store registered by a failed run', async () => {
    const cleared = [];
    const backend = {
      createSpillManager: (handle) => ({
        appendChunk: async () => {},
        async *readChunks() {},
        clearPartition: async () => {},
        clearAll: async () => { cleared.push(handle); },
      }),
    };
    const executor = new QueryExecutor(new Catalog(), mockTempManager(), backend);
    const ctx = executor.newContext();

    ctx.createSpillStore('first');
    ctx.createSpillStore('second');
    await ctx.clearSpillStoresAfterFailure();
    await ctx.clearSpillStoresAfterFailure();

    expect(cleared.sort()).toEqual(['spill/first', 'spill/second']);
  });

  it('retries a transient spill cleanup failure once', async () => {
    let attempts = 0;
    const backend = {
      createSpillManager: () => ({
        appendChunk: async () => {},
        async *readChunks() {},
        clearPartition: async () => {},
        clearAll: async () => {
          attempts++;
          if (attempts === 1) throw new Error('temporary cleanup failure');
        },
      }),
    };
    const executor = new QueryExecutor(new Catalog(), mockTempManager(), backend);
    const ctx = executor.newContext();
    ctx.createSpillStore('retry');

    await ctx.clearSpillStoresAfterFailure();

    expect(attempts).toBe(2);
    expect(ctx.spillStores.size).toBe(0);
  });

  it('gives each run its own CTE state', () => {
    const executor = newExecutor();
    const first = executor.newContext();
    const second = executor.newContext();

    first.defineCTE('C', scanPlan('LEFT_TABLE'));
    second.defineCTE('C', scanPlan('RIGHT_TABLE'));

    expect(first.findCTEPlan('C').table).toBe('LEFT_TABLE');
    expect(second.findCTEPlan('C').table).toBe('RIGHT_TABLE');
  });

  it('copies the CTE definitions it is handed instead of aliasing them', () => {
    const executor = newExecutor();
    const definitions = new Map([['C', scanPlan('ORIGINAL')]]);
    const ctx = executor.newContext({ cteDefinitions: definitions });

    ctx.defineCTE('C', scanPlan('REPLACED'));

    expect(definitions.get('C').table).toBe('ORIGINAL');
  });

  it('resolves CTE names case-insensitively', () => {
    const ctx = newExecutor().newContext({ cteDefinitions: new Map([['C', scanPlan('T')]]) });

    expect(ctx.findCTEPlan('c').table).toBe('T');
    expect(ctx.findCTEPlan('MISSING')).toBeNull();
  });

  it('shares session resources across runs while keeping run state separate', () => {
    const executor = newExecutor();
    const first = executor.newContext();
    const second = executor.newContext();

    expect(first.resources).toBe(second.resources);
    expect(first.cteResults).not.toBe(second.cteResults);
    expect(first.ctePipelines).not.toBe(second.ctePipelines);
  });

  it('profiles only the run that was given a profiler', () => {
    const executor = newExecutor();
    const profiler = new ExecutionProfiler();

    expect(executor.newContext({ profiler }).profiler).toBe(profiler);
    expect(executor.newContext().profiler).toBeNull();
  });
});
