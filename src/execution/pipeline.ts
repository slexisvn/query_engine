export class PipelineGraph {
  pipelines: Map<number, any>;
  nextId: number;

  constructor() {
    this.pipelines = new Map();
    this.nextId = 1;
  }

  createPipeline(sink: any): number {
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

  addDependency(pipelineId: number, dependsOnId: number): void {
    const pipeline = this.pipelines.get(pipelineId);
    const dependency = this.pipelines.get(dependsOnId);
    pipeline.dependencies.add(dependsOnId);
    dependency.dependents.add(pipelineId);
  }

  setSource(pipelineId: number, sourceGenerator: any): void {
    const pipeline = this.pipelines.get(pipelineId);
    pipeline.source = sourceGenerator;
  }

  getReadyPipelines(): any[] {
    const ready = [];
    for (const [id, pipeline] of this.pipelines.entries()) {
      if (pipeline.state === 'PENDING' && pipeline.dependencies.size === 0) {
        ready.push(pipeline);
      }
    }
    return ready;
  }

  markPipelineDone(pipelineId: number): void {
    const pipeline = this.pipelines.get(pipelineId);
    pipeline.state = 'DONE';

    for (const depId of pipeline.dependents) {
      const dependent = this.pipelines.get(depId);
      dependent.dependencies.delete(pipelineId);
    }
  }

  cancelPipeline(pipelineId: number): void {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline || pipeline.cancelled) return;
    pipeline.cancelled = true;
  }

  isCancelled(pipelineId: number): boolean {
    const pipeline = this.pipelines.get(pipelineId);
    return pipeline ? pipeline.cancelled : false;
  }
}

export class CancelToken {
  cancelled: boolean;

  constructor() {
    this.cancelled = false;
  }

  cancel(): void {
    this.cancelled = true;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }
}
