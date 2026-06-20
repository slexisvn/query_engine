import { NodeStatus } from './node-descriptor.js';
import type { NodeRoleValue } from './node-descriptor.js';
import { HeartbeatMonitor } from './heartbeat-monitor.js';
import { Config } from '../../config.js';
import type {
  NodeId,
  PartitionId,
  NodeCapacity,
  NodeDescriptorJSON,
  ClusterSnapshot,
} from '../distributed-types.js';

type NodeStatusValue = (typeof NodeStatus)[keyof typeof NodeStatus];

interface NodeDescriptorLike {
  nodeId: NodeId;
  host: string;
  port: number;
  role: NodeRoleValue;
  capacity: NodeCapacity;
  status: NodeStatusValue;
  canExecuteFragments(): boolean;
  hasPartition(partitionId: string | PartitionId): boolean;
  assignPartition(partitionId: string | PartitionId): void;
  toJSON(): NodeDescriptorJSON;
}

interface PartitionAssignmentLive {
  node: NodeDescriptorLike;
  partitionIds: PartitionId[];
}

interface ClusterManagerOptions {
  phiWindowSize?: number;
  phiThreshold?: number;
  heartbeatIntervalMs?: number;
}

type NodeFailureCallbackLive = (node: NodeDescriptorLike) => void;

type NodeJoinCallbackLive = (descriptor: NodeDescriptorLike) => void;

export class ClusterManager {
  _localNode: NodeDescriptorLike;
  _nodeMap: Map<NodeId, NodeDescriptorLike>;
  _failureCallbacks: NodeFailureCallbackLive[];
  _joinCallbacks: NodeJoinCallbackLive[];
  _heartbeat: HeartbeatMonitor;

  constructor(localNode: NodeDescriptorLike, options: ClusterManagerOptions = {}) {
    this._localNode = localNode;
    this._nodeMap = new Map();
    this._nodeMap.set(localNode.nodeId, localNode);
    this._failureCallbacks = [];
    this._joinCallbacks = [];

    this._heartbeat = new HeartbeatMonitor({
      windowSize: options.phiWindowSize || Config.phiAccrualWindowSize,
      threshold: options.phiThreshold || Config.phiAccrualThreshold,
      intervalMs: options.heartbeatIntervalMs || Config.heartbeatIntervalMs,
    });

    this._heartbeat.onStatusChange((nodeId: NodeId, status: NodeStatusValue) => {
      this._handleStatusChange(nodeId, status);
    });
  }

  get localNode(): NodeDescriptorLike {
    return this._localNode;
  }

  get nodeCount(): number {
    return this._nodeMap.size;
  }

  addNode(descriptor: NodeDescriptorLike): NodeDescriptorLike {
    const existing = this._nodeMap.get(descriptor.nodeId);
    if (existing) {
      existing.host = descriptor.host;
      existing.port = descriptor.port;
      existing.role = descriptor.role;
      existing.capacity = descriptor.capacity;
      existing.status = NodeStatus.ALIVE;
      return existing;
    }

    descriptor.status = NodeStatus.ALIVE;
    this._nodeMap.set(descriptor.nodeId, descriptor);
    for (const cb of this._joinCallbacks) {
      cb(descriptor);
    }
    return descriptor;
  }

  removeNode(nodeId: NodeId): boolean {
    if (nodeId === this._localNode.nodeId) return false;
    this._heartbeat.removeNode(nodeId);
    return this._nodeMap.delete(nodeId);
  }

  getNode(nodeId: NodeId): NodeDescriptorLike | null {
    return this._nodeMap.get(nodeId) || null;
  }

  getAliveNodes(): NodeDescriptorLike[] {
    const result: NodeDescriptorLike[] = [];
    for (const node of this._nodeMap.values()) {
      if (node.status !== NodeStatus.DEAD) {
        result.push(node);
      }
    }
    return result;
  }

  getWorkerNodes(): NodeDescriptorLike[] {
    const result: NodeDescriptorLike[] = [];
    for (const node of this._nodeMap.values()) {
      if (node.canExecuteFragments()) {
        result.push(node);
      }
    }
    return result;
  }

  getNodesForPartitions(partitionIds: PartitionId[]): Map<PartitionId, NodeDescriptorLike> {
    const mapping = new Map<PartitionId, NodeDescriptorLike>();
    for (const pid of partitionIds) {
      for (const node of this._nodeMap.values()) {
        if (node.hasPartition(pid) && node.status !== NodeStatus.DEAD) {
          mapping.set(pid, node);
          break;
        }
      }
    }
    return mapping;
  }

  getNodesByPartition(
    tableName: string,
    partitionIds: PartitionId[],
  ): Map<NodeId, PartitionAssignmentLive> {
    const nodeToPartitions = new Map<NodeId, PartitionAssignmentLive>();
    for (const pid of partitionIds) {
      const compositeKey = `${tableName}:${pid}`;
      for (const node of this._nodeMap.values()) {
        if (node.hasPartition(compositeKey) && node.status !== NodeStatus.DEAD) {
          let partitions = nodeToPartitions.get(node.nodeId);
          if (!partitions) {
            partitions = { node, partitionIds: [] };
            nodeToPartitions.set(node.nodeId, partitions);
          }
          partitions.partitionIds.push(pid);
          break;
        }
      }
    }
    return nodeToPartitions;
  }

  recordHeartbeat(nodeId: NodeId, timestamp: number): void {
    const node = this._nodeMap.get(nodeId);
    if (!node) return;
    if (node.status === NodeStatus.DEAD) {
      node.status = NodeStatus.ALIVE;
    }
    this._heartbeat.recordHeartbeat(nodeId, timestamp);
  }

  onNodeFailure(callback: NodeFailureCallbackLive): void {
    this._failureCallbacks.push(callback);
  }

  onNodeJoin(callback: NodeJoinCallbackLive): void {
    this._joinCallbacks.push(callback);
  }

  startMonitoring(): void {
    this._heartbeat.start();
  }

  stopMonitoring(): void {
    this._heartbeat.stop();
  }

  _handleStatusChange(nodeId: NodeId, newStatus: NodeStatusValue): void {
    const node = this._nodeMap.get(nodeId);
    if (!node) return;

    const prevStatus = node.status;
    if (prevStatus === newStatus) return;

    node.status = newStatus;

    if (newStatus === NodeStatus.DEAD && prevStatus !== NodeStatus.DEAD) {
      for (const cb of this._failureCallbacks) {
        cb(node);
      }
    }
  }

  assignPartition(nodeId: NodeId, partitionKey: string | PartitionId): void {
    const node = this._nodeMap.get(nodeId);
    if (node) {
      node.assignPartition(partitionKey);
    }
  }

  snapshot(): ClusterSnapshot {
    const nodes: NodeDescriptorJSON[] = [];
    for (const node of this._nodeMap.values()) {
      nodes.push(node.toJSON());
    }
    return { localNodeId: this._localNode.nodeId, nodes };
  }
}
