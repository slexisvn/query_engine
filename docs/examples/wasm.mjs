import assert from 'node:assert/strict';
import { createEngine, registerTable, DataType, Config, DEFAULT_CHUNK_SIZE } from '../../dist/index.js';
import { globalDispatch } from '../../dist/wasm/dispatch.js';

const engine = createEngine();
let original;
const key = 'scalarMulF64:FLOAT64';
try {
  await engine.enableWasm();
  assert.equal(engine.wasmEnabled, true, 'Run npm run build first to compile core.wasm');
  original = globalDispatch.lookup('scalarMulF64', DataType.FLOAT64);
  assert.equal(typeof original, 'function');
  let calls = 0;
  globalDispatch.kernels.set(key, async (...args) => { calls++; return original(...args); });
  registerTable(engine, 'T', Array.from({ length: 5000 }, (_, i) => ({ A: i + 0.5 })),
    [{ name: 'A', dataType: DataType.FLOAT64 }]);
  const result = await engine.run('SELECT A * 2 AS R FROM T ORDER BY A');
  assert.equal(result.rows.length, 5000);
  result.rows.forEach((row, i) => assert.equal(row.R, i * 2 + 1));
  const queryCalls = calls;
  const direct = await globalDispatch.lookup('scalarMulF64', DataType.FLOAT64)(new Float64Array([1, 2, 3]), 2);
  assert.deepEqual([...direct], [2, 4, 6]);
  assert.equal(calls, queryCalls + 1);
  if (Config.wasmMinChunkSize > DEFAULT_CHUNK_SIZE) assert.equal(queryCalls, 0);
  console.log(JSON.stringify({ enabled: engine.wasmEnabled, registeredKernels: globalDispatch.listKernels().length,
    chunkSize: DEFAULT_CHUNK_SIZE, wasmMinChunkSize: Config.wasmMinChunkSize,
    scalarMultiplyCallsFromQuery: queryCalls, directKernelResult: [...direct] }, null, 2));
} finally {
  if (original) globalDispatch.kernels.set(key, original);
  await engine.close();
}
