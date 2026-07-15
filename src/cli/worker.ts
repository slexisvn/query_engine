import { Catalog, Config, FragmentExecutor, HttpTransport, QueryEngine } from '../index.js';
import { loadDataFiles } from './cli-common.js';
import type {
  ControlMessage,
  DataChunk,
  ExchangeType,
  Fragment,
  FragmentDispatchJSON,
  NodeId,
  NodeRegistration,
  OutputConfig,
} from '../index.js';

type FragmentExecuteFragment = Parameters<FragmentExecutor['execute']>[0];

type FragmentExecutorArgs = ConstructorParameters<typeof FragmentExecutor>;

type BridgeFragment = Omit<Fragment, 'markFailed'> & {
  markFailed(error: string | Error | null): void;
};

interface OutputPartitioningLike {
  targetNodes?: NodeId[];
  exchangeType?: ExchangeType;
  partitionCount?: number;
  keyColumns?: number[];
}

interface WorkerRegistration {
  nodeId: NodeId;
  host: string;
  port: number;
  partitionIndex?: number;
  partitionCount?: number;
}

interface WorkerControlMessage {
  type: string;
  fragmentId: number;
}

interface LoadOptions {
  partitionIndex?: number;
  partitionCount?: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let port = 9401;
  let coordinatorAddr: string | null = null;
  let partitionIndex: number | null = null;
  let partitionCount: number | null = null;
  const dataPaths: string[] = [];

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
  const loadOptions: LoadOptions = usePartition ? { partitionIndex, partitionCount } as LoadOptions : {};

  const catalog = new Catalog();
  const engine = new QueryEngine(catalog);

  await loadDataFiles(engine, catalog, dataPaths, {
    loadOptions,
    formatLoadLine: ({ tableName, rowCount }) => {
      const suffix = usePartition ? ` (partition ${partitionIndex}/${partitionCount})` : '';
      return `[load] ${tableName} (${rowCount} rows)${suffix}`;
    },
  });

  const nodeId = `worker-${port}`;
  const transport = new HttpTransport({ port, nodeId });
  await transport.start();

  transport.registerNode('coordinator', coordHost, coordPort);

  const fragmentExecutor = new FragmentExecutor(catalog as FragmentExecutorArgs[0], engine.tempManager as FragmentExecutorArgs[1], transport, engine.storageBackend as FragmentExecutorArgs[3]);

  let fragmentsExecuted = 0;
  let fragmentsFailed = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  transport.onFragmentReceived(async (fragmentJson: FragmentDispatchJSON) => {
    const startTime = performance.now();
    console.log(`[fragment] Received fragment ${fragmentJson.fragmentId}`);

    try {
      const { Fragment } = await import('../index.js');
      const fragment = Object.assign(
        new Fragment({ planRoot: fragmentJson.planRoot }),
        fragmentJson
      );

      const op = fragmentJson.outputPartitioning as OutputPartitioningLike | null;
      const outputConfig: OutputConfig | null = op
        ? {
          targetNodes: (op.targetNodes && op.targetNodes.length > 0) ? op.targetNodes : ['coordinator'],
          exchangeType: op.exchangeType || 'gather' as ExchangeType,
          partitionCount: op.partitionCount,
          keyColumns: op.keyColumns,
          channelId: `frag-${fragment.fragmentId}-output`,
        }
        : null;

      const result = await fragmentExecutor.execute(fragment as BridgeFragment as FragmentExecuteFragment, outputConfig);
      fragmentsExecuted++;

      const elapsed = (performance.now() - startTime).toFixed(2);
      const rows = result.sink?.chunks?.reduce((sum: number, c: DataChunk) => sum + c.size, 0) || 0;
      console.log(`[fragment] Fragment ${fragmentJson.fragmentId} completed: ${rows} rows in ${elapsed} ms`);

      await transport.sendControl('coordinator', {
        type: 'fragment_completed',
        fragmentId: fragmentJson.fragmentId,
        nodeId,
      } as ControlMessage);
    } catch (err) {
      fragmentsFailed++;
      console.error(`[fragment] Fragment ${fragmentJson.fragmentId} failed: ${(err as Error).message}`);

      try {
        await transport.sendControl('coordinator', {
          type: 'fragment_failed',
          fragmentId: fragmentJson.fragmentId,
          nodeId,
          error: (err as Error).message,
        } as ControlMessage);
      } catch (_) {}
    }
  });

  transport.onControlMessage((msg: ControlMessage) => {
    if ((msg as WorkerControlMessage).type === 'cancel_fragment') {
      console.log(`[control] Cancel request for fragment ${(msg as WorkerControlMessage).fragmentId}`);
      fragmentExecutor.cancel((msg as WorkerControlMessage).fragmentId);
    } else if ((msg as WorkerControlMessage).type === 'shutdown') {
      console.log('[control] Shutdown requested by coordinator');
      shutdown();
    }
  });

  console.log(`[worker] Listening on port ${port}`);
  console.log(`[worker] Node ID: ${nodeId}`);
  console.log(`[worker] Registering with coordinator at ${coordHost}:${coordPort}...`);

  const registration: WorkerRegistration = { nodeId, host: '127.0.0.1', port };
  if (usePartition) {
    registration.partitionIndex = partitionIndex as number;
    registration.partitionCount = partitionCount as number;
  }

  try {
    await transport.sendRegister('coordinator', registration as NodeRegistration);
    console.log('[worker] Registered with coordinator');
    heartbeatTimer = setInterval(() => {
      transport.sendHeartbeat('coordinator', { nodeId } as Parameters<typeof transport.sendHeartbeat>[1]).catch(() => {});
    }, Config.heartbeatIntervalMs);
  } catch (err) {
    console.error(`[worker] Failed to register: ${(err as Error).message}`);
    console.error('[worker] Is the coordinator running?');
    process.exit(1);
  }

  console.log('[worker] Ready for fragments');
  console.log('');

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  async function shutdown(): Promise<void> {
    console.log('\n[worker] Shutting down...');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await transport.stop();
    process.exit(0);
  }

  process.stdin.resume();
  process.stdin.on('data', (data: Buffer) => {
    const cmd = data.toString().trim();
    if (cmd === 'status') {
      console.log(`  executed: ${fragmentsExecuted}, failed: ${fragmentsFailed}`);
    }
    if (cmd === 'exit' || cmd === 'quit') shutdown();
  });
}

main().catch((err: Error) => {
  console.error('Fatal:', err);
  process.exit(1);
});
