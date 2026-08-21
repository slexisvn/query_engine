import { Config } from '../../config.js';
import { FragmentState, fragmentOutputChannel } from '../planner/fragment.js';
import { DistributedPlanner } from '../planner/distributed-planner.js';
import { inlineCTEScans } from '../planner/cte-inline.js';
import { FragmentExecutor } from './fragment-executor.js';
import { ResultSink } from '../../execution/result-sink.js';
import { QueryResult } from '../../execution/query-result.js';
import { markDistributed } from '../distributed-types.js';
import type { Fragment, FragmentPlan } from '../planner/fragment.js';
import type { QueryEngine } from '../../engine/query-engine.js';
import type { ClusterManager } from '../cluster/cluster-manager.js';
import type { Transport } from '../transport/transport.js';
import type { ExchangeReceiver } from './exchange-operator.js';
import type { LogicalPlanNode } from '../../planner/logical-plan.js';
import type {
  NodeId,
  FragmentId,
  OutputConfig,
  ControlMessage,
  FragmentDispatchJSON,
  QueryStatus,
  QueryStatusReport,
  DistributedQueryResult,
  ExchangeType,
} from '../distributed-types.js';

const EMPTY_NODES: ReadonlySet<NodeId> = new Set();

interface CompiledQueryParts {
  plan: LogicalPlanNode;
  outputColumns: { name: string }[];
  cteMap: Map<string, LogicalPlanNode> | null;
}

interface CreateTableAsLike {
  kind?: string;
  name?: string;
  as?: unknown;
}

function ctasQuery(ddl: unknown): { tableName: string; query: Parameters<QueryEngine['compileQueryStatement']>[0] } | null {
  const stmt = ddl as CreateTableAsLike;
  if (stmt?.kind !== 'CreateTableStmt' || !stmt.as || !stmt.name) return null;
  return { tableName: stmt.name.toUpperCase(), query: stmt.as as Parameters<QueryEngine['compileQueryStatement']>[0] };
}

type DistributedPlannerArgs = ConstructorParameters<typeof DistributedPlanner>;

type FragmentExecutorArgs = ConstructorParameters<typeof FragmentExecutor>;

type PartitionMapLike = DistributedPlannerArgs[0];

interface FragmentMarkFailedLike {
  markFailed(error: string | Error | null): void;
}

type FragmentReceivers = Map<FragmentId, ExchangeReceiver>;

interface ExchangeReceiverHost {
  _exchangeReceivers: FragmentReceivers | null;
}

type LocalExecutorHost = FragmentExecutor['_localExecutor'] & ExchangeReceiverHost;

type FragmentExecuteResult = Awaited<ReturnType<FragmentExecutor['execute']>>;

type BridgeFragment = Omit<Fragment, 'markFailed'> & FragmentMarkFailedLike;

interface RootFragmentResult {
  sink: ResultSink;
}

interface ActiveQuery {
  fragmentPlan: FragmentPlan;
  startTime: number;
  status: QueryStatus | 'running' | 'cancelled';
}

type DDLResultLike = ReturnType<QueryEngine['executeDDL']>;

export class QueryCoordinator {
  _engine: QueryEngine;
  _clusterManager: ClusterManager;
  _partitionMap: PartitionMapLike;
  _transport: Transport;
  _activeQueries: Map<number, ActiveQuery>;
  _fragmentExecutor: FragmentExecutor;
  _nextQueryId: number;

  constructor(queryEngine: QueryEngine, clusterManager: ClusterManager, partitionMap: PartitionMapLike, transport: Transport) {
    this._engine = queryEngine;
    this._clusterManager = clusterManager;
    this._partitionMap = partitionMap;
    this._transport = transport;
    this._activeQueries = new Map();
    this._fragmentExecutor = new FragmentExecutor(
      queryEngine.catalog as FragmentExecutorArgs[0],
      queryEngine.tempManager as FragmentExecutorArgs[1],
      transport,
      queryEngine.storageBackend as FragmentExecutorArgs[3]
    );
    this._nextQueryId = 1;
    this._setupFragmentHandler();
  }

