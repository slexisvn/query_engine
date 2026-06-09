import { Config } from '../../config.js';
import { NodeStatus } from './node-descriptor.js';

export class HeartbeatMonitor {
  constructor(options = {}) {
    this._windowSize = options.windowSize || Config.phiAccrualWindowSize;
    this._threshold = options.threshold || Config.phiAccrualThreshold;
    this._interval = options.intervalMs || Config.heartbeatIntervalMs;
    this._windows = new Map();
    this._timer = null;
    this._sendFn = null;
    this._statusCallback = null;
  }

  onSend(fn) {
    this._sendFn = fn;
  }

  onStatusChange(callback) {
    this._statusCallback = callback;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this._interval);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  recordHeartbeat(nodeId, timestamp) {
    let window = this._windows.get(nodeId);
    if (!window) {
      window = new ArrivalWindow(this._windowSize);
      this._windows.set(nodeId, window);
    }
    window.record(timestamp);
  }

  phi(nodeId, now) {
    const window = this._windows.get(nodeId);
    if (!window || window.size < 2) return 0;
    return window.phi(now);
  }

  getStatus(nodeId, now) {
    const phiValue = this.phi(nodeId, now);
    if (phiValue >= this._threshold * 2) return NodeStatus.DEAD;
    if (phiValue >= this._threshold) return NodeStatus.SUSPECT;
    return NodeStatus.ALIVE;
  }

  removeNode(nodeId) {
    this._windows.delete(nodeId);
  }

  _tick() {
    if (this._sendFn) {
      this._sendFn();
    }
    this._evaluateAll();
  }

  _evaluateAll() {
    if (!this._statusCallback) return;
    const now = Date.now();
    for (const [nodeId, window] of this._windows) {
      if (window.size < 2) continue;
      const status = this.getStatus(nodeId, now);
      this._statusCallback(nodeId, status);
    }
  }
}

class ArrivalWindow {
  constructor(maxSize) {
    this._maxSize = maxSize;
    this._buffer = new Float64Array(maxSize);
    this._head = 0;
    this._count = 0;
    this._lastTimestamp = 0;
    this._meanAccum = 0;
    this._varianceAccum = 0;
  }

  get size() {
    return this._count;
  }

  record(timestamp) {
    if (this._lastTimestamp > 0) {
      const interval = timestamp - this._lastTimestamp;
      this._addInterval(interval);
    }
    this._lastTimestamp = timestamp;
  }

  phi(now) {
    if (this._count < 1) return 0;
    const elapsed = now - this._lastTimestamp;
    const mean = this._meanAccum / this._count;
    const variance = this._count > 1
      ? this._varianceAccum / (this._count - 1)
      : mean * mean;
    const stddev = Math.sqrt(variance);
    if (stddev === 0) {
      return elapsed > mean * 2 ? 16 : 0;
    }
    return this._computePhi(elapsed, mean, stddev);
  }

  _addInterval(interval) {
    if (this._count >= this._maxSize) {
      const oldIdx = (this._head) % this._maxSize;
      const oldVal = this._buffer[oldIdx];
      this._removeFromStats(oldVal);
      this._buffer[oldIdx] = interval;
      this._head = (this._head + 1) % this._maxSize;
      this._addToStats(interval);
    } else {
      const idx = (this._head + this._count) % this._maxSize;
      this._buffer[idx] = interval;
      this._count++;
      this._addToStats(interval);
    }
  }

  _addToStats(value) {
    this._meanAccum += value;
    this._varianceAccum += value * value;
  }

  _removeFromStats(value) {
    this._meanAccum -= value;
    this._varianceAccum -= value * value;
  }

  _computePhi(elapsed, mean, stddev) {
    const y = (elapsed - mean) / stddev;
    const cdf = 1 / (1 + Math.exp(-y * 1.5976));
    const pLater = 1 - cdf;
    return pLater > 0 ? -Math.log10(pLater) : 16;
  }
}
