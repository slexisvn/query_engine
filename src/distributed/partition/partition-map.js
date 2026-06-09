import { StrategyType, murmur3 } from './partition-strategy.js';

export class PartitionMap {
  constructor() {
    this._tables = new Map();
  }

  registerTable(tableName, strategy, partitionCount, placements) {
    const upper = tableName.toUpperCase();
    const placementMap = new Map();
    if (placements) {
      for (const [pid, nodeIds] of placements) {
        placementMap.set(pid, Array.isArray(nodeIds) ? [...nodeIds] : [nodeIds]);
      }
    }

    this._tables.set(upper, {
      strategy,
      partitionCount,
      partitionKey: strategy._partitionKey || null,
      placements: placementMap,
    });
  }

  getTableInfo(tableName) {
    return this._tables.get(tableName.toUpperCase()) || null;
  }

  getPartitionCount(tableName) {
    const info = this.getTableInfo(tableName);
    return info ? info.partitionCount : 0;
  }

  getPartitionsForNode(tableName, nodeId) {
    const info = this.getTableInfo(tableName);
    if (!info) return [];
    const result = [];
    for (const [pid, nodeIds] of info.placements) {
      if (nodeIds.includes(nodeId)) {
        result.push(pid);
      }
    }
    return result;
  }

  getNodesForPartition(tableName, partitionId) {
    const info = this.getTableInfo(tableName);
    if (!info) return [];
    return info.placements.get(partitionId) || [];
  }

  getAllPartitionIds(tableName) {
    const info = this.getTableInfo(tableName);
    if (!info) return [];
    return Array.from({ length: info.partitionCount }, (_, i) => i);
  }

  isColocated(tableA, tableB) {
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

  rebalance(tableName, newNodeIds) {
    const info = this.getTableInfo(tableName);
    if (!info) return new Map();

    const nodeCount = newNodeIds.length;
    if (nodeCount === 0) return new Map();

    const newPlacements = new Map();
    const ring = this._buildHashRing(newNodeIds, info.partitionCount);

    for (let pid = 0; pid < info.partitionCount; pid++) {
      const nodeId = ring.get(pid);
      newPlacements.set(pid, [nodeId]);
    }

    info.placements = newPlacements;
    return newPlacements;
  }

  _buildHashRing(nodeIds, partitionCount) {
    const ring = new Map();
    const sortedNodes = [...nodeIds].sort();

    for (let pid = 0; pid < partitionCount; pid++) {
      const idx = pid % sortedNodes.length;
      ring.set(pid, sortedNodes[idx]);
    }

    return ring;
  }

  computeMovements(tableName, oldPlacements, newPlacements) {
    const movements = [];
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

  snapshot() {
    const result = {};
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
