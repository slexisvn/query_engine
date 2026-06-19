import { MEMORY_ROOT_PREFIX } from '../storage-constants.js';

export interface TempSpaceOptions {
  baseDir?: string;
}

export class MemoryTempSpace {
  rootDir: string;
  counters: Map<string, number>;

  constructor(options: TempSpaceOptions = {}) {
    this.rootDir = options.baseDir || MEMORY_ROOT_PREFIX;
    this.counters = new Map();
  }

  allocate(category: string, label: string): string {
    const seq = this.counters.get(category) || 0;
    this.counters.set(category, seq + 1);
    return `${this.rootDir}/${category}/${label}_${seq}`;
  }

  getRoot(): string {
    return this.rootDir;
  }

  cleanup(): void {
    this.counters.clear();
  }
}
