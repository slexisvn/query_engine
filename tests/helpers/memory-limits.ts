import { Config } from '../../src/config.js';
import { rowByteWidth } from '../../src/execution/memory-budget.js';

export function bytesForRows(schema, rowCount) {
  return rowByteWidth(schema) * rowCount;
}

export function limitResidentRows(schema, rowCount) {
  Config.memoryLimitBytes = bytesForRows(schema, rowCount);
}

export function captureMemoryLimit() {
  const saved = Config.memoryLimitBytes;
  return () => { Config.memoryLimitBytes = saved; };
}
