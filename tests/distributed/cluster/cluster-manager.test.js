import { describe, it, expect, beforeEach } from 'vitest';
import { ClusterManager } from '../../../src/distributed/cluster/cluster-manager.js';
import { NodeDescriptor, NodeRole, NodeStatus } from '../../../src/distributed/cluster/node-descriptor.js';

function makeNode(id, opts = {}) {
  return new NodeDescriptor({
    nodeId: id,
    host: opts.host || '127.0.0.1',
    port: opts.port || 9400,
    role: opts.role || NodeRole.WORKER,
    capacity: opts.capacity || { cores: 4, memoryMb: 8192 },
  });
}

describe('ClusterManager', () => {
  let local;
  let manager;

  beforeEach(() => {
    local = makeNode('coord-1', { role: NodeRole.COORDINATOR });
    manager = new ClusterManager(local, { heartbeatIntervalMs: 100000 });
  });

  it('starts with the local node', () => {
    expect(manager.nodeCount).toBe(1);
    expect(manager.localNode.nodeId).toBe('coord-1');
  });

  it('adds and retrieves nodes', () => {
    manager.addNode(makeNode('worker-1'));
    manager.addNode(makeNode('worker-2'));

    expect(manager.nodeCount).toBe(3);
    expect(manager.getNode('worker-1')).not.toBeNull();
    expect(manager.getNode('worker-2')).not.toBeNull();
  });

  it('returns null for unknown node', () => {
    expect(manager.getNode('ghost')).toBeNull();
  });

  it('removes nodes but not the local node', () => {
    manager.addNode(makeNode('worker-1'));
    expect(manager.removeNode('worker-1')).toBe(true);
    expect(manager.nodeCount).toBe(1);

    expect(manager.removeNode('coord-1')).toBe(false);
    expect(manager.nodeCount).toBe(1);
  });

  it('getAliveNodes excludes dead nodes', () => {
    const w1 = makeNode('worker-1');
    const w2 = makeNode('worker-2');
    manager.addNode(w1);
    manager.addNode(w2);

    w2.status = NodeStatus.DEAD;
    const alive = manager.getAliveNodes();
    expect(alive.length).toBe(2);
    expect(alive.every(n => n.nodeId !== 'worker-2')).toBe(true);
  });

  it('getWorkerNodes returns only executable nodes', () => {
    manager.addNode(makeNode('worker-1', { role: NodeRole.WORKER }));
    manager.addNode(makeNode('hybrid-1', { role: NodeRole.HYBRID }));

    const workers = manager.getWorkerNodes();
    expect(workers.length).toBe(2);
    expect(workers.map(w => w.nodeId).sort()).toEqual(['hybrid-1', 'worker-1']);
  });

  it('getWorkerNodes excludes dead workers', () => {
    const w = makeNode('worker-1');
    manager.addNode(w);
    w.status = NodeStatus.DEAD;

    expect(manager.getWorkerNodes().length).toBe(0);
  });

  it('fires onNodeFailure when node transitions to DEAD', () => {
    const failures = [];
    manager.onNodeFailure(node => failures.push(node.nodeId));

    const w = makeNode('worker-1');
    manager.addNode(w);

    manager._handleStatusChange('worker-1', NodeStatus.DEAD);
    expect(failures).toEqual(['worker-1']);
  });

  it('does not fire duplicate failure events', () => {
    const failures = [];
    manager.onNodeFailure(node => failures.push(node.nodeId));

    const w = makeNode('worker-1');
    manager.addNode(w);

    manager._handleStatusChange('worker-1', NodeStatus.DEAD);
    manager._handleStatusChange('worker-1', NodeStatus.DEAD);
    expect(failures.length).toBe(1);
  });

  it('fires onNodeJoin when new node is added', () => {
    const joins = [];
    manager.onNodeJoin(node => joins.push(node.nodeId));

    manager.addNode(makeNode('worker-1'));
    expect(joins).toEqual(['worker-1']);
  });

  it('updates existing node on re-add', () => {
    manager.addNode(makeNode('worker-1', { port: 9401 }));
    manager.addNode(makeNode('worker-1', { port: 9402 }));

    expect(manager.nodeCount).toBe(2);
    expect(manager.getNode('worker-1').port).toBe(9402);
  });

  it('assignPartition and getNodesForPartitions', () => {
    const w1 = makeNode('worker-1');
    const w2 = makeNode('worker-2');
    manager.addNode(w1);
    manager.addNode(w2);

    manager.assignPartition('worker-1', 'orders:0');
    manager.assignPartition('worker-1', 'orders:1');
    manager.assignPartition('worker-2', 'orders:2');

    const mapping = manager.getNodesByPartition('orders', [0, 1, 2]);
    expect(mapping.size).toBe(2);
  });

  it('recordHeartbeat revives dead node', () => {
    const w = makeNode('worker-1');
    manager.addNode(w);
    w.status = NodeStatus.DEAD;

    manager.recordHeartbeat('worker-1', Date.now());
    expect(w.status).toBe(NodeStatus.ALIVE);
  });

  it('snapshot captures cluster state', () => {
    manager.addNode(makeNode('worker-1'));
    const snap = manager.snapshot();

    expect(snap.localNodeId).toBe('coord-1');
    expect(snap.nodes.length).toBe(2);
  });
});
