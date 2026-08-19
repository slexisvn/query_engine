import type { DataType, ColumnValue } from '../storage/data-type.js';
import type { FragmentSpec, JoinSpec } from '../execution/fragment-spec.js';

export type FilterOperation =
  | 'filterEq'
  | 'filterLt'
  | 'filterGt'
  | 'filterLe'
  | 'filterGe'
  | 'filterBetween';

export type CompoundCombineOp = 'and' | 'or';

export type ScalarAggType = 'sum' | 'min' | 'max' | 'count';

export type WasmDataType = 'INT32' | 'FLOAT64' | 'DATE';

export type ProjectOp =
  | 'scalarAddF64'
  | 'scalarSubF64'
  | 'scalarMulF64'
  | 'scalarDivF64'
  | 'scalarSubRevF64'
  | 'scalarDivRevF64'
  | 'vecAddF64'
  | 'vecSubF64'
  | 'vecMulF64'
  | 'vecDivF64'
  | 'negF64'
  | 'widenI32ToF64';

export enum WorkerTaskType {
  FILTER = 'filter',
  AGGREGATE = 'aggregate',
  FILTER_COMPOUND = 'filter_compound',
  PIPELINE = 'pipeline',
  PROJECT = 'project',
}

export interface FilterDescriptor {
  operation: FilterOperation;
  value?: number;
  low?: number;
  high?: number;
}

export interface PipelineFilterStage {
  kind: 'filter';
  operation: FilterOperation;
  value?: number;
  low?: number;
  high?: number;
}

export interface PipelineAggregateStage {
  kind: 'aggregate';
  aggType: ScalarAggType;
}

export interface PipelineCountStage {
  kind: 'count';
}

export type PipelineStage =
  | PipelineFilterStage
  | PipelineAggregateStage
  | PipelineCountStage;

export interface FilterTask {
  type: WorkerTaskType.FILTER;
  dataOffset: number;
  count: number;
  operation: FilterOperation;
  dataType: WasmDataType;
  baseIndex: number;
  value?: number;
  low?: number;
  high?: number;
}

export interface AggregateTask {
  type: WorkerTaskType.AGGREGATE;
  dataOffset: number;
  count: number;
  aggType: ScalarAggType;
  dataType: WasmDataType;
}

export interface CompoundFilterTask {
  type: WorkerTaskType.FILTER_COMPOUND;
  dataOffset: number;
  count: number;
  filters: FilterDescriptor[];
  combineOp: CompoundCombineOp;
  dataType: WasmDataType;
  baseIndex: number;
}

export interface PipelineTask {
  type: WorkerTaskType.PIPELINE;
  dataOffset: number;
  count: number;
  dataType: WasmDataType;
  baseIndex: number;
  stages: PipelineStage[];
}

export interface ProjectTask {
  type: WorkerTaskType.PROJECT;
  dataOffset: number;
  dataBOffset?: number;
  count: number;
  op: ProjectOp;
  scalar?: number;
}

export type WorkerTask =
  | FilterTask
  | AggregateTask
  | CompoundFilterTask
  | PipelineTask
  | ProjectTask;

export type WorkerTaskMessage = WorkerTask & { taskId: number };

export interface ScalarAggregatePartial {
  aggType: ScalarAggType;
  result: number;
  count: number;
}

export interface SelectionVectorResult {
  matchCount: number;
  selectionVector?: Uint32Array;
}

export interface ScalarAggregateResult {
  result: number;
  count: number;
}

export interface PipelineAggregatesResult {
  aggregates: ScalarAggregatePartial[];
}

export interface ProjectResult {
  count: number;
  resultData?: Float64Array;
}

export type WorkerResultData =
  | SelectionVectorResult
  | ScalarAggregateResult
  | PipelineAggregatesResult
  | ProjectResult;

export interface WorkerResultForTask {
  [WorkerTaskType.FILTER]: SelectionVectorResult;
  [WorkerTaskType.AGGREGATE]: ScalarAggregateResult;
  [WorkerTaskType.FILTER_COMPOUND]: SelectionVectorResult;
  [WorkerTaskType.PIPELINE]: SelectionVectorResult & PipelineAggregatesResult;
  [WorkerTaskType.PROJECT]: ProjectResult;
}

export type TaskOfType<T extends WorkerTaskType> = Extract<WorkerTask, { type: T }>;

export interface WorkerReadyMessage {
  type: 'ready';
  workerId: number;
}

export interface WorkerResultMessage {
  type: 'result';
  taskId: number;
  data: WorkerResultData;
}

