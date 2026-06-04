export class TaskScheduler {
  constructor(concurrency = 4) {
    this.concurrency = concurrency;
  }

  async schedule(pipelineGraph) {
    let hasMoreWork = true;

    while (hasMoreWork) {
      const readyPipelines = pipelineGraph.getReadyPipelines();

      if (readyPipelines.length === 0) {
        let pendingCount = 0;
        for (const p of pipelineGraph.pipelines.values()) {
          if (p.state === 'PENDING') pendingCount++;
        }

        if (pendingCount > 0) {
          throw new Error('Pipeline deadlock detected: pending pipelines with unresolved dependencies.');
        }

        break; 
      }

      for (const p of readyPipelines) {
        p.state = 'RUNNING';
      }

      await this.executePipelines(readyPipelines, pipelineGraph);

      for (const p of readyPipelines) {
        pipelineGraph.markPipelineDone(p.id);
      }
    }
  }

  async executePipelines(pipelines, graph) {
    const tasks = [];
    for (const p of pipelines) {
      if (p.source) {
        tasks.push(this.runPipelineSource(p, graph));
      }
    }

    await Promise.all(tasks);
  }

  async runPipelineSource(pipeline, graph) {
    const generator = pipeline.source();
    for await (const _ of generator) {
      if (pipeline.cancelled) break;
    }
  }
}
