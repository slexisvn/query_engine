import type { AnyTypedArray, ColumnValue, DataType } from '../storage/data-type.js';

export interface ParallelFilterResult {
  selectionVector?: Uint32Array;
  matchCount: number;
}

export interface ParallelFilterArgs {
  value?: ColumnValue;
  low?: ColumnValue;
  high?: ColumnValue;
}

export interface ParallelExpressionDispatch {
  canParallelize(operation: string, dataType: DataType, count: number): boolean;
  filterParallel(
    data: AnyTypedArray,
    length: number,
    operation: string,
    dataType: DataType,
    args: ParallelFilterArgs,
  ): Promise<ParallelFilterResult | null>;
}

export interface WorkerPoolHandle {
  activeWorkerCount(): number;
}
