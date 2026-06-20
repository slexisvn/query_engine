import type { LogicalPlanNode, PlanNodeType } from '../planner/logical-plan.js';
import type { DataChunk } from '../storage/chunk.js';
import type { ColumnValue, DataType } from '../storage/data-type.js';
import type { BoundExpr } from '../binder/expression-binder.js';
import type { ExecSchema, ExecColumn } from '../execution/execution-types.js';
import type { FragmentSpec, JoinSpec } from '../execution/fragment-spec.js';

export type NodeId = string;
export type ChannelId = string;
export type FragmentId = number;
export type PartitionId = number;

export enum NodeRole {
  COORDINATOR = 'coordinator',
  WORKER = 'worker',
  HYBRID = 'hybrid',
}

export enum NodeStatus {
  ALIVE = 'alive',
  SUSPECT = 'suspect',
  DEAD = 'dead',
}

export enum StrategyType {
  HASH = 'hash',
  RANGE = 'range',
  ROUND_ROBIN = 'round_robin',
}

export enum DistributionStrategy {
  COLOCATED = 'colocated',
  BROADCAST_LEFT = 'broadcast_left',
  BROADCAST_RIGHT = 'broadcast_right',
  SHUFFLE = 'shuffle',
}

export enum ExchangeType {
  HASH_SHUFFLE = 'hash_shuffle',
  BROADCAST = 'broadcast',
  GATHER = 'gather',
  PASSTHROUGH = 'passthrough',
}

