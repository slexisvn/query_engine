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

function seedCancelToken(sink: Sink, token: CancelToken): void {
  if (sink.cancelToken) return;
  const descriptor = Object.getOwnPropertyDescriptor(sink, 'cancelToken');
  if (descriptor && !descriptor.set && !descriptor.writable) return;
  sink.cancelToken = token;
}

export class PipelineGraph {
  pipelines: Map<number, Pipeline>;
  nextId: number;
  readonly cancelToken: CancelToken | null;

  constructor(cancelToken: CancelToken | null = null) {
    this.pipelines = new Map();
    this.nextId = 1;
    this.cancelToken = cancelToken;
  }

  createPipeline(sink: Sink): number {
    const id = this.nextId++;
    if (this.cancelToken) seedCancelToken(sink, this.cancelToken);
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
    for (const pipeline of this.pipelines.values()) {
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

export class QueryCancelledError extends Error {
  constructor(message: string = 'Query cancelled') {
    super(message);
    this.name = 'QueryCancelledError';
  }
}

export class CancelToken {
  cancelled: boolean;
  readonly parent: CancelToken | null;
  _detach: (() => void) | null;

  constructor(parent: CancelToken | null = null) {
    this.cancelled = false;
    this.parent = parent;
    this._detach = null;
  }

  static fromSignal(signal: AbortSignal): CancelToken {
    const token = new CancelToken();
    if (signal.aborted) {
      token.cancel();
      return token;
    }
    const onAbort = (): void => token.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    token._detach = () => signal.removeEventListener('abort', onAbort);
    return token;
  }

  cancel(): void {
    this.cancelled = true;
  }

  detach(): void {
    this._detach?.();
    this._detach = null;
  }

  get isCancelled(): boolean {
    return this.cancelled || (this.parent !== null && this.parent.isCancelled);
  }
}
