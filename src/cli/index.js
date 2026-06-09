import fs from 'fs';
import path from 'path';
import { fork } from 'child_process';
import { availableParallelism } from 'os';
import { fileURLToPath } from 'url';
import { Catalog } from '../catalog/catalog.js';
import { QueryEngine } from '../index.js';
import { LoaderFactory } from './loaders/loader-factory.js';
import { startREPL } from './repl.js';
import { Config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const dataPaths = [];
  let useWasm = true;
  let useParallel = false;
  let useDistributed = false;
  let workerCount = Config.distributedWorkers;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-wasm') {
      useWasm = false;
    } else if (arg === '--parallel') {
      useParallel = true;
    } else if (arg === '--distributed') {
      useDistributed = true;
    } else if (arg === '--workers' && args[i + 1]) {
      workerCount = parseInt(args[++i], 10);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm start -- [options] <file1> [file2...]');
      console.log('');
      console.log('Options:');
      console.log('  --no-wasm       Disable WebAssembly acceleration');
      console.log('  --parallel      Enable parallel execution (requires WASM)');
      console.log('  --distributed   Enable distributed query layer (auto-spawns workers)');
      console.log('  --workers N     Number of worker processes (default: CPU cores - 2)');
      console.log('');
      console.log('REPL commands:');
      console.log('  .status         Show engine status (wasm/parallel/distributed)');
      console.log('  .tables         List loaded tables');
      console.log('  .explain <sql>  Show query plan');
      console.log('  exit / quit     Exit the REPL');
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      dataPaths.push(arg);
    }
  }

  if (dataPaths.length === 0) {
    console.error('Usage: npm start -- [--no-wasm] [--parallel] [--distributed] [--workers N] <file1> [file2...]');
    process.exit(1);
  }

  if (workerCount <= 0) {
    workerCount = Math.max(1, availableParallelism() - 2);
  }

  try {
    const catalog = new Catalog();
    const engine = new QueryEngine(catalog);

    if (useWasm) {
      await engine.enableWasm();
    }

    if (engine.wasmEnabled) {
      console.log('[wasm] WebAssembly acceleration enabled');
    }

    if (useParallel) {
      const ok = await engine.enableParallel();
      if (ok) {
        console.log(`[parallel] Parallel execution enabled (${engine.workerPool.maxWorkers} workers)`);
      } else {
        console.log('[parallel] Could not enable parallel execution (WASM required)');
      }
    }

    const coordLoadOptions = useDistributed
      ? { partitionIndex: -1, partitionCount: 1 }
      : {};

    for (const dp of dataPaths) {
      const resolvedPath = path.resolve(process.cwd(), dp);
      if (!fs.existsSync(resolvedPath)) {
        console.error(`File not found: ${resolvedPath}`);
        process.exit(1);
      }
      const loader = LoaderFactory.getLoader(resolvedPath);
      const tableName = await loader.load(engine, resolvedPath, coordLoadOptions);
      const storage = catalog.getTableStorage(tableName);
      const rowCount = storage ? storage.rowCount() : 0;
      console.log(`[load] ${tableName} (${rowCount} rows) from ${dp}`);
    }

    let coordinator = null;
    const childProcesses = [];

    if (useDistributed) {
      const coordPort = Config.clusterPort;
      coordinator = await engine.enableDistributed({
        nodeId: `coordinator-${process.pid}`,
        host: '127.0.0.1',
        port: coordPort,
      });

      await engine.distributed.transport.start();
      console.log(`[distributed] Coordinator listening on port ${coordPort}`);
      console.log(`[distributed] Spawning ${workerCount} worker(s)...`);

      const workers = await spawnWorkers(engine, coordPort, workerCount, dataPaths);
      childProcesses.push(...workers);
      console.log(`[distributed] ${workers.length} worker(s) ready`);
    }

    const cleanup = () => {
      for (const w of childProcesses) {
        try { w.kill(); } catch (_) {}
      }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });

    startREPL(engine, { coordinator });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

async function spawnWorkers(engine, coordPort, count, dataPaths) {
  const { NodeDescriptor, NodeRole } = await import('../distributed/cluster/node-descriptor.js');
  const { RoundRobinPartitionStrategy } = await import('../distributed/partition/partition-strategy.js');
  const workerScript = path.join(__dirname, 'worker.js');
  const children = [];
  const basePort = coordPort + 1;
  const transport = engine.distributed.transport;
  const partitionMap = engine.distributed.partitionMap;

  return new Promise((resolve, reject) => {
    let registered = 0;
    const workerNodeIds = [];

    const timeout = setTimeout(() => {
      for (const c of children) {
        try { c.kill(); } catch (_) {}
      }
      reject(new Error(`Timed out waiting for ${count} workers (${registered} registered)`));
    }, 30000);

    transport.onRegister((reg) => {
      const workerDesc = new NodeDescriptor({
        nodeId: reg.nodeId,
        host: reg.host,
        port: reg.port,
        role: NodeRole.WORKER,
      });
      engine.distributed.clusterManager.addNode(workerDesc);
      transport.registerNode(reg.nodeId, reg.host, reg.port);
      workerNodeIds.push(reg.nodeId);
      registered++;
      console.log(`[distributed]   worker-${reg.port} joined (${registered}/${count})`);
      if (registered >= count) {
        clearTimeout(timeout);
        const strategy = new RoundRobinPartitionStrategy();
        const tables = engine.catalog.listTables();
        for (const tableName of tables) {
          const placements = new Map();
          for (let pid = 0; pid < count; pid++) {
            placements.set(pid, [workerNodeIds[pid]]);
          }
          partitionMap.registerTable(tableName, strategy, count, placements);
        }
        resolve(children);
      }
    });

    for (let i = 0; i < count; i++) {
      const port = basePort + i;
      const workerArgs = [
        '--coordinator', `127.0.0.1:${coordPort}`,
        '--port', String(port),
        '--partition-index', String(i),
        '--partition-count', String(count),
        ...dataPaths.map(dp => path.resolve(process.cwd(), dp)),
      ];

      const child = fork(workerScript, workerArgs, {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      child.stdout.on('data', (data) => {
        for (const line of data.toString().trim().split('\n')) {
          if (line) console.log(`  [worker-${port}] ${line}`);
        }
      });

      child.stderr.on('data', (data) => {
        for (const line of data.toString().trim().split('\n')) {
          if (line) console.error(`  [worker-${port}] ${line}`);
        }
      });

      child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`  [worker-${port}] exited with code ${code}`);
        }
      });

      children.push(child);
    }
  });
}


main();