  async execute(sql: string): Promise<DistributedQueryResult | DDLResultLike> {
    const queryId = this._nextQueryId++;
    const startTime = Date.now();
    const timeout = Config.coordinatorTimeoutMs;

    try {
      const compiled = await this._engine.compile(sql);
      if (compiled.ddl) {
        const source = ctasQuery(compiled.ddl);
        if (!source) return this._engine.executeDDL(compiled.ddl);

        const ctas = this._engine.compileQueryStatement(source.query);
        const rows = await this._runDistributedQuery(ctas, queryId, startTime, timeout);
        return this._engine.materializeTableFromResult(source.tableName, rows, ctas.outputColumns);
      }

      const result = await this._runDistributedQuery(compiled as CompiledQueryParts, queryId, startTime, timeout);
      return { rows: await result.toArray(), columns: result.columns };
    } finally {
      this._activeQueries.delete(queryId);
    }
  }

  async _runDistributedQuery(compiled: CompiledQueryParts, queryId: number, startTime: number, timeout: number): Promise<QueryResult> {
    const { plan, outputColumns, cteMap } = compiled;
    const inlinedPlan = inlineCTEScans(plan, cteMap);
    markDistributed(inlinedPlan);

    const distributedPlan = this._reoptimize(inlinedPlan);
    const planner = new DistributedPlanner(
      this._partitionMap,
      this._clusterManager as DistributedPlannerArgs[1],
      this._engine.precomputedStats as DistributedPlannerArgs[2],
      this._engine.catalog as DistributedPlannerArgs[3]
    );
    const fragmentPlan = planner.fragmentize(distributedPlan);

    this._activeQueries.set(queryId, {
      fragmentPlan,
      startTime,
      status: 'running',
    });

    const rootFragment = fragmentPlan.getRootFragment()!;
    const receivers = await this._fragmentExecutor._setupReceivers(rootFragment as BridgeFragment);

    await this._executeFragmentPlan(fragmentPlan, queryId, timeout);

    const localResult = await this._executeRootFragmentWithReceivers(rootFragment, receivers);

    return new QueryResult(outputColumns.map(c => c.name), localResult.sink);
  }

  async cancel(queryId: number): Promise<void> {
    const query = this._activeQueries.get(queryId);
    if (!query) return;

    query.status = 'cancelled';
    const { fragmentPlan } = query;

    const cancelPromises = fragmentPlan.fragments
      .filter(f => f.state === FragmentState.RUNNING || f.state === FragmentState.DISPATCHED)
      .map(f => this._cancelFragment(f));

    await Promise.all(cancelPromises);
  }

  async _executeFragmentPlan(fragmentPlan: FragmentPlan, queryId: number, timeout: number): Promise<void> {
    const ordered = fragmentPlan.topologicalOrder();
    const nonRoot = ordered.filter(f => f !== fragmentPlan.getRootFragment());

    const levels = this._groupByDependencyLevel(nonRoot, fragmentPlan);

    for (const level of levels) {
      const elapsed = Date.now() - this._activeQueries.get(queryId)!.startTime;
      if (elapsed > timeout) {
        throw new Error(`Query ${queryId} timed out after ${timeout}ms`);
      }

      if (this._activeQueries.get(queryId)?.status === 'cancelled') {
        throw new Error(`Query ${queryId} was cancelled`);
      }

      await Promise.all(level.map(f => this._dispatchFragment(f, fragmentPlan)));
    }
  }

  _groupByDependencyLevel(fragments: Fragment[], fragmentPlan: FragmentPlan): Fragment[][] {
    const dispatched = new Set<FragmentId>();
    const levels: Fragment[][] = [];
    const remaining = new Set<FragmentId>(fragments.map(f => f.fragmentId));

    while (remaining.size > 0) {
      const level: Fragment[] = [];
      for (const fragment of fragments) {
        if (!remaining.has(fragment.fragmentId)) continue;
        const deps = (fragment.exchangeInputs || []).map(e => e.sourceFragmentId);
        const allDepsReady = deps.every(d => dispatched.has(d) || !remaining.has(d));
        if (allDepsReady) {
          level.push(fragment);
        }
      }
      if (level.length === 0) break;
      for (const f of level) {
        remaining.delete(f.fragmentId);
        dispatched.add(f.fragmentId);
      }
      levels.push(level);
    }
    return levels;
  }

