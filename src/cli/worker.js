import fs from 'fs';
import path from 'path';
import { Catalog } from '../catalog/catalog.js';
import { QueryEngine } from '../index.js';
import { LoaderFactory } from './loaders/loader-factory.js';
import { HttpTransport } from '../distributed/transport/http-transport.js';
import { FragmentExecutor } from '../distributed/execution/fragment-executor.js';
import { Config } from '../config.js';

async function main() {
  const args = process.argv.slice(2);
  let port = 9401;
  let coordinatorAddr = null;
  let partitionIndex = null;
  let partitionCount = null;
  const dataPaths = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === '--coordinator' && args[i + 1]) {
      coordinatorAddr = args[++i];
    } else if (args[i] === '--partition-index' && args[i + 1]) {
      partitionIndex = parseInt(args[++i], 10);
    } else if (args[i] === '--partition-count' && args[i + 1]) {
      partitionCount = parseInt(args[++i], 10);
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node src/cli/worker.js --coordinator <host:port> [--port 9401] [--partition-index I --partition-count N] <file1> [file2...]');
      console.log('');
      console.log('Starts a worker node that connects to a coordinator.');
      console.log('The worker loads data locally and executes query fragments.');
      console.log('');
      console.log('With --partition-index and --partition-count, only loads rows');
      console.log('where rowIndex % N == I (round-robin partitioning).');
      process.exit(0);
    } else if (!args[i].startsWith('-')) {
      dataPaths.push(args[i]);
    }
  }

  if (!coordinatorAddr) {
    console.error('Error: --coordinator <host:port> is required');
    process.exit(1);
  }

  const [coordHost, coordPortStr] = coordinatorAddr.split(':');
  const coordPort = parseInt(coordPortStr, 10);
  if (!coordHost || !coordPort) {
    console.error('Error: Invalid coordinator address. Use host:port format.');
    process.exit(1);
  }

  const usePartition = partitionIndex !== null && partitionCount !== null;
  const loadOptions = usePartition ? { partitionIndex, partitionCount } : {};

  const catalog = new Catalog();
  const engine = new QueryEngine(catalog);

  for (const dp of dataPaths) {
    const resolvedPath = path.resolve(process.cwd(), dp);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`File not found: ${resolvedPath}`);
      process.exit(1);
    }
    const loader = LoaderFactory.getLoader(resolvedPath);
    const tableName = await loader.load(engine, resolvedPath, loadOptions);
    const storage = catalog.getTableStorage(tableName);
    const suffix = usePartition ? ` (partition ${partitionIndex}/${partitionCount})` : '';
    console.log(`[load] ${tableName} (${storage.rowCount()} rows)${suffix}`);
  }

  const nodeId = `worker-${port}`;
  const transport = new HttpTransport({ port, nodeId });
  await transport.start();

  transport.registerNode('coordinator', coordHost, coordPort);

  const fragmentExecutor = new FragmentExecutor(catalog, engine.tempManager, transport);

  let fragmentsExecuted = 0;
  let fragmentsFailed = 0;
  let heartbeatTimer = null;

  transport.onFragmentReceived(async (fragmentJson) => {
    const startTime = performance.now();
    console.log(`[fragment] Received fragment ${fragmentJson.fragmentId}`);

    try {
      const { Fragment } = await import('../distributed/planner/fragment.js');
      const fragment = Object.assign(
        new Fragment({ planRoot: fragmentJson.planRoot }),
        fragmentJson
      );

      const op = fragmentJson.outputPartitioning;
      const outputConfig = op
        ? {
          targetNodes: (op.targetNodes && op.targetNodes.length > 0) ? op.targetNodes : ['coordinator'],
          exchangeType: op.exchangeType || 'gather',
          partitionCount: op.partitionCount,
          keyColumns: op.keyColumns,
          channelId: `frag-${fragment.fragmentId}-output`,
        }
        : null;

      const result = await fragmentExecutor.execute(fragment, outputConfig);
      fragmentsExecuted++;

      const elapsed = (performance.now() - startTime).toFixed(2);
      const rows = result.sink?.chunks?.reduce((sum, c) => sum + c.size, 0) || 0;
      console.log(`[fragment] Fragment ${fragmentJson.fragmentId} completed: ${rows} rows in ${elapsed} ms`);

      await transport.sendControl('coordinator', {
        type: 'fragment_completed',
        fragmentId: fragmentJson.fragmentId,
        nodeId,
      });
    } catch (err) {
      fragmentsFailed++;
      console.error(`[fragment] Fragment ${fragmentJson.fragmentId} failed: ${err.message}`);

      try {
        await transport.sendControl('coordinator', {
          type: 'fragment_failed',
          fragmentId: fragmentJson.fragmentId,
          nodeId,
          error: err.message,
        });
      } catch (_) {}
    }
  });

  transport.onControlMessage((msg) => {
    if (msg.type === 'cancel_fragment') {
      console.log(`[control] Cancel request for fragment ${msg.fragmentId}`);
      fragmentExecutor.cancel(msg.fragmentId);
    } else if (msg.type === 'shutdown') {
      console.log('[control] Shutdown requested by coordinator');
      shutdown();
    }
  });

  console.log(`[worker] Listening on port ${port}`);
  console.log(`[worker] Node ID: ${nodeId}`);
  console.log(`[worker] Registering with coordinator at ${coordHost}:${coordPort}...`);

  const registration = { nodeId, host: '127.0.0.1', port };
  if (usePartition) {
    registration.partitionIndex = partitionIndex;
    registration.partitionCount = partitionCount;
  }

  try {
    await transport.sendRegister('coordinator', registration);
    console.log('[worker] Registered with coordinator');
    heartbeatTimer = setInterval(() => {
      transport.sendHeartbeat('coordinator', { nodeId }).catch(() => {});
    }, Config.heartbeatIntervalMs);
  } catch (err) {
    console.error(`[worker] Failed to register: ${err.message}`);
    console.error('[worker] Is the coordinator running?');
    process.exit(1);
  }

  console.log('[worker] Ready for fragments');
  console.log('');

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  async function shutdown() {
    console.log('\n[worker] Shutting down...');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await transport.stop();
    process.exit(0);
  }

  process.stdin.resume();
  process.stdin.on('data', (data) => {
    const cmd = data.toString().trim();
    if (cmd === 'status') {
      console.log(`  executed: ${fragmentsExecuted}, failed: ${fragmentsFailed}`);
    }
    if (cmd === 'exit' || cmd === 'quit') shutdown();
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
