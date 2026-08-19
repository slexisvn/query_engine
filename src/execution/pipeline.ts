import type { Sink, SourceGenerator } from './execution-types.js';

export type PipelineState = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface Pipeline {
  id: number;
  sink: Sink;
  source: SourceGenerator | null;
  dependencies: Set<number>;
  dependents: Set<number>;
  state: PipelineState;
  cancelled: boolean;
}

export class PipelineGraph {
  pipelines: Map<number, Pipeline>;
  nextId: number;

  constructor() {
    this.pipelines = new Map();
    this.nextId = 1;
  }

  createPipeline(sink: Sink): number {
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
    const pipeline = this.pipelines.get(pipelineId)!;
    const dependency = this.pipelines.get(dependsOnId)!;
    pipeline.dependencies.add(dependsOnId);
    dependency.dependents.add(pipelineId);
  }

  setSource(pipelineId: number, sourceGenerator: SourceGenerator): void {
    const pipeline = this.pipelines.get(pipelineId)!;
    pipeline.source = sourceGenerator;
  }

  getReadyPipelines(): Pipeline[] {
    const ready: Pipeline[] = [];
    for (const [id, pipeline] of this.pipelines.entries()) {
      if (pipeline.state === 'PENDING' && pipeline.dependencies.size === 0) {
        ready.push(pipeline);
      }
    }
    return ready;
  }

  markPipelineDone(pipelineId: number): void {
    const pipeline = this.pipelines.get(pipelineId)!;
    pipeline.state = 'DONE';

    for (const depId of pipeline.dependents) {
      const dependent = this.pipelines.get(depId)!;
      dependent.dependencies.delete(pipelineId);
    }
  }

  markPipelineFailed(pipelineId: number): void {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) return;
    pipeline.state = 'FAILED';
  }

  cancelPipeline(pipelineId: number): void {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline || pipeline.cancelled) return;
    pipeline.cancelled = true;
    if (pipeline.state === 'PENDING' || pipeline.state === 'RUNNING') {
      pipeline.state = 'CANCELLED';
    }
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
