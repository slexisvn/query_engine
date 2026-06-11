import { MEMORY_ROOT_PREFIX } from '../storage-constants.js';

export class MemoryTempSpace {
  constructor(options = {}) {
    this.rootDir = options.baseDir || MEMORY_ROOT_PREFIX;
    this.counters = new Map();
  }

  allocate(category, label) {
    const seq = this.counters.get(category) || 0;
    this.counters.set(category, seq + 1);
    return `${this.rootDir}/${category}/${label}_${seq}`;
  }

  getRoot() {
    return this.rootDir;
  }

  cleanup() {
    this.counters.clear();
  }
}