  async _dispatchFragment(fragment: Fragment, fragmentPlan: FragmentPlan): Promise<void> {
    const maxRetries = Config.fragmentRetryLimit;
    const failedNodes = new Set<NodeId>();

    while (true) {
      const targetNodeId = this._selectTargetNode(fragment, failedNodes);
      fragment.markDispatched(targetNodeId);

      try {
        if (targetNodeId === this._clusterManager.localNode.nodeId) {
          await this._executeLocalFragment(fragment, fragmentPlan);
        } else {
          await this._executeRemoteFragment(fragment, targetNodeId);
        }
        return;
      } catch (err) {
        (fragment as FragmentMarkFailedLike).markFailed(err as string | Error | null);
        if (!fragment.canRetry(maxRetries)) {
          throw new Error(`Fragment ${fragment.fragmentId} failed after ${maxRetries} retries: ${(err as Error).message}`);
        }

        failedNodes.add(targetNodeId);
        fragment.state = FragmentState.PENDING;
      }
    }
  }

  async _executeLocalFragment(fragment: Fragment, _fragmentPlan: FragmentPlan): Promise<void> {
    const outputConfig = this._buildOutputConfig(fragment);
    await this._fragmentExecutor.execute(fragment as BridgeFragment, outputConfig);
  }

  async _executeRemoteFragment(fragment: Fragment, targetNodeId: NodeId): Promise<void> {
    const json: FragmentDispatchJSON = fragment.toJSON();
    json.coordinatorNodeId = this._clusterManager.localNode.nodeId;
    await this._transport.sendFragment(targetNodeId, json);

    await this._waitForFragmentCompletion(fragment);
  }

  async _executeRootFragment(rootFragment: Fragment): Promise<FragmentExecuteResult> {
    return this._fragmentExecutor.execute(rootFragment as BridgeFragment, null);
  }

  async _executeRootFragmentWithReceivers(rootFragment: Fragment, receivers: FragmentReceivers): Promise<RootFragmentResult> {
    rootFragment.markRunning();

    const sink = new ResultSink(false);
    await sink.init();

    const executor = this._fragmentExecutor._localExecutor as LocalExecutorHost;
    executor._exchangeReceivers = receivers;
    const compiled = await executor.buildLogicalPipeline(rootFragment.planRoot);
    executor._exchangeReceivers = null;

    const { PipelineGraph } = await import('../../execution/pipeline.js');
    const { TaskScheduler } = await import('../../execution/scheduler.js');

    const graph = new PipelineGraph();
    const rootPipelineId = graph.createPipeline(sink);
    compiled.register(graph, rootPipelineId, sink);

    const scheduler = new TaskScheduler();
    await scheduler.schedule(graph);

    rootFragment.markCompleted();
    return { sink };
  }

  async _waitForFragmentCompletion(fragment: Fragment): Promise<void> {
    const timeout = Config.coordinatorTimeoutMs;
    const start = Date.now();

    while (fragment.state !== FragmentState.COMPLETED && fragment.state !== FragmentState.FAILED) {
      if (Date.now() - start > timeout) {
        throw new Error(`Fragment ${fragment.fragmentId} timed out`);
      }
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }

    if (fragment.state === FragmentState.FAILED) {
      throw fragment.error || new Error(`Fragment ${fragment.fragmentId} failed`);
    }
  }

  async _cancelFragment(fragment: Fragment): Promise<void> {
    fragment.markCancelled();
    if (fragment.assignedNode) {
      try {
        await this._transport.sendControl(fragment.assignedNode, {
          type: 'cancel_fragment',
          fragmentId: fragment.fragmentId,
        } as ControlMessage);
      } catch (_) {}
    }
  }

