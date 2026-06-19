import type { DataChunk } from '../storage/chunk.js';
import type { ColumnValue, DataType } from '../storage/data-type.js';
import type { PipelineGraph, CancelToken } from './pipeline.js';

export type ColumnMapping = Map<string, number>;

export interface IntervalValue {
  value: number;
  unit: string;
  _isInterval: true;
}

export type EvalValue = ColumnValue | IntervalValue | undefined;

export type CompiledExpr = (chunk: DataChunk, rowIdx: number) => EvalValue;

export interface ExecColumn {
  name: string;
  dataType: DataType;
  tableAlias?: string;
  tableName?: string;
  alias?: string;
  outputName?: string;
}

export type ExecSchema = ExecColumn[];

export interface Sink {
  consume(chunk: DataChunk): Promise<void>;
  finalize?(): Promise<void>;
  init?(): Promise<void>;
  error?(err: Error): void;
  cancelToken?: CancelToken;
}

export interface CompiledPipeline {
  schema: ExecSchema;
  columnMapping: ColumnMapping;
  register(graph: PipelineGraph, currentPipelineId: number, currentSink: Sink): void;
}

export type SourceGenerator = () => AsyncGenerator<DataChunk>;
