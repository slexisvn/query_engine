import path from 'path';
import { fork } from 'child_process';
import type { ChildProcess } from 'child_process';
import { availableParallelism } from 'os';
import { fileURLToPath } from 'url';
import { Catalog, QueryEngine } from '../index.js';
import { loadDataFiles } from './cli-common.js';
import { startREPL } from './repl.js';
import { Config } from '../index.js';
import type { NodeRegistration, NodeId, PartitionId, QueryCoordinator } from '../index.js';

interface LoadOptions {
  partitionIndex?: number;
  partitionCount?: number;
}

interface WorkerPoolWithCount {
  maxWorkers: number;
}

interface ClusterManagerLike {
  addNode(descriptor: object): void;
}

interface PartitionMapLike {
  registerTable(
    tableName: string,
    strategy: object,
    partitionCount: number,
    placements?: Iterable<[PartitionId, NodeId | NodeId[]]> | null,
  ): void;
}

interface RegisterTransportLike {
  start(): Promise<void>;
  registerNode(nodeId: NodeId, host: string, port: number): void;
  onRegister(callback: (registration: NodeRegistration) => void): void;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function start(): Promise<void> {
  const args = process.argv.slice(2);
  const dataPaths: string[] = [];
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
        console.log(`[parallel] Parallel execution enabled (${(engine.workerPool as NonNullable<QueryEngine['workerPool']> & WorkerPoolWithCount).maxWorkers} workers)`);
      } else {
        console.log('[parallel] Could not enable parallel execution (WASM required)');
      }
    }

    const coordLoadOptions: LoadOptions = useDistributed
      ? { partitionIndex: -1, partitionCount: 1 }
      : {};

    await loadDataFiles(engine, catalog, dataPaths, { loadOptions: coordLoadOptions });

    let coordinator: QueryCoordinator | null = null;
    const childProcesses: ChildProcess[] = [];

    if (useDistributed) {
      const coordPort = Config.clusterPort;
      coordinator = await engine.enableDistributed({
        nodeId: `coordinator-${process.pid}`,
        host: '127.0.0.1',
        port: coordPort,
      }) as QueryCoordinator;

      await engine.distributed!.transport.start();
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
    console.error((err as Error).message);
    process.exit(1);
  }
}

async function spawnWorkers(engine: QueryEngine, coordPort: number, count: number, dataPaths: string[]): Promise<ChildProcess[]> {
  const { NodeDescriptor, NodeRole, RoundRobinPartitionStrategy } = await import('../index.js');
  const workerScript = path.join(__dirname, 'worker.js');
  const children: ChildProcess[] = [];
  const basePort = coordPort + 1;
  const transport = engine.distributed!.transport as NonNullable<typeof engine.distributed>['transport'] & RegisterTransportLike;
  const partitionMap = engine.distributed!.partitionMap as PartitionMapLike;

  return new Promise<ChildProcess[]>((resolve, reject) => {
    let registered = 0;
    const workerNodeIds: NodeId[] = [];

    const timeout = setTimeout(() => {
      for (const c of children) {
        try { c.kill(); } catch (_) {}
      }
      reject(new Error(`Timed out waiting for ${count} workers (${registered} registered)`));
    }, Config.workerStartupTimeoutMs);

    transport.onRegister((reg: NodeRegistration) => {
      const workerDesc = new NodeDescriptor({
        nodeId: reg.nodeId,
        host: reg.host,
        port: reg.port,
        role: NodeRole.WORKER,
      });
      (engine.distributed!.clusterManager as ClusterManagerLike).addNode(workerDesc);
      transport.registerNode(reg.nodeId, reg.host, reg.port);
      workerNodeIds.push(reg.nodeId);
      registered++;
      console.log(`[distributed]   worker-${reg.port} joined (${registered}/${count})`);
      if (registered >= count) {
        clearTimeout(timeout);
        const strategy = new RoundRobinPartitionStrategy();
        const tables = engine.catalog.listTables();
        for (const tableName of tables) {
          const placements = new Map<PartitionId, NodeId[]>();
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

      child.stdout!.on('data', (data: Buffer) => {
        for (const line of data.toString().trim().split('\n')) {
          if (line) console.log(`  [worker-${port}] ${line}`);
        }
      });

      child.stderr!.on('data', (data: Buffer) => {
        for (const line of data.toString().trim().split('\n')) {
          if (line) console.error(`  [worker-${port}] ${line}`);
        }
      });

      child.on('exit', (code: number | null) => {
        if (code !== 0 && code !== null) {
          console.error(`  [worker-${port}] exited with code ${code}`);
        }
      });

      children.push(child);
    }
  });
}