  _selectTargetNode(fragment: Fragment, failedNodes: ReadonlySet<NodeId> = EMPTY_NODES): NodeId {
    const untried = fragment.targetNodes.filter(nodeId => !failedNodes.has(nodeId));
    const candidates = untried.length > 0 ? untried : fragment.targetNodes;

    if (candidates.length === 1) {
      return candidates[0];
    }

    const aliveTargets = candidates.filter(nodeId => {
      const node = this._clusterManager.getNode(nodeId);
      return node && node.canExecuteFragments();
    });

    if (aliveTargets.length === 0) {
      throw new Error(`Fragment ${fragment.fragmentId} has no live node holding its data (candidates: ${candidates.join(', ')})`);
    }

    return aliveTargets[fragment.fragmentId % aliveTargets.length];
  }

  _buildOutputConfig(fragment: Fragment, targetNodeId: NodeId = this._clusterManager.localNode.nodeId): OutputConfig | null {
    if (!fragment.outputPartitioning) return null;

    const op = fragment.outputPartitioning;
    return {
      targetNodes: (op.targetNodes && op.targetNodes.length > 0) ? op.targetNodes : [targetNodeId],
      exchangeType: op.exchangeType || 'gather' as ExchangeType,
      partitionCount: op.partitionCount,
      keyColumns: (op as { keyColumns?: number[] }).keyColumns,
      channelId: fragmentOutputChannel(fragment.fragmentId),
    };
  }

  _reoptimize(plan: LogicalPlanNode): LogicalPlanNode {
    return this._engine.optimize(plan);
  }

  _setupFragmentHandler(): void {
    this._transport.onFragmentReceived(async (fragmentJson: FragmentDispatchJSON) => {
      const coordinatorNodeId = fragmentJson.coordinatorNodeId || 'coordinator';
      try {
        const { Fragment } = await import('../planner/fragment.js');
        const fragment = Object.assign(new Fragment({ planRoot: fragmentJson.planRoot }), fragmentJson);
        await this._fragmentExecutor.execute(fragment as BridgeFragment, this._buildOutputConfig(fragment, coordinatorNodeId));
        await this._transport.sendControl(coordinatorNodeId, {
          type: 'fragment_completed',
          fragmentId: fragmentJson.fragmentId,
          nodeId: this._clusterManager.localNode.nodeId,
        } as ControlMessage);
      } catch (err) {
        try {
          await this._transport.sendControl(coordinatorNodeId, {
            type: 'fragment_failed',
            fragmentId: fragmentJson.fragmentId,
            error: (err as Error).message,
          } as ControlMessage);
        } catch (_) {}
      }
    });

    this._transport.onControlMessage((msg: ControlMessage) => {
      if (msg.type === 'fragment_completed') {
        this._handleFragmentCompleted(msg.fragmentId);
      } else if (msg.type === 'fragment_failed') {
        this._handleFragmentFailed(msg.fragmentId, msg.error);
      }
    });
  }

  _handleFragmentCompleted(fragmentId: FragmentId): void {
    for (const query of this._activeQueries.values()) {
      const fragment = query.fragmentPlan.fragments.find(f => f.fragmentId === fragmentId);
      if (fragment) {
        fragment.markCompleted();
        return;
      }
    }
  }

  _handleFragmentFailed(fragmentId: FragmentId, errorMessage: string): void {
    for (const query of this._activeQueries.values()) {
      const fragment = query.fragmentPlan.fragments.find(f => f.fragmentId === fragmentId);
      if (fragment) {
        (fragment as FragmentMarkFailedLike).markFailed(new Error(errorMessage || 'Remote execution failed'));
        return;
      }
    }
  }

  getActiveQueryCount(): number {
    return this._activeQueries.size;
  }

  getQueryStatus(queryId: number): QueryStatusReport | null {
    const query = this._activeQueries.get(queryId);
    if (!query) return null;
    return {
      queryId,
      status: query.status as QueryStatus,
      elapsed: Date.now() - query.startTime,
      fragments: query.fragmentPlan.fragments.map(f => ({
        fragmentId: f.fragmentId,
        state: f.state,
        assignedNode: f.assignedNode,
      })),
    };
  }
}
