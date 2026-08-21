import { Config } from '../../config.js';
import { NodeRole, NodeStatus } from '../distributed-types.js';
import type {
  NodeId,
  NodeCapacity,
  NodeDescriptorJSON,
} from '../distributed-types.js';

export { NodeRole, NodeStatus };

export interface NodeDescriptorParams {
  nodeId: NodeId;
  host: string;
  port: number;
  role?: NodeRole;
  capacity?: NodeCapacity;
  status?: NodeStatus;
  partitions?: string[];
}

export class NodeDescriptor {
  nodeId: NodeId;
  host: string;
  port: number;
  role: NodeRole;
  capacity: NodeCapacity;
  status: NodeStatus;
  partitions: Set<string>;

  constructor({ nodeId, host, port, role, capacity, status }: NodeDescriptorParams) {
    this.nodeId = nodeId;
    this.host = host;
    this.port = port;
    this.role = role || NodeRole.WORKER;
    this.capacity = capacity || { cores: Config.defaultNodeCores, memoryMb: Config.defaultNodeMemoryMb };
    this.status = status || NodeStatus.ALIVE;
    this.partitions = new Set();
  }

  get address(): string {
    return `${this.host}:${this.port}`;
  }

  isAlive(): boolean {
    return this.status === NodeStatus.ALIVE;
  }

  canExecuteFragments(): boolean {
    return this.status !== NodeStatus.DEAD
      && (this.role === NodeRole.WORKER || this.role === NodeRole.HYBRID);
  }

  canCoordinate(): boolean {
    return this.role === NodeRole.COORDINATOR || this.role === NodeRole.HYBRID;
  }

  assignPartition(partitionId: string): void {
    this.partitions.add(partitionId);
  }

  removePartition(partitionId: string): void {
    this.partitions.delete(partitionId);
  }

  hasPartition(partitionId: string): boolean {
    return this.partitions.has(partitionId);
  }

  toJSON(): NodeDescriptorJSON {
    return {
      nodeId: this.nodeId,
      host: this.host,
      port: this.port,
      role: this.role,
      capacity: this.capacity,
      status: this.status,
      partitions: [...this.partitions],
    };
  }

  static fromJSON(json: NodeDescriptorJSON): NodeDescriptor {
    const desc = new NodeDescriptor(json);
    if (json.partitions) {
      for (const p of json.partitions) {
        desc.partitions.add(p);
      }
    }
    return desc;
  }
}
