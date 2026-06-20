import type {
  NodeId,
  NodeCapacity,
  NodeDescriptorJSON,
} from '../distributed-types.js';

export const NodeRole = {
  COORDINATOR: 'coordinator',
  WORKER: 'worker',
  HYBRID: 'hybrid',
} as const;

export type NodeRoleValue = (typeof NodeRole)[keyof typeof NodeRole];

export const NodeStatus = {
  ALIVE: 'alive',
  SUSPECT: 'suspect',
  DEAD: 'dead',
} as const;

export type NodeStatusValue = (typeof NodeStatus)[keyof typeof NodeStatus];

export interface NodeDescriptorParams {
  nodeId: NodeId;
  host: string;
  port: number;
  role?: NodeRoleValue;
  capacity?: NodeCapacity;
  status?: NodeStatusValue;
  partitions?: string[];
}

export class NodeDescriptor {
  nodeId: NodeId;
  host: string;
  port: number;
  role: NodeRoleValue;
  capacity: NodeCapacity;
  status: NodeStatusValue;
  partitions: Set<string>;

  constructor({ nodeId, host, port, role, capacity, status }: NodeDescriptorParams) {
    this.nodeId = nodeId;
    this.host = host;
    this.port = port;
    this.role = role || NodeRole.WORKER;
    this.capacity = capacity || { cores: 1, memoryMb: 512 };
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
      role: this.role as NodeDescriptorJSON['role'],
      capacity: this.capacity,
      status: this.status as NodeDescriptorJSON['status'],
      partitions: [...this.partitions],
    };
  }

  static fromJSON(json: NodeDescriptorJSON): NodeDescriptor {
    const desc = new NodeDescriptor(json as NodeDescriptorParams);
    if (json.partitions) {
      for (const p of json.partitions) {
        desc.partitions.add(p);
      }
    }
    return desc;
  }
}