export enum FragmentState {
  PENDING = 'pending',
  DISPATCHED = 'dispatched',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface NodeCapacity {
  cores: number;
  memoryMb: number;
}

export interface NodeDescriptorJSON {
  nodeId: NodeId;
  host: string;
  port: number;
  role: NodeRole;
  capacity: NodeCapacity;
  status: NodeStatus;
  partitions: string[];
}

export interface NodeAddress {
  host: string;
  port: number;
}

export interface ClusterSnapshot {
  localNodeId: NodeId;
  nodes: NodeDescriptorJSON[];
}

export interface PartitionAssignment {
  node: NodeDescriptorJSON;
  partitionIds: PartitionId[];
}

export type NodeStatusChange = (nodeId: NodeId, status: NodeStatus) => void;

export type NodeFailureCallback = (node: NodeDescriptorJSON) => void;

export type NodeJoinCallback = (descriptor: NodeDescriptorJSON) => void;

export interface NodeRegistration {
  nodeId: NodeId;
  host: string;
  port: number;
  role: NodeRole;
  capacity: NodeCapacity;
  partitions: string[];
}

export interface RegisterAck {
  ok: boolean;
}

export interface HeartbeatMessage {
  nodeId: NodeId;
  timestamp: number;
}

export interface HeartbeatAck {
  ts: number;
}

export interface StatusResponse {
  status: 'alive';
  nodeId: NodeId | null;
}

export const CHUNK_HEADER_MAGIC = 0x51454348;

export interface EncodedChunkColumnHeader {
  typeId: number;
  isDictionary: boolean;
  payloadSize: number;
}

export interface EncodedChunkEnvelope {
  magic: typeof CHUNK_HEADER_MAGIC;
  columnCount: number;
  rowCount: number;
  columns: EncodedChunkColumnHeader[];
}

export interface DecodedColumnMeta {
  dataType: DataType;
  isDictionary: boolean;
  payloadSize: number;
}

export interface ExchangeChunkMessage {
  channelId: ChannelId;
  sourceNodeId: NodeId;
  encodedChunk: Buffer;
}

export type ChunkReceivedCallback = (sourceNodeId: NodeId, encodedChunk: Buffer) => void;

export interface PendingChunk {
  sourceNodeId: NodeId;
  data: Buffer;
}

export enum ControlMessageType {
  CANCEL_FRAGMENT = 'cancel_fragment',
  FRAGMENT_COMPLETED = 'fragment_completed',
  FRAGMENT_FAILED = 'fragment_failed',
}

export interface CancelFragmentMessage {
  type: ControlMessageType.CANCEL_FRAGMENT;
  fragmentId: FragmentId;
}

export interface FragmentCompletedMessage {
  type: ControlMessageType.FRAGMENT_COMPLETED;
  fragmentId: FragmentId;
  nodeId: NodeId;
}

export interface FragmentFailedMessage {
  type: ControlMessageType.FRAGMENT_FAILED;
  fragmentId: FragmentId;
  error: string;
}

export type ControlMessage =
  | CancelFragmentMessage
  | FragmentCompletedMessage
  | FragmentFailedMessage;

export type ControlMessageCallback = (message: ControlMessage) => void;

export type FragmentReceivedCallback = (fragment: FragmentDispatchJSON) => void;

export interface ExchangeInput {
  sourceFragmentId: FragmentId;
  exchangeType: ExchangeType;
  keys?: BoundExpr[];
  ordered?: boolean;
  orderKeys?: DistributedOrderKey[];
}

export interface GatherPartitioning {
  exchangeType: ExchangeType.GATHER;
  partitionCount: number;
  targetNodes?: NodeId[];
}

export interface BroadcastPartitioning {
  exchangeType: ExchangeType.BROADCAST;
  targetNodes: NodeId[];
  partitionCount?: number;
}

export interface HashShufflePartitioning {
  exchangeType: ExchangeType.HASH_SHUFFLE;
  partitionCount: number;
  targetNodes: NodeId[];
  keyColumns: number[];
}

export type OutputPartitioning =
  | GatherPartitioning
  | BroadcastPartitioning
  | HashShufflePartitioning;

export interface DistributedOrderKey {
  expr?: BoundExpr;
  columnIndex?: number;
  direction?: string;
}

export interface FragmentDispatchJSON {
  fragmentId: FragmentId;
  planRoot: LogicalPlanNode;
  targetNodes: NodeId[];
  exchangeInputs: ExchangeInput[];
  outputPartitioning: OutputPartitioning | null;
  estimatedCardinality: number;
  state: FragmentState;
  coordinatorNodeId?: NodeId;
}

export interface FragmentExecutionResult {
  fragmentId: FragmentId;
  state: FragmentState.COMPLETED | FragmentState.FAILED;
  rowCount: number;
}

export interface OutputConfig {
  targetNodes: NodeId[];
  exchangeType: ExchangeType;
  partitionCount?: number;
  keyColumns?: number[];
  channelId: ChannelId;
  keyExtractors?: KeyExtractor[];
}

export type KeyExtractor = (chunk: DataChunk, rowIdx: number) => ColumnValue;

export interface ExchangeSenderOptions {
  exchangeType: ExchangeType;
  keyExtractors: KeyExtractor[];
  partitionCount: number;
  channelId: ChannelId;
}

export interface ExchangeReceiverOptions {
  channelId: ChannelId;
}

export interface MergeExchangeOptions {
  orderKeys: DistributedOrderKey[];
  limit: number | null;
  channelId: ChannelId;
}

export interface PartitionTableInfo {
  strategyType: StrategyType;
  partitionCount: number;
  partitionKey: string | null;
  placements: Map<PartitionId, NodeId[]>;
}

export interface PartitionTableSnapshot {
  strategyType: StrategyType;
  partitionCount: number;
  placements: Record<string, NodeId[]>;
}

export type PartitionMapSnapshot = Record<string, PartitionTableSnapshot>;

export type PartitionPlacements = Map<PartitionId, NodeId[]>;

export interface PartitionMovement {
  partitionId: PartitionId;
  from: NodeId;
  to: NodeId;
}

export type PrunedPartitionSet = Set<PartitionId>;

export interface RangeBoundarySpec {
  type: StrategyType.RANGE;
  boundaries: ColumnValue[];
}

export interface HashStrategySpec {
  type: StrategyType.HASH;
  seed: number;
}

export interface RoundRobinStrategySpec {
  type: StrategyType.ROUND_ROBIN;
}

export type PartitionStrategySpec =
  | HashStrategySpec
  | RangeBoundarySpec
  | RoundRobinStrategySpec;

export interface PartitionKeyRef {
  col: BoundExpr;
  side: 'left' | 'right';
}

export interface JoinShuffleKeys {
  leftKeys: BoundExpr[];
  rightKeys: BoundExpr[];
}

export interface JoinShuffleKeyIndices {
  leftIdx: number[];
  rightIdx: number[];
}

export interface PassthroughSideExchange {
  type: ExchangeType.PASSTHROUGH;
}

export interface BroadcastSideExchange {
  type: ExchangeType.BROADCAST;
}

export interface ShuffleSideExchange {
  type: ExchangeType.HASH_SHUFFLE;
  keys: BoundExpr[];
  partitionCount: number;
}

export type SideExchange =
  | PassthroughSideExchange
  | BroadcastSideExchange
  | ShuffleSideExchange;

export interface JoinExchangePlacement {
  left: SideExchange;
  right: SideExchange;
}

export interface GatherAggregateExchange {
  type: ExchangeType.GATHER;
}

export interface ShuffleAggregateExchange {
  type: ExchangeType.HASH_SHUFFLE;
  keys: BoundExpr[];
  partitionCount: number;
}

export type AggregateExchange =
  | GatherAggregateExchange
  | ShuffleAggregateExchange;

export interface SortExchange {
  type: ExchangeType.GATHER;
  ordered: true;
  orderKeys: DistributedOrderKey[];
}

export interface AggregateDecomposition {
  partial: string;
  final: string;
}

export interface DistributedScanSchemaColumn {
  name: string;
  dataType: DataType | string;
  tableAlias: string;
}

export type DistributedScanSchema = DistributedScanSchemaColumn[];

export interface FragmentProcessResult {
  plan: LogicalPlanNode;
  exchangeInputs: ExchangeInput[];
  workerNodes: NodeId[];
}

export interface GatherPlacementResult {
  plan: LogicalPlanNode;
  exchangeInputs: ExchangeInput[];
}

export interface FragmentizeContext {
  coordinatorId: NodeId;
}

export enum QueryStatus {
  RUNNING = 'running',
  CANCELLED = 'cancelled',
}

export interface FragmentStatusSummary {
  fragmentId: FragmentId;
  state: FragmentState;
  assignedNode: NodeId | null;
}

export interface QueryStatusReport {
  queryId: number;
  status: QueryStatus;
  elapsed: number;
  fragments: FragmentStatusSummary[];
}

export interface DistributedQueryResult {
  rows: ColumnValue[][];
  columns: string[];
}

export type DistributedPlanNodeType =
  | PlanNodeType.EXCHANGE
  | PlanNodeType.PARTIAL_AGGREGATE
  | PlanNodeType.FINAL_AGGREGATE
  | PlanNodeType.MERGE_EXCHANGE
  | PlanNodeType.EXCHANGE_RECEIVE;

export interface WorkerFragmentSpec {
  fragmentId: FragmentId;
  spec: FragmentSpec;
  joinSpec: JoinSpec | null;
  schema: ExecSchema;
}

export interface ExchangeChannelSchema {
  channelId: ChannelId;
  schema: ExecColumn[];
}
