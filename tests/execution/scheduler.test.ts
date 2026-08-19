import { describe, it, expect } from 'vitest';
import { TaskScheduler } from '../../src/execution/scheduler.js';
import { PipelineGraph } from '../../src/execution/pipeline.js';

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

describe('TaskScheduler', () => {
  describe('single pipeline', () => {
    it('executes a single pipeline source to completion', async () => {
      const graph = new PipelineGraph();
      const collected = [];
      const sink = {
        async consume(v) { collected.push(v); },
        async finalize() {},
      };
      const pid = graph.createPipeline(sink);
      graph.setSource(pid, async function* () {
        yield 'a';
        yield 'b';
        yield 'c';
      });

      const scheduler = new TaskScheduler();
      await scheduler.schedule(graph);

      expect(graph.pipelines.get(pid).state).toBe('DONE');
    });

    it('runs source generator and consumes all yielded values', async () => {
      const graph = new PipelineGraph();
      const collected = [];
      const sink = { async consume(v) { collected.push(v); } };
      const pid = graph.createPipeline(sink);
      graph.setSource(pid, async function* () {
        await sink.consume(10);
        yield 10;
        await sink.consume(20);
        yield 20;
      });

      await new TaskScheduler().schedule(graph);

      expect(collected).toEqual([10, 20]);
    });
  });

  describe('dependency ordering', () => {
    it('runs dependency before dependent pipeline', async () => {
      const graph = new PipelineGraph();
      const order = [];

      const sink1 = { async consume() {} };
      const sink2 = { async consume() {} };
      const p1 = graph.createPipeline(sink1);
      const p2 = graph.createPipeline(sink2);

      graph.setSource(p1, async function* () { order.push('p1'); yield; });
      graph.setSource(p2, async function* () { order.push('p2'); yield; });
      graph.addDependency(p2, p1);

      await new TaskScheduler().schedule(graph);

      expect(order.indexOf('p1')).toBeLessThan(order.indexOf('p2'));
    });

    it('executes a chain of 3 pipelines in dependency order', async () => {
      const graph = new PipelineGraph();
      const order = [];

      const s = { async consume() {} };
      const p1 = graph.createPipeline(s);
      const p2 = graph.createPipeline(s);
      const p3 = graph.createPipeline(s);

      graph.setSource(p1, async function* () { order.push('p1'); yield; });
      graph.setSource(p2, async function* () { order.push('p2'); yield; });
      graph.setSource(p3, async function* () { order.push('p3'); yield; });

      graph.addDependency(p2, p1);
      graph.addDependency(p3, p2);

      await new TaskScheduler().schedule(graph);

      expect(order).toEqual(['p1', 'p2', 'p3']);
    });

    it('runs independent pipelines in the same round', async () => {
      const graph = new PipelineGraph();
      const started = [];

      const s = { async consume() {} };
      const p1 = graph.createPipeline(s);
      const p2 = graph.createPipeline(s);

      graph.setSource(p1, async function* () { started.push('p1'); yield; });
      graph.setSource(p2, async function* () { started.push('p2'); yield; });

      await new TaskScheduler().schedule(graph);

      expect(started).toContain('p1');
      expect(started).toContain('p2');
      expect(started.length).toBe(2);
    });
  });

  describe('diamond dependency', () => {
    it('handles diamond: A -> B,C -> D', async () => {
      const graph = new PipelineGraph();
      const order = [];

      const s = { async consume() {} };
      const pA = graph.createPipeline(s);
      const pB = graph.createPipeline(s);
      const pC = graph.createPipeline(s);
      const pD = graph.createPipeline(s);

      graph.setSource(pA, async function* () { order.push('A'); yield; });
      graph.setSource(pB, async function* () { order.push('B'); yield; });
      graph.setSource(pC, async function* () { order.push('C'); yield; });
      graph.setSource(pD, async function* () { order.push('D'); yield; });

      graph.addDependency(pB, pA);
      graph.addDependency(pC, pA);
      graph.addDependency(pD, pB);
      graph.addDependency(pD, pC);

      await new TaskScheduler().schedule(graph);

      expect(order.indexOf('A')).toBe(0);
      expect(order.indexOf('D')).toBe(3);
      expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
      expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
    });
  });

  describe('data flow through sink', () => {
    it('build pipeline feeds data to probe pipeline via shared state', async () => {
      const graph = new PipelineGraph();
      const buildResults = [];
      const probeResults = [];

      const buildSink = {
        async consume(v) { buildResults.push(v); },
        async finalize() {},
      };
      const probeSink = {
        async consume(v) { probeResults.push(v); },
        async finalize() {},
      };

      const buildPid = graph.createPipeline(buildSink);
      const probePid = graph.createPipeline(probeSink);

      graph.setSource(buildPid, async function* () {
        await buildSink.consume(1);
        await buildSink.consume(2);
        await buildSink.consume(3);
        yield;
      });

      graph.setSource(probePid, async function* () {
        for (const v of buildResults) {
          await probeSink.consume(v * 10);
          yield;
        }
      });

      graph.addDependency(probePid, buildPid);

      await new TaskScheduler().schedule(graph);

      expect(buildResults).toEqual([1, 2, 3]);
      expect(probeResults).toEqual([10, 20, 30]);
    });
  });

  describe('pipeline cancellation', () => {
    it('stops iterating source when pipeline is cancelled', async () => {
      const graph = new PipelineGraph();
      const emitted = [];

      const sink = { async consume() {} };
      const pid = graph.createPipeline(sink);

      graph.setSource(pid, async function* () {
        for (let i = 0; i < 100; i++) {
          emitted.push(i);
          yield i;
          if (i === 2) graph.cancelPipeline(pid);
        }
      });

      await new TaskScheduler().schedule(graph);

      expect(emitted.length).toBeLessThanOrEqual(4);
    });
  });

  describe('deadlock detection', () => {
    it('throws on circular dependency', async () => {
      const graph = new PipelineGraph();
      const s = { async consume() {} };
      const p1 = graph.createPipeline(s);
      const p2 = graph.createPipeline(s);

      graph.setSource(p1, async function* () { yield; });
      graph.setSource(p2, async function* () { yield; });

      graph.addDependency(p1, p2);
      graph.addDependency(p2, p1);

      await expect(new TaskScheduler().schedule(graph)).rejects.toThrow('deadlock');
    });
  });

  describe('empty graph', () => {
    it('completes immediately with no pipelines', async () => {
      const graph = new PipelineGraph();
      await new TaskScheduler().schedule(graph);
    });
  });

  describe('pipeline without source', () => {
    it('marks pipeline done even without a source generator', async () => {
      const graph = new PipelineGraph();
      const s = { async consume() {} };
      const p1 = graph.createPipeline(s);

      await new TaskScheduler().schedule(graph);

      expect(graph.pipelines.get(p1).state).toBe('DONE');
    });
  });

  describe('error propagation', () => {
    it('propagates errors from source generator', async () => {
      const graph = new PipelineGraph();
      const s = { async consume() {} };
      const pid = graph.createPipeline(s);

      graph.setSource(pid, async function* () {
        yield 1;
        throw new Error('source failed');
      });

      await expect(new TaskScheduler().schedule(graph)).rejects.toThrow('source failed');
    });

    it('propagates errors from sink.consume', async () => {
      const graph = new PipelineGraph();
      const sink = {
        async consume() { throw new Error('sink exploded'); },
      };
      const pid = graph.createPipeline(sink);

      graph.setSource(pid, async function* () {
        await sink.consume(1);
        yield 1;
      });

      await expect(new TaskScheduler().schedule(graph)).rejects.toThrow('sink exploded');
    });

    it('leaves the failed pipeline in a terminal state, not still running', async () => {
      const graph = new PipelineGraph();
      const pid = graph.createPipeline({ async consume() {} });
      graph.setSource(pid, async function* () {
        yield 1;
        throw new Error('source failed');
      });

      await expect(new TaskScheduler().schedule(graph)).rejects.toThrow('source failed');

      expect(graph.pipelines.get(pid).state).toBe('FAILED');
    });

    it('leaves the pipelines it cancelled in a terminal state', async () => {
      const graph = new PipelineGraph();
      const failing = graph.createPipeline({ async consume() {} });
      const bystander = graph.createPipeline({ async consume() {} });

      graph.setSource(failing, async function* () {
        await delay(1);
        throw new Error('source failed');
      });
      graph.setSource(bystander, async function* () {
        for (let i = 0; i < 100; i++) {
          await delay(1);
          yield i;
        }
      });

      await expect(new TaskScheduler().schedule(graph)).rejects.toThrow('source failed');

      expect(graph.pipelines.get(failing).state).toBe('FAILED');
      expect(graph.pipelines.get(bystander).state).toBe('CANCELLED');
    });
  });

  describe('multi-stage pipeline simulation', () => {
    it('scan -> build -> probe pattern executes correctly', async () => {
      const graph = new PipelineGraph();
      const hashTable = [];
      const joinResults = [];

      const scanSink = {
        async consume(v) { hashTable.push(v); },
      };
      const resultSink = {
        async consume(v) { joinResults.push(v); },
      };

      const scanPid = graph.createPipeline(scanSink);
      const probePid = graph.createPipeline(resultSink);

      graph.setSource(scanPid, async function* () {
        for (const row of [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]) {
          await scanSink.consume(row);
          yield;
        }
      });

      graph.setSource(probePid, async function* () {
        const probeRows = [{ id: 1, val: 100 }, { id: 3, val: 300 }, { id: 5, val: 500 }];
        for (const probe of probeRows) {
          const match = hashTable.find(b => b.id === probe.id);
          if (match) {
            const result = { ...match, ...probe };
            await resultSink.consume(result);
            yield;
          }
        }
      });

      graph.addDependency(probePid, scanPid);

      await new TaskScheduler().schedule(graph);

      expect(joinResults.length).toBe(2);
      expect(joinResults[0]).toEqual({ id: 1, name: 'a', val: 100 });
      expect(joinResults[1]).toEqual({ id: 3, name: 'c', val: 300 });
    });

    it('three-stage: scan -> aggregate -> sort', async () => {
      const graph = new PipelineGraph();
      const scanned = [];
      const aggregated = [];
      const sorted = [];

      const scanSink = { async consume(v) { scanned.push(v); } };
      const aggSink = { async consume(v) { aggregated.push(v); } };
      const sortSink = { async consume(v) { sorted.push(v); } };

      const scanPid = graph.createPipeline(scanSink);
      const aggPid = graph.createPipeline(aggSink);
      const sortPid = graph.createPipeline(sortSink);

      graph.setSource(scanPid, async function* () {
        for (const r of [{ g: 'a', v: 10 }, { g: 'a', v: 20 }, { g: 'b', v: 5 }]) {
          await scanSink.consume(r);
          yield;
        }
      });

      graph.setSource(aggPid, async function* () {
        const groups = {};
        for (const r of scanned) {
          groups[r.g] = (groups[r.g] || 0) + r.v;
        }
        for (const [g, total] of Object.entries(groups)) {
          await aggSink.consume({ g, total });
          yield;
        }
      });

      graph.setSource(sortPid, async function* () {
        const data = [...aggregated].sort((a, b) => b.total - a.total);
        for (const r of data) {
          await sortSink.consume(r);
          yield;
        }
      });

      graph.addDependency(aggPid, scanPid);
      graph.addDependency(sortPid, aggPid);

      await new TaskScheduler().schedule(graph);

      expect(sorted.length).toBe(2);
      expect(sorted[0]).toEqual({ g: 'a', total: 30 });
      expect(sorted[1]).toEqual({ g: 'b', total: 5 });
    });
  });
});

