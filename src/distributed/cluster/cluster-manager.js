import { NodeStatus } from './node-descriptor.js';
import { HeartbeatMonitor } from './heartbeat-monitor.js';
import { Config } from '../../config.js';

export class ClusterManager {
  constructor(localNode, options = {}) {
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

    this._heartbeat.onStatusChange((nodeId, status) => {
      this._handleStatusChange(nodeId, status);
    });
  }

  get localNode() {
    return this._localNode;
  }

  get nodeCount() {
    return this._nodeMap.size;
  }

  addNode(descriptor) {
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

  removeNode(nodeId) {
    if (nodeId === this._localNode.nodeId) return false;
    this._heartbeat.removeNode(nodeId);
    return this._nodeMap.delete(nodeId);
  }

  getNode(nodeId) {
    return this._nodeMap.get(nodeId) || null;
  }

  getAliveNodes() {
    const result = [];
    for (const node of this._nodeMap.values()) {
      if (node.status !== NodeStatus.DEAD) {
        result.push(node);
      }
    }
    return result;
  }

  getWorkerNodes() {
    const result = [];
    for (const node of this._nodeMap.values()) {
      if (node.canExecuteFragments()) {
        result.push(node);
      }
    }
    return result;
  }

  getNodesForPartitions(partitionIds) {
    const mapping = new Map();
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

  getNodesByPartition(tableName, partitionIds) {
    const nodeToPartitions = new Map();
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

  recordHeartbeat(nodeId, timestamp) {
    const node = this._nodeMap.get(nodeId);
    if (!node) return;
    if (node.status === NodeStatus.DEAD) {
      node.status = NodeStatus.ALIVE;
    }
    this._heartbeat.recordHeartbeat(nodeId, timestamp);
  }

  onNodeFailure(callback) {
    this._failureCallbacks.push(callback);
  }

  onNodeJoin(callback) {
    this._joinCallbacks.push(callback);
  }

  startMonitoring() {
    this._heartbeat.start();
  }

  stopMonitoring() {
    this._heartbeat.stop();
  }

  _handleStatusChange(nodeId, newStatus) {
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

  assignPartition(nodeId, partitionKey) {
    const node = this._nodeMap.get(nodeId);
    if (node) {
      node.assignPartition(partitionKey);
    }
  }

  snapshot() {
    const nodes = [];
    for (const node of this._nodeMap.values()) {
      nodes.push(node.toJSON());
    }
    return { localNodeId: this._localNode.nodeId, nodes };
  }
}
