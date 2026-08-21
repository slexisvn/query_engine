import { describe, it, expect } from 'vitest';
import { FragmentExecutor } from '../../../src/distributed/execution/fragment-executor.js';
import { fragmentOutputChannel } from '../../../src/distributed/planner/fragment.js';
import { Catalog } from '../../../src/catalog/catalog.js';
import { MemoryStorageBackend } from '../../../src/storage/backend/memory-storage-backend.js';

function fakeTransport() {
  const listeners = new Map();
  return {
    listeners,
    onChunkReceived(channelId, callback) { listeners.set(channelId, callback); },
    removeChunkListener(channelId) { listeners.delete(channelId); },
    async sendChunk() {},
    async sendControl() {},
    async sendFragment() {},
  };
}

function fragmentWithInputs(fragmentId, planRoot, sourceFragmentIds) {
  return {
    fragmentId,
    planRoot,
    exchangeInputs: sourceFragmentIds.map(id => ({ sourceFragmentId: id, exchangeType: 'gather' })),
    markRunning() {},
    markCompleted() {},
    markFailed() {},
    markCancelled() {},
  };
}

const missingTableScan = { type: 'Scan', table: 'NOPE', columns: [], alias: 'NOPE' };

describe('FragmentExecutor exchange channels', () => {
  function makeExecutor(transport) {
    const backend = new MemoryStorageBackend();
    return new FragmentExecutor(new Catalog(), { allocate: () => ({}) }, transport, backend);
  }

  it('listens on the channel its source fragment publishes to', async () => {
    const transport = fakeTransport();
    const executor = makeExecutor(transport);

    await executor._setupReceivers(fragmentWithInputs(2, missingTableScan, [1]));
    expect([...transport.listeners.keys()]).toEqual([fragmentOutputChannel(1)]);
  });

  it('releases its listeners when the fragment fails', async () => {
    const transport = fakeTransport();
    const executor = makeExecutor(transport);

    await expect(executor.execute(fragmentWithInputs(2, missingTableScan, [1, 7]), null)).rejects.toThrow();
    expect(transport.listeners.size).toBe(0);
  });

  it('releases every listener when a fragment has several inputs', async () => {
    const transport = fakeTransport();
    const executor = makeExecutor(transport);
    const fragment = fragmentWithInputs(9, missingTableScan, [3, 4, 5]);

    await executor._setupReceivers(fragment);
    expect(transport.listeners.size).toBe(3);

    executor._cleanupReceivers(fragment);
    expect(transport.listeners.size).toBe(0);
  });
});
