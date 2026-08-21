import { StrategyType, murmur3 } from './partition-strategy.js';
import type {
  NodeId,
  PartitionId,
  PartitionPlacements,
  PartitionMovement,
  PartitionMapSnapshot,
  StrategyType as StrategyTypeEnum,
} from '../distributed-types.js';

interface PartitionStrategyLike {
  readonly type: StrategyTypeEnum;
  readonly _partitionKey?: string | null;
}

interface StoredTableInfo {
  strategy: PartitionStrategyLike;
  partitionCount: number;
  partitionKey: string | null;
  placements: PartitionPlacements;
}

export class PartitionMap {
  private _tables: Map<string, StoredTableInfo>;
  private _replicated: Set<string>;

  constructor() {
    this._tables = new Map();
    this._replicated = new Set();
  }

  registerReplicatedTable(tableName: string): void {
    const upper = tableName.toUpperCase();
    this._tables.delete(upper);
    this._replicated.add(upper);
  }

  isReplicated(tableName: string): boolean {
    return this._replicated.has(tableName.toUpperCase());
  }

  registerTable(
    tableName: string,
    strategy: PartitionStrategyLike,
    partitionCount: number,
    placements?: Iterable<[PartitionId, NodeId | NodeId[]]> | null,
  ): void {
    const upper = tableName.toUpperCase();
    const placementMap: PartitionPlacements = new Map();
    if (placements) {
      for (const [pid, nodeIds] of placements) {
        placementMap.set(pid, Array.isArray(nodeIds) ? [...nodeIds] : [nodeIds]);
      }
    }

    this._replicated.delete(upper);
    this._tables.set(upper, {
      strategy,
      partitionCount,
      partitionKey: strategy._partitionKey || null,
      placements: placementMap,
    });
  }

  getTableInfo(tableName: string): StoredTableInfo | null {
    return this._tables.get(tableName.toUpperCase()) || null;
  }

  getPartitionCount(tableName: string): number {
    const info = this.getTableInfo(tableName);
    return info ? info.partitionCount : 0;
  }

  getPartitionsForNode(tableName: string, nodeId: NodeId): PartitionId[] {
    const info = this.getTableInfo(tableName);
    if (!info) return [];
    const result: PartitionId[] = [];
    for (const [pid, nodeIds] of info.placements) {
      if (nodeIds.includes(nodeId)) {
        result.push(pid);
      }
    }
    return result;
  }

  getNodesForPartition(tableName: string, partitionId: PartitionId): NodeId[] {
    const info = this.getTableInfo(tableName);
    if (!info) return [];
    return info.placements.get(partitionId) || [];
  }

  getAllPartitionIds(tableName: string): PartitionId[] {
    const info = this.getTableInfo(tableName);
    if (!info) return [];
    return Array.from({ length: info.partitionCount }, (_, i) => i);
  }

  isColocated(tableA: string, tableB: string): boolean {
    const infoA = this.getTableInfo(tableA);
    const infoB = this.getTableInfo(tableB);
    if (!infoA || !infoB) return false;

    if (infoA.strategy.type !== infoB.strategy.type) return false;
    if (infoA.strategy.type !== StrategyType.HASH) return false;
    if (infoA.partitionCount !== infoB.partitionCount) return false;

    for (let pid = 0; pid < infoA.partitionCount; pid++) {
      const nodesA = infoA.placements.get(pid) || [];
      const nodesB = infoB.placements.get(pid) || [];
      if (nodesA.length === 0 || nodesB.length === 0) continue;
      if (nodesA[0] !== nodesB[0]) return false;
    }

    return true;
  }

  rebalance(tableName: string, newNodeIds: NodeId[]): PartitionPlacements {
    const info = this.getTableInfo(tableName);
    if (!info) return new Map();

    const nodeCount = newNodeIds.length;
    if (nodeCount === 0) return new Map();

    const newPlacements: PartitionPlacements = new Map();
    const ring = this._buildHashRing(newNodeIds, info.partitionCount);

    for (let pid = 0; pid < info.partitionCount; pid++) {
      const nodeId = ring.get(pid);
      newPlacements.set(pid, [nodeId as NodeId]);
    }

    info.placements = newPlacements;
    return newPlacements;
  }

  _buildHashRing(nodeIds: NodeId[], partitionCount: number): Map<PartitionId, NodeId> {
    const ring = new Map<PartitionId, NodeId>();
    const sortedNodes = [...nodeIds].sort();

    for (let pid = 0; pid < partitionCount; pid++) {
      const idx = pid % sortedNodes.length;
      ring.set(pid, sortedNodes[idx]);
    }

    return ring;
  }

  computeMovements(
    tableName: string,
    oldPlacements: PartitionPlacements,
    newPlacements: PartitionPlacements,
  ): PartitionMovement[] {
    const movements: PartitionMovement[] = [];
    for (const [pid, newNodes] of newPlacements) {
      const oldNodes = oldPlacements.get(pid) || [];
      const oldPrimary = oldNodes[0];
      const newPrimary = newNodes[0];
      if (oldPrimary && newPrimary && oldPrimary !== newPrimary) {
        movements.push({ partitionId: pid, from: oldPrimary, to: newPrimary });
      }
    }
    return movements;
  }

  snapshot(): PartitionMapSnapshot {
    const result: PartitionMapSnapshot = {};
    for (const [tableName, info] of this._tables) {
      result[tableName] = {
        strategyType: info.strategy.type,
        partitionCount: info.partitionCount,
        placements: Object.fromEntries(info.placements),
      };
    }
    return result;
  }
}