export interface WorkerErrorMessage {
  type: 'error';
  taskId: number;
  error: string;
}

export type WorkerOutboundMessage =
  | WorkerReadyMessage
  | WorkerResultMessage
  | WorkerErrorMessage;

export interface WorkerInitData {
  workerId: number;
  wasmModule: WebAssembly.Module;
  wasmMemory: WebAssembly.Memory;
  regionId: number;
  regionStart: number;
  regionCapacity: number;
}

export interface MorselSchedulerDescriptor {
  counterBuffer: SharedArrayBuffer;
  totalUnits: number;
  unitsPerMorsel: number;
}

export interface MorselRange {
  start: number;
  end: number;
}

export interface EncodedChunkSet {
  buffers: ArrayBufferLike[];
  meta: Uint32Array;
  sizes: Uint32Array;
  colCount: number;
}

export type AccumulatorState = ColumnValue | { sum: number; count: number } | ColumnValue[];

export interface PartialGroupRecord {
  key: string | number | bigint | boolean | null;
  groupValues: ColumnValue[];
  states: AccumulatorState[];
}

export interface SpillDescriptor {
  dir: string;
  tag: string;
  groupLimit: number;
}

export interface SpillRef {
  file: string;
  partition: number;
}

export interface JoinOutputTypes {
  build: DataType[];
  probe: DataType[];
}

export enum FragmentTaskType {
  AGGREGATE = 'aggregate',
  COMBINE = 'combine',
  JOIN_PARTITION = 'joinPartition',
  JOIN_PROBE = 'joinProbe',
}

export interface FragmentAggregateRequest {
  type: FragmentTaskType.AGGREGATE;
  spec: FragmentSpec;
  chunks: EncodedChunkSet;
  scheduler: MorselSchedulerDescriptor;
  partitionCount: number;
  spill: SpillDescriptor | null;
}

export interface FragmentCombineRequest {
  type: FragmentTaskType.COMBINE;
  spec: FragmentSpec;
  partials: PartialGroupRecord[][];
  spillRefs: SpillRef[];
}

export interface FragmentJoinPartitionRequest {
  type: FragmentTaskType.JOIN_PARTITION;
  spec: JoinSpec;
  buildChunks: EncodedChunkSet;
  probeChunks: EncodedChunkSet;
  buildScheduler: MorselSchedulerDescriptor;
  probeScheduler: MorselSchedulerDescriptor;
  partitionCount: number;
}

export interface FragmentJoinProbeRequest {
  type: FragmentTaskType.JOIN_PROBE;
  spec: JoinSpec;
  buildChunks: EncodedChunkSet;
  probeChunks: EncodedChunkSet;
  buildRefs: Uint32Array;
  probeRefs: Uint32Array;
  hasNullKey: boolean;
  outputTypes: JoinOutputTypes;
}

export type FragmentRequest =
  | FragmentAggregateRequest
  | FragmentCombineRequest
  | FragmentJoinPartitionRequest
  | FragmentJoinProbeRequest;

export type FragmentRequestMessage = FragmentRequest & { reqId: number };

export interface FragmentAggregateResult {
  partitions: PartialGroupRecord[][];
  spillFiles: string[];
}

export interface FragmentCombineResult {
  partials: PartialGroupRecord[];
}

export interface FragmentJoinPartitionResult {
  buildPartitions: Uint32Array[];
  buildNullCount: number;
  probePartitions: Uint32Array[];
  probeNullRows: ColumnValue[][];
  buildNullRows: ColumnValue[][];
}

export interface FragmentJoinProbeResult {
  chunks: EncodedChunkSet | null;
}

export type FragmentResult =
  | FragmentAggregateResult
  | FragmentCombineResult
  | FragmentJoinPartitionResult
  | FragmentJoinProbeResult;

export interface FragmentSuccessMessage {
  reqId: number;
  ok: true;
  partitions?: PartialGroupRecord[][];
  spillFiles?: string[];
  partials?: PartialGroupRecord[] | PartialGroupRecord[][];
  buildPartitions?: Uint32Array[];
  buildNullCount?: number;
  probePartitions?: Uint32Array[];
  probeNullRows?: ColumnValue[][];
  buildNullRows?: ColumnValue[][];
  chunks?: EncodedChunkSet | null;
}

export interface FragmentFailureMessage {
  reqId: number;
  ok: false;
  error: string;
}

export type FragmentReplyMessage = FragmentSuccessMessage | FragmentFailureMessage;
