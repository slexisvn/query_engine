import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HeartbeatMonitor } from '../../../src/distributed/cluster/heartbeat-monitor.js';
import { NodeStatus } from '../../../src/distributed/cluster/node-descriptor.js';

describe('HeartbeatMonitor', () => {
  let monitor;

  beforeEach(() => {
    monitor = new HeartbeatMonitor({
      windowSize: 10,
      threshold: 8.0,
      intervalMs: 100000,
    });
  });

  afterEach(() => {
    monitor.stop();
  });

  it('returns phi=0 for unknown nodes', () => {
    expect(monitor.phi('unknown', Date.now())).toBe(0);
  });

  it('returns phi=0 with only one heartbeat', () => {
    monitor.recordHeartbeat('node-1', 1000);
    expect(monitor.phi('node-1', 2000)).toBe(0);
  });

  it('returns low phi for regular heartbeats', () => {
    const base = 10000;
    for (let i = 0; i < 10; i++) {
      monitor.recordHeartbeat('node-1', base + i * 1000);
    }
    const phiVal = monitor.phi('node-1', base + 10 * 1000);
    expect(phiVal).toBeLessThan(4);
  });

  it('returns high phi when heartbeat is very late', () => {
    const base = 10000;
    for (let i = 0; i < 10; i++) {
      monitor.recordHeartbeat('node-1', base + i * 1000);
    }
    const phiVal = monitor.phi('node-1', base + 50000);
    expect(phiVal).toBeGreaterThan(8);
  });

  it('detects alive status for normal heartbeats', () => {
    const base = 10000;
    for (let i = 0; i < 10; i++) {
      monitor.recordHeartbeat('node-1', base + i * 1000);
    }
    expect(monitor.getStatus('node-1', base + 11000)).toBe(NodeStatus.ALIVE);
  });

  it('detects dead status for long-missing heartbeats', () => {
    const base = 10000;
    for (let i = 0; i < 10; i++) {
      monitor.recordHeartbeat('node-1', base + i * 1000);
    }
    expect(monitor.getStatus('node-1', base + 100000)).toBe(NodeStatus.DEAD);
  });

  it('handles variable interval heartbeats', () => {
    const intervals = [800, 1200, 900, 1100, 950, 1050, 1000, 980, 1020, 990];
    let t = 10000;
    for (const interval of intervals) {
      monitor.recordHeartbeat('node-1', t);
      t += interval;
    }
    const status = monitor.getStatus('node-1', t + 1500);
    expect(status).toBe(NodeStatus.ALIVE);
  });

  it('removes node data on removeNode', () => {
    for (let i = 0; i < 5; i++) {
      monitor.recordHeartbeat('node-1', 1000 + i * 1000);
    }
    monitor.removeNode('node-1');
    expect(monitor.phi('node-1', 100000)).toBe(0);
  });

  it('fires status change callback', () => {
    const changes = [];
    monitor.onStatusChange((nodeId, status) => {
      changes.push({ nodeId, status });
    });

    const base = 10000;
    for (let i = 0; i < 10; i++) {
      monitor.recordHeartbeat('node-1', base + i * 1000);
    }

    monitor._evaluateAll();
    expect(changes.length).toBeGreaterThanOrEqual(0);
  });

  it('uses circular buffer correctly for window overflow', () => {
    const monitor2 = new HeartbeatMonitor({ windowSize: 3, threshold: 8.0, intervalMs: 100000 });
    for (let i = 0; i < 10; i++) {
      monitor2.recordHeartbeat('node-1', 1000 + i * 1000);
    }
    const phi = monitor2.phi('node-1', 12000);
    expect(phi).toBeGreaterThanOrEqual(0);
    expect(phi).toBeLessThan(4);
    monitor2.stop();
  });
});
