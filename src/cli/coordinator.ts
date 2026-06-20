import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Catalog } from '../catalog/catalog.js';
import { QueryEngine } from '../index.js';
import { LoaderFactory } from './loaders/loader-factory.js';
import { formatResult } from './format.js';
import { HttpTransport } from '../distributed/transport/http-transport.js';
import { NodeDescriptor, NodeRole } from '../distributed/cluster/node-descriptor.js';
import { RoundRobinPartitionStrategy } from '../distributed/partition/partition-strategy.js';
import { Config } from '../config.js';
import type { ClusterManager } from '../distributed/cluster/cluster-manager.js';
import type { PartitionMap } from '../distributed/partition/partition-map.js';
import type { QueryCoordinator } from '../distributed/execution/coordinator.js';
import type { DataLoader } from './loaders/data-loader.js';
import type { Table } from '../storage/table.js';
import type { NodeId, NodeRegistration, HeartbeatMessage } from '../distributed/distributed-types.js';

interface LoaderLike {
  load(engine: QueryEngine, filePath: string, options: { maxRows: number }): Promise<string>;
}

interface CoordinatorRegistration extends NodeRegistration {
  partitionIndex?: number | null;
  partitionCount?: number;
}

async function main(): Promise<void> {
  const args: string[] = process.argv.slice(2);
  let port = 9400;
  const dataPaths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node src/cli/coordinator.js [--port 9400] <file1> [file2...]');
      console.log('');
      console.log('Starts a coordinator node that accepts SQL queries.');
      console.log('Workers connect to this node to form a cluster.');
      console.log('');
      console.log('REPL commands:');
      console.log('  .status    Show cluster status');
      console.log('  .nodes     List connected nodes');
      console.log('  .tables    List loaded tables');
      process.exit(0);
    } else if (!args[i].startsWith('-')) {
      dataPaths.push(args[i]);
    }
  }

  if (dataPaths.length === 0) {
    console.error('Usage: node src/cli/coordinator.js [--port 9400] <file1> [file2...]');
    process.exit(1);
  }

  const catalog = new Catalog();
  const engine = new QueryEngine(catalog);

  for (const dp of dataPaths) {
    const resolvedPath = path.resolve(process.cwd(), dp);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`File not found: ${resolvedPath}`);
      process.exit(1);
    }
    const loader: DataLoader = LoaderFactory.getLoader(resolvedPath);
    const tableName = await (loader as LoaderLike).load(engine, resolvedPath, { maxRows: Config.coordinatorSchemaSampleRows });
    const storage = catalog.getTableStorage(tableName) as Table;
    console.log(`[load] ${tableName} (schema from ${storage.rowCount()} sample rows; data lives on workers)`);
  }

  const nodeId = `coordinator-${port}`;
  const transport = new HttpTransport({ port, nodeId });
  await transport.start();

  const coordinator = await engine.enableDistributed({
    nodeId,
    host: '127.0.0.1',
    port,
    role: NodeRole.COORDINATOR,
    transport,
  }) as QueryCoordinator;

  for (const tableName of engine.catalog.listTables()) {
    (engine.distributed!.partitionMap as PartitionMap).registerTable(tableName, new RoundRobinPartitionStrategy() as Parameters<PartitionMap['registerTable']>[1], 1, new Map());
  }

  const partitionPlacements = new Map<string, Map<number, NodeId[]>>();

  transport.onRegister((reg: CoordinatorRegistration) => {
    const workerDesc = new NodeDescriptor({
      nodeId: reg.nodeId,
      host: reg.host,
      port: reg.port,
      role: NodeRole.WORKER,
    });
    (engine.distributed!.clusterManager as ClusterManager).addNode(workerDesc);
    (engine.distributed!.clusterManager as ClusterManager).recordHeartbeat(reg.nodeId, Date.now());
    transport.registerNode(reg.nodeId, reg.host, reg.port);

    if (reg.partitionIndex !== undefined && reg.partitionIndex !== null && reg.partitionCount) {
      const partitionMap = engine.distributed!.partitionMap as PartitionMap;
      for (const tableName of engine.catalog.listTables()) {
        let placements = partitionPlacements.get(tableName);
        if (!placements) {
          placements = new Map();
          partitionPlacements.set(tableName, placements);
        }
        const nodes = placements.get(reg.partitionIndex) || [];
        if (!nodes.includes(reg.nodeId)) nodes.push(reg.nodeId);
        placements.set(reg.partitionIndex, nodes);
        partitionMap.registerTable(tableName, new RoundRobinPartitionStrategy() as Parameters<PartitionMap['registerTable']>[1], reg.partitionCount, placements);
      }
    }

    console.log(`\n[cluster] Worker joined: ${reg.nodeId} (${reg.host}:${reg.port})`);
    rl.prompt();
  });

  transport.onHeartbeat((msg: HeartbeatMessage) => {
    if (msg && msg.nodeId) {
      (engine.distributed!.clusterManager as ClusterManager).recordHeartbeat(msg.nodeId, Date.now());
    }
  });

  console.log(`[coordinator] Listening on port ${port}`);
  console.log(`[coordinator] Node ID: ${nodeId}`);
  console.log(`[coordinator] Waiting for workers... (start workers with: node src/cli/worker.js --coordinator 127.0.0.1:${port} <files>)`);
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'coord> ',
  });

  rl.prompt();
  let queryBuffer = '';

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
      await engine.shutdown();
      rl.close();
      return;
    }
    if (trimmed === '') { rl.prompt(); return; }

    if (trimmed.startsWith('.')) {
      handleMeta(trimmed, engine, coordinator);
      rl.prompt();
      return;
    }

    queryBuffer += (queryBuffer ? ' ' : '') + trimmed;

    if (queryBuffer.endsWith(';')) {
      try {
        console.log();
        const t0 = performance.now();
        const result = await coordinator.execute(queryBuffer);
        const t1 = performance.now();
        formatResult(result as Parameters<typeof formatResult>[0]);
        const workers = (engine.distributed!.clusterManager as ClusterManager).getWorkerNodes().length;
        console.log(`Executed in ${(t1 - t0).toFixed(2)} ms [${workers} worker(s)]\n`);
      } catch (err) {
        console.error((err as Error).message);
      }
      queryBuffer = '';
      rl.setPrompt('coord> ');
    } else {
      rl.setPrompt('  ...> ');
    }
    rl.prompt();
  }).on('close', () => {
    process.exit(0);
  });
}

