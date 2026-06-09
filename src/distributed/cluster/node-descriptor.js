export const NodeRole = {
  COORDINATOR: 'coordinator',
  WORKER: 'worker',
  HYBRID: 'hybrid',
};

export const NodeStatus = {
  ALIVE: 'alive',
  SUSPECT: 'suspect',
  DEAD: 'dead',
};

export class NodeDescriptor {
  constructor({ nodeId, host, port, role, capacity, status }) {
    this.nodeId = nodeId;
    this.host = host;
    this.port = port;
    this.role = role || NodeRole.WORKER;
    this.capacity = capacity || { cores: 1, memoryMb: 512 };
    this.status = status || NodeStatus.ALIVE;
    this.partitions = new Set();
  }

  get address() {
    return `${this.host}:${this.port}`;
  }

  isAlive() {
    return this.status === NodeStatus.ALIVE;
  }

  canExecuteFragments() {
    return this.status !== NodeStatus.DEAD
      && (this.role === NodeRole.WORKER || this.role === NodeRole.HYBRID);
  }

  canCoordinate() {
    return this.role === NodeRole.COORDINATOR || this.role === NodeRole.HYBRID;
  }

  assignPartition(partitionId) {
    this.partitions.add(partitionId);
  }

  removePartition(partitionId) {
    this.partitions.delete(partitionId);
  }

  hasPartition(partitionId) {
    return this.partitions.has(partitionId);
  }

  toJSON() {
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

  static fromJSON(json) {
    const desc = new NodeDescriptor(json);
    if (json.partitions) {
      for (const p of json.partitions) {
        desc.partitions.add(p);
      }
    }
    return desc;
  }
}
