export class PipelineGraph {
  constructor() {
    this.pipelines = new Map();
    this.nextId = 1;
  }

  createPipeline(sink) {
    const id = this.nextId++;
    this.pipelines.set(id, {
      id,
      sink,
      source: null,
      dependencies: new Set(),
      dependents: new Set(),
      state: 'PENDING', 
      cancelled: false,
    });
    return id;
  }

  addDependency(pipelineId, dependsOnId) {
    const pipeline = this.pipelines.get(pipelineId);
    const dependency = this.pipelines.get(dependsOnId);
    pipeline.dependencies.add(dependsOnId);
    dependency.dependents.add(pipelineId);
  }

  setSource(pipelineId, sourceGenerator) {
    const pipeline = this.pipelines.get(pipelineId);
    pipeline.source = sourceGenerator;
  }

  getReadyPipelines() {
    const ready = [];
    for (const [id, pipeline] of this.pipelines.entries()) {
      if (pipeline.state === 'PENDING' && pipeline.dependencies.size === 0) {
        ready.push(pipeline);
      }
    }
    return ready;
  }

  markPipelineDone(pipelineId) {
    const pipeline = this.pipelines.get(pipelineId);
    pipeline.state = 'DONE';

    for (const depId of pipeline.dependents) {
      const dependent = this.pipelines.get(depId);
      dependent.dependencies.delete(pipelineId);
    }
  }

  cancelPipeline(pipelineId) {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline || pipeline.cancelled) return;
    pipeline.cancelled = true;
  }

  isCancelled(pipelineId) {
    const pipeline = this.pipelines.get(pipelineId);
    return pipeline ? pipeline.cancelled : false;
  }
}

export class CancelToken {
  constructor() {
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  get isCancelled() {
    return this.cancelled;
  }
}