function handleMeta(cmd: string, engine: QueryEngine, coordinator: QueryCoordinator): void {
  const command = cmd.split(/\s+/)[0].toLowerCase();

  switch (command) {
    case '.status': {
      const cm = engine.distributed!.clusterManager as ClusterManager;
      const workers = cm.getWorkerNodes();
      const alive = cm.getAliveNodes();
      console.log('');
      console.log(`  node:    ${cm.localNode.nodeId}`);
      console.log(`  port:    ${cm.localNode.port}`);
      console.log(`  workers: ${workers.length}`);
      console.log(`  alive:   ${alive.length}`);
      console.log('');
      break;
    }
    case '.nodes': {
      const cm = engine.distributed!.clusterManager as ClusterManager;
      console.log('');
      for (const node of cm.getAliveNodes()) {
        const role = node.nodeId === cm.localNode.nodeId ? 'coordinator' : 'worker';
        console.log(`  ${node.nodeId} (${node.host}:${node.port}) [${role}] ${node.status}`);
      }
      console.log('');
      break;
    }
    case '.tables': {
      const tables = engine.catalog.listTables();
      console.log('');
      for (const name of tables) {
        const storage = engine.catalog.getTableStorage(name);
        const rows = storage ? storage.rowCount() : '?';
        console.log(`  ${name} (${rows} rows)`);
      }
      if (tables.length === 0) console.log('  No tables loaded.');
      console.log('');
      break;
    }
    case '.help': {
      console.log('');
      console.log('  .status    Cluster status');
      console.log('  .nodes     Connected nodes');
      console.log('  .tables    Loaded tables');
      console.log('  exit       Shutdown');
      console.log('');
      break;
    }
    default:
      console.log(`  Unknown: ${command}. Type .help`);
  }
}

main().catch((err: Error) => {
  console.error('Fatal:', err);
  process.exit(1);
});
