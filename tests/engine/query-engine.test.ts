import { describe, it, expect } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.js';
import { QueryEngine } from '../../src/index.js';
import { PLAN_PROPERTIES_PASS } from '../../src/optimizer/passes/plan-properties.js';

class StubTransport {
  async start() {}
  async stop() {}
  async sendChunk() {}
  onChunkReceived() {}
  removeChunkListener() {}
  async sendFragment() {}
  async sendControl() {}
  onControlMessage() {}
  onFragmentReceived() {}
}

describe('QueryEngine distributed pass installation', () => {
  it('installs the distribution-aware join pass directly after the plan-properties stage', async () => {
    const engine = new QueryEngine(new Catalog());
    await engine.enableDistributed({ nodeId: 'test-node', transport: new StubTransport() });

    const stages = engine.optimizer.listStages();
    const anchor = stages.indexOf(PLAN_PROPERTIES_PASS);

    expect(anchor).toBeGreaterThanOrEqual(0);
    expect(stages[anchor + 1]).toBe('DistributionAwareJoin');

    await engine.shutdown();
    engine.close();
  });

  it('keeps the distributed passes out of the pipeline until distribution is enabled', () => {
    const engine = new QueryEngine(new Catalog());

    expect(engine.optimizer.listStages()).not.toContain('DistributionAwareJoin');

    engine.close();
  });
});
