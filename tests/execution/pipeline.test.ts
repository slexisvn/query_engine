import { describe, it, expect } from 'vitest';
import { PipelineGraph, CancelToken } from '../../src/execution/pipeline.js';

describe('PipelineGraph', () => {
  it('creates pipelines with incrementing IDs', () => {
    const g = new PipelineGraph();
    const p1 = g.createPipeline({});
    const p2 = g.createPipeline({});

    expect(p2).toBe(p1 + 1);
  });

  it('tracks dependencies bidirectionally', () => {
    const g = new PipelineGraph();
    const p1 = g.createPipeline({});
    const p2 = g.createPipeline({});
    g.addDependency(p2, p1);

    expect(g.pipelines.get(p2).dependencies.has(p1)).toBe(true);
    expect(g.pipelines.get(p1).dependents.has(p2)).toBe(true);
  });

  it('getReadyPipelines returns only pipelines with no dependencies', () => {
    const g = new PipelineGraph();
    const p1 = g.createPipeline({});
    const p2 = g.createPipeline({});
    const p3 = g.createPipeline({});
    g.addDependency(p3, p1);
    g.addDependency(p3, p2);

    const ready = g.getReadyPipelines();
    const readyIds = ready.map(p => p.id);

    expect(readyIds).toContain(p1);
    expect(readyIds).toContain(p2);
    expect(readyIds).not.toContain(p3);
  });

  it('markPipelineDone removes it from dependents\' dependency sets', () => {
    const g = new PipelineGraph();
    const p1 = g.createPipeline({});
    const p2 = g.createPipeline({});
    g.addDependency(p2, p1);

    g.markPipelineDone(p1);

    expect(g.pipelines.get(p2).dependencies.size).toBe(0);
    expect(g.pipelines.get(p1).state).toBe('DONE');
  });

  it('after marking dependency done, dependent becomes ready', () => {
    const g = new PipelineGraph();
    const p1 = g.createPipeline({});
    const p2 = g.createPipeline({});
    g.addDependency(p2, p1);

    expect(g.getReadyPipelines().map(p => p.id)).not.toContain(p2);

    g.markPipelineDone(p1);

    expect(g.getReadyPipelines().map(p => p.id)).toContain(p2);
  });

  it('marking a pipeline failed moves it out of the running state', () => {
    const g = new PipelineGraph();
    const p = g.createPipeline({});
    g.pipelines.get(p).state = 'RUNNING';

    g.markPipelineFailed(p);

    expect(g.pipelines.get(p).state).toBe('FAILED');
  });

  it('cancelling a running pipeline records the cancellation as its state', () => {
    const g = new PipelineGraph();
    const p = g.createPipeline({});
    g.pipelines.get(p).state = 'RUNNING';

    g.cancelPipeline(p);

    expect(g.isCancelled(p)).toBe(true);
    expect(g.pipelines.get(p).state).toBe('CANCELLED');
  });

  it('a cancelled pipeline is never handed out as ready to run', () => {
    const g = new PipelineGraph();
    const p = g.createPipeline({});

    g.cancelPipeline(p);

    expect(g.getReadyPipelines().map(pipeline => pipeline.id)).not.toContain(p);
  });

  it('cancelling a finished pipeline does not undo its completion', () => {
    const g = new PipelineGraph();
    const p = g.createPipeline({});
    g.markPipelineDone(p);

    g.cancelPipeline(p);

    expect(g.pipelines.get(p).state).toBe('DONE');
  });
});

describe('CancelToken', () => {
  it('starts uncancelled', () => {
    const token = new CancelToken();
    expect(token.isCancelled).toBe(false);
  });

  it('becomes cancelled after cancel()', () => {
    const token = new CancelToken();
    token.cancel();
    expect(token.isCancelled).toBe(true);
  });
});
