import { Config } from '../config.js';
import type { PipelineGraph, Pipeline } from './pipeline.js';

interface PipelineOutcome {
  id: number;
  error: unknown;
}

export class TaskScheduler {
  concurrency: number;

  constructor(concurrency: number = Config.pipelineConcurrency) {
    this.concurrency = Math.max(1, concurrency);
  }

  async schedule(pipelineGraph: PipelineGraph): Promise<void> {
    const running = new Map<number, Promise<PipelineOutcome>>();

    for (;;) {
      this.startReadyPipelines(pipelineGraph, running);

      if (running.size === 0) {
        if (this.countPending(pipelineGraph) > 0) {
          throw new Error('Pipeline deadlock detected: pending pipelines with unresolved dependencies.');
        }
        return;
      }

      const outcome = await Promise.race(running.values());
      running.delete(outcome.id);

      if (outcome.error) {
        pipelineGraph.markPipelineFailed(outcome.id);
        this.cancelRunning(pipelineGraph, running);
        throw outcome.error;
      }

      pipelineGraph.markPipelineDone(outcome.id);
    }
  }

  startReadyPipelines(pipelineGraph: PipelineGraph, running: Map<number, Promise<PipelineOutcome>>): void {
    for (const pipeline of pipelineGraph.getReadyPipelines()) {
      if (running.size >= this.concurrency) return;
      pipeline.state = 'RUNNING';
      running.set(pipeline.id, this.runPipeline(pipeline));
    }
  }

  cancelRunning(pipelineGraph: PipelineGraph, running: Map<number, Promise<PipelineOutcome>>): void {
    for (const id of running.keys()) pipelineGraph.cancelPipeline(id);
  }

  countPending(pipelineGraph: PipelineGraph): number {
    let pending = 0;
    for (const pipeline of pipelineGraph.pipelines.values()) {
      if (pipeline.state === 'PENDING') pending++;
    }
    return pending;
  }

  async runPipeline(pipeline: Pipeline): Promise<PipelineOutcome> {
    try {
      await this.drainSource(pipeline);
      return { id: pipeline.id, error: null };
    } catch (error) {
      return { id: pipeline.id, error };
    }
  }

  async drainSource(pipeline: Pipeline): Promise<void> {
    if (!pipeline.source) return;
    for await (const _ of pipeline.source()) {
      if (pipeline.cancelled) return;
    }
  }
}