describe('TaskScheduler concurrency', () => {
  function trackingGraph(pipelineCount, tracker) {
    const graph = new PipelineGraph();
    const sink = { async consume() {} };
    for (let i = 0; i < pipelineCount; i++) {
      const id = graph.createPipeline(sink);
      graph.setSource(id, async function* () {
        tracker.enter();
        await delay(5);
        tracker.leave();
        yield i;
      });
    }
    return graph;
  }

  function makeTracker() {
    return {
      inFlight: 0,
      peak: 0,
      enter() { this.inFlight++; this.peak = Math.max(this.peak, this.inFlight); },
      leave() { this.inFlight--; },
    };
  }

  it('never runs more pipelines at once than its concurrency allows', async () => {
    const tracker = makeTracker();
    const graph = trackingGraph(10, tracker);

    await new TaskScheduler(3).schedule(graph);

    expect(tracker.peak).toBeLessThanOrEqual(3);
  });

  it('uses the full concurrency budget when enough work is ready', async () => {
    const tracker = makeTracker();
    const graph = trackingGraph(10, tracker);

    await new TaskScheduler(3).schedule(graph);

    expect(tracker.peak).toBe(3);
  });

  it('runs strictly one at a time when concurrency is one', async () => {
    const tracker = makeTracker();
    const graph = trackingGraph(5, tracker);

    await new TaskScheduler(1).schedule(graph);

    expect(tracker.peak).toBe(1);
  });

  it('treats a non-positive concurrency as one', async () => {
    const tracker = makeTracker();
    const graph = trackingGraph(4, tracker);

    await new TaskScheduler(0).schedule(graph);

    expect(tracker.peak).toBe(1);
  });

  it('completes every pipeline even when concurrency is below the ready count', async () => {
    const tracker = makeTracker();
    const graph = trackingGraph(9, tracker);

    await new TaskScheduler(2).schedule(graph);

    for (const pipeline of graph.pipelines.values()) {
      expect(pipeline.state).toBe('DONE');
    }
  });

  it('starts a dependent as soon as its own dependency finishes', async () => {
    const graph = new PipelineGraph();
    const sink = { async consume() {} };
    const order = [];

    const slow = graph.createPipeline(sink);
    const fast = graph.createPipeline(sink);
    const afterFast = graph.createPipeline(sink);

    graph.setSource(slow, async function* () { await delay(60); order.push('slow'); yield; });
    graph.setSource(fast, async function* () { order.push('fast'); yield; });
    graph.setSource(afterFast, async function* () { order.push('afterFast'); yield; });
    graph.addDependency(afterFast, fast);

    await new TaskScheduler(4).schedule(graph);

    expect(order.indexOf('afterFast')).toBeLessThan(order.indexOf('slow'));
  });

  it('cancels still-running pipelines when one fails', async () => {
    const graph = new PipelineGraph();
    const sink = { async consume() {} };

    const failing = graph.createPipeline(sink);
    const surviving = graph.createPipeline(sink);
    let survivingIterations = 0;

    graph.setSource(failing, async function* () {
      await delay(5);
      throw new Error('boom');
    });
    graph.setSource(surviving, async function* () {
      for (let i = 0; i < 50; i++) {
        survivingIterations++;
        await delay(5);
        yield i;
      }
    });

    await expect(new TaskScheduler(2).schedule(graph)).rejects.toThrow('boom');
    expect(graph.isCancelled(surviving)).toBe(true);
    expect(survivingIterations).toBeLessThan(50);
  });
});
