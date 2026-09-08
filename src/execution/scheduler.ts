import { Config } from '../config.js';
import { yieldToEventLoop } from '../runtime/platform.js';
import { QueryCancelledError } from './pipeline.js';
import type { CancelToken, PipelineGraph, Pipeline } from './pipeline.js';

interface PipelineOutcome {
  id: number;
  error: unknown;
}

export class TaskScheduler {
  concurrency: number;

  constructor(concurrency: number = Config.pipelineConcurrency) {
    this.concurrency = Math.max(1, concurrency);
  }

  async schedule(pipelineGraph: PipelineGraph, cancelToken: CancelToken | null = null): Promise<void> {
    const running = new Map<number, Promise<PipelineOutcome>>();

    for (;;) {
      if (cancelToken?.isCancelled) {
        this.cancelRunning(pipelineGraph, running);
        throw new QueryCancelledError();
      }

      this.startReadyPipelines(pipelineGraph, running, cancelToken);

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

  startReadyPipelines(pipelineGraph: PipelineGraph, running: Map<number, Promise<PipelineOutcome>>, cancelToken: CancelToken | null = null): void {
    for (const pipeline of pipelineGraph.getReadyPipelines()) {
      if (running.size >= this.concurrency) return;
      pipeline.state = 'RUNNING';
      running.set(pipeline.id, this.runPipeline(pipeline, cancelToken));
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

  async runPipeline(pipeline: Pipeline, cancelToken: CancelToken | null = null): Promise<PipelineOutcome> {
    try {
      await this.drainSource(pipeline, cancelToken);
      return { id: pipeline.id, error: null };
    } catch (error) {
      return { id: pipeline.id, error };
    }
  }

  async drainSource(pipeline: Pipeline, cancelToken: CancelToken | null = null): Promise<void> {
    if (!pipeline.source) return;
    let nextPollAt = Date.now() + Config.cancelPollMs;
    for await (const _ of pipeline.source()) {
      if (pipeline.cancelled || cancelToken?.isCancelled) return;
      if (cancelToken && Date.now() >= nextPollAt) {
        await yieldToEventLoop();
        nextPollAt = Date.now() + Config.cancelPollMs;
        if (cancelToken.isCancelled) return;
      }
    }
  }
}
