import fs from 'fs';
import os from 'os';
import path from 'path';

const DIR_PREFIX = 'query_engine';
const activeManagers = new Set();
let hooksRegistered = false;

function registerProcessHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  const cleanupAll = () => {
    for (const manager of activeManagers) {
      manager.cleanup();
    }
  };

  process.on('exit', cleanupAll);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      cleanupAll();
      process.exit();
    });
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reapStaleDirectories(baseDir) {
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }

  const pidPattern = new RegExp(`^${DIR_PREFIX}_(\\d+)_`);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(DIR_PREFIX + '_')) continue;
    const fullPath = path.join(baseDir, entry.name);
    const match = entry.name.match(pidPattern);
    if (match) {
      const pid = parseInt(match[1], 10);
      if (isProcessAlive(pid)) continue;
    }
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch {}
  }
}

export class TempDirectoryManager {
  constructor(options = {}) {
    this.baseDir = options.baseDir || os.tmpdir();
    const randomPart = Math.random().toString(36).substring(2, 10);
    this.rootName = `${DIR_PREFIX}_${process.pid}_${randomPart}`;
    this.rootDir = path.join(this.baseDir, this.rootName);
    this.counters = new Map();
    this.initialized = false;

    activeManagers.add(this);
    registerProcessHooks();
    reapStaleDirectories(this.baseDir);
  }

  allocate(category, label) {
    if (!this.initialized) {
      fs.mkdirSync(this.rootDir, { recursive: true });
      this.initialized = true;
    }

    const seq = this.counters.get(category) || 0;
    this.counters.set(category, seq + 1);

    const dirName = `${label}_${seq}`;
    const dirPath = path.join(this.rootDir, category, dirName);
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
  }

  getRootDir() {
    return this.rootDir;
  }

  cleanup() {
    activeManagers.delete(this);
    if (this.initialized && fs.existsSync(this.rootDir)) {
      fs.rmSync(this.rootDir, { recursive: true, force: true });
      this.initialized = false;
    }
  }
}
