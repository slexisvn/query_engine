import type { LogicalPlanNode } from '../planner/logical-plan.js';
import type { ExecutionCatalog } from './execution-catalog.js';
import { ExecutionResources, type StorageBackendLike, type TempManagerLike } from './execution-resources.js';
import { ExecutionContext, type ExecutionContextOptions } from './execution-context.js';
import type { ResultSink } from './result-sink.js';
import type { ExecColumn } from './execution-types.js';

interface ExecuteResult {
  sink: ResultSink;
  columnNames: string[];
}

export interface ExecuteOptions extends ExecutionContextOptions {
  streaming?: boolean;
}

export class QueryExecutor {
  readonly resources: ExecutionResources;

  constructor(catalog: ExecutionCatalog, tempManager: TempManagerLike, storageBackend: StorageBackendLike | null = null) {
    this.resources = new ExecutionResources(catalog, tempManager, storageBackend);
  }

  newContext(options: ExecutionContextOptions = {}): ExecutionContext {
    return new ExecutionContext(this.resources, options);
  }

  async execute(logicalPlan: LogicalPlanNode, outputColumns: ExecColumn[], options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const { streaming = false, ...contextOptions } = options;
    const sink = await this.newContext(contextOptions).run(logicalPlan, streaming);
    return { sink, columnNames: outputColumns.map((c: ExecColumn) => c.name) };
  }
}
