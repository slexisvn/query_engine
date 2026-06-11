import { Config } from '../../config.js';
import { FragmentState } from '../planner/fragment.js';
import { DistributedPlanner } from '../planner/distributed-planner.js';
import { FragmentExecutor } from './fragment-executor.js';
import { ResultSink } from '../../execution/result-sink.js';
import { QueryResult } from '../../execution/query-result.js';

export class QueryCoordinator {
  constructor(queryEngine, clusterManager, partitionMap, transport) {
    this._engine = queryEngine;
    this._clusterManager = clusterManager;
    this._partitionMap = partitionMap;
    this._transport = transport;
    this._activeQueries = new Map();
    this._fragmentExecutor = new FragmentExecutor(
      queryEngine.catalog,
      queryEngine.tempManager,
      transport
    );
    this._nextQueryId = 1;
    this._setupFragmentHandler();
  }

  async execute(sql) {
    const queryId = this._nextQueryId++;
    const startTime = Date.now();
    const timeout = Config.coordinatorTimeoutMs;

    try {
      const compiled = await this._engine.compile(sql);
      if (compiled.ddl) {
        return this._engine.executeDDL(compiled.ddl);
      }

      const { plan, outputColumns, cteMap } = compiled;
      plan._distributed = true;

      const distributedPlan = this._reoptimize(plan);
      const planner = new DistributedPlanner(
        this._partitionMap,
        this._clusterManager,
        this._engine.precomputedStats
      );
      const fragmentPlan = planner.fragmentize(distributedPlan);

      this._activeQueries.set(queryId, {
        fragmentPlan,
        startTime,
        status: 'running',
      });

      const rootFragment = fragmentPlan.getRootFragment();
      const receivers = await this._fragmentExecutor._setupReceivers(rootFragment);

      await this._executeFragmentPlan(fragmentPlan, queryId, timeout);

      const localResult = await this._executeRootFragmentWithReceivers(rootFragment, receivers);

      const columnNames = outputColumns.map(c => c.name);
      const result = new QueryResult(columnNames, localResult.sink);

      return { rows: await result.toArray(), columns: columnNames };
    } finally {
      this._activeQueries.delete(queryId);
    }
  }

  async cancel(queryId) {
    const query = this._activeQueries.get(queryId);
    if (!query) return;

    query.status = 'cancelled';
    const { fragmentPlan } = query;

    const cancelPromises = fragmentPlan.fragments
      .filter(f => f.state === FragmentState.RUNNING || f.state === FragmentState.DISPATCHED)
      .map(f => this._cancelFragment(f));

    await Promise.all(cancelPromises);
  }

  async _executeFragmentPlan(fragmentPlan, queryId, timeout) {
    const ordered = fragmentPlan.topologicalOrder();
    const nonRoot = ordered.filter(f => f !== fragmentPlan.getRootFragment());

    const levels = this._groupByDependencyLevel(nonRoot, fragmentPlan);

    for (const level of levels) {
      const elapsed = Date.now() - this._activeQueries.get(queryId).startTime;
      if (elapsed > timeout) {
        throw new Error(`Query ${queryId} timed out after ${timeout}ms`);
      }

      if (this._activeQueries.get(queryId)?.status === 'cancelled') {
        throw new Error(`Query ${queryId} was cancelled`);
      }

      await Promise.all(level.map(f => this._dispatchFragment(f, fragmentPlan)));
    }
  }

  _groupByDependencyLevel(fragments, fragmentPlan) {
    const dispatched = new Set();
    const levels = [];
    const remaining = new Set(fragments.map(f => f.fragmentId));

    while (remaining.size > 0) {
      const level = [];
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

  async _dispatchFragment(fragment, fragmentPlan) {
    const maxRetries = Config.fragmentRetryLimit;

    while (true) {
      const targetNodeId = this._selectTargetNode(fragment);
      fragment.markDispatched(targetNodeId);

      try {
        if (targetNodeId === this._clusterManager.localNode.nodeId) {
          await this._executeLocalFragment(fragment, fragmentPlan);
        } else {
          await this._executeRemoteFragment(fragment, targetNodeId);
        }
        return;
      } catch (err) {
        fragment.markFailed(err);
        if (!fragment.canRetry(maxRetries)) {
          throw new Error(`Fragment ${fragment.fragmentId} failed after ${maxRetries} retries: ${err.message}`);
        }

        const failedNode = targetNodeId;
        const aliveNodes = this._clusterManager.getWorkerNodes()
          .filter(n => n.nodeId !== failedNode);

        if (aliveNodes.length === 0) {
          throw new Error(`No available nodes to retry fragment ${fragment.fragmentId}`);
        }

        fragment.state = FragmentState.PENDING;
        fragment.targetNodes = aliveNodes.map(n => n.nodeId);
      }
    }
  }

  async _executeLocalFragment(fragment, _fragmentPlan) {
    const outputConfig = this._buildOutputConfig(fragment);
    await this._fragmentExecutor.execute(fragment, outputConfig);
  }

  async _executeRemoteFragment(fragment, targetNodeId) {
    const json = fragment.toJSON();
    json.coordinatorNodeId = this._clusterManager.localNode.nodeId;
    await this._transport.sendFragment(targetNodeId, json);

    await this._waitForFragmentCompletion(fragment);
  }

  async _executeRootFragment(rootFragment) {
    return this._fragmentExecutor.execute(rootFragment, null);
  }

  async _executeRootFragmentWithReceivers(rootFragment, receivers) {
    const fragmentId = rootFragment.fragmentId;
    const cancelToken = { cancelled: false };
    rootFragment.markRunning();

    const sink = new ResultSink(false);
    await sink.init();

    const executor = this._fragmentExecutor._localExecutor;
    executor._exchangeReceivers = receivers;
    const compiled = await executor.buildPipeline(rootFragment.planRoot);
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

  async _waitForFragmentCompletion(fragment) {
    const timeout = Config.coordinatorTimeoutMs;
    const start = Date.now();

    while (fragment.state !== FragmentState.COMPLETED && fragment.state !== FragmentState.FAILED) {
      if (Date.now() - start > timeout) {
        throw new Error(`Fragment ${fragment.fragmentId} timed out`);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (fragment.state === FragmentState.FAILED) {
      throw fragment.error || new Error(`Fragment ${fragment.fragmentId} failed`);
    }
  }

  async _cancelFragment(fragment) {
    fragment.markCancelled();
    if (fragment.assignedNode) {
      try {
        await this._transport.sendControl(fragment.assignedNode, {
          type: 'cancel_fragment',
          fragmentId: fragment.fragmentId,
        });
      } catch (_) {}
    }
  }

  _selectTargetNode(fragment) {
    if (fragment.targetNodes.length === 1) {
      return fragment.targetNodes[0];
    }

    const aliveTargets = fragment.targetNodes.filter(nodeId => {
      const node = this._clusterManager.getNode(nodeId);
      return node && node.canExecuteFragments();
    });

    if (aliveTargets.length === 0) {
      return this._clusterManager.localNode.nodeId;
    }

    return aliveTargets[fragment.fragmentId % aliveTargets.length];
  }

  _buildOutputConfig(fragment, targetNodeId = this._clusterManager.localNode.nodeId) {
    if (!fragment.outputPartitioning) return null;

    return {
      targetNodes: [targetNodeId],
      exchangeType: fragment.outputPartitioning.exchangeType || 'gather',
      partitionCount: fragment.outputPartitioning.partitionCount,
      channelId: `frag-${fragment.fragmentId}-output`,
    };
  }

  _reoptimize(plan) {
    return this._engine.optimize(plan);
  }

  _setupFragmentHandler() {
    this._transport.onFragmentReceived(async (fragmentJson) => {
      const coordinatorNodeId = fragmentJson.coordinatorNodeId || 'coordinator';
      try {
        const { Fragment } = await import('../planner/fragment.js');
        const fragment = Object.assign(new Fragment({ planRoot: fragmentJson.planRoot }), fragmentJson);
        await this._fragmentExecutor.execute(fragment, this._buildOutputConfig(fragment, coordinatorNodeId));
        await this._transport.sendControl(coordinatorNodeId, {
          type: 'fragment_completed',
          fragmentId: fragmentJson.fragmentId,
          nodeId: this._clusterManager.localNode.nodeId,
        });
      } catch (err) {
        try {
          await this._transport.sendControl(coordinatorNodeId, {
            type: 'fragment_failed',
            fragmentId: fragmentJson.fragmentId,
            error: err.message,
          });
        } catch (_) {}
      }
    });

    this._transport.onControlMessage((msg) => {
      if (msg.type === 'fragment_completed') {
        this._handleFragmentCompleted(msg.fragmentId);
      } else if (msg.type === 'fragment_failed') {
        this._handleFragmentFailed(msg.fragmentId, msg.error);
      }
    });
  }

  _handleFragmentCompleted(fragmentId) {
    for (const query of this._activeQueries.values()) {
      const fragment = query.fragmentPlan.fragments.find(f => f.fragmentId === fragmentId);
      if (fragment) {
        fragment.markCompleted();
        return;
      }
    }
  }

  _handleFragmentFailed(fragmentId, errorMessage) {
    for (const query of this._activeQueries.values()) {
      const fragment = query.fragmentPlan.fragments.find(f => f.fragmentId === fragmentId);
      if (fragment) {
        fragment.markFailed(new Error(errorMessage || 'Remote execution failed'));
        return;
      }
    }
  }

  getActiveQueryCount() {
    return this._activeQueries.size;
  }

  getQueryStatus(queryId) {
    const query = this._activeQueries.get(queryId);
    if (!query) return null;
    return {
      queryId,
      status: query.status,
      elapsed: Date.now() - query.startTime,
      fragments: query.fragmentPlan.fragments.map(f => ({
        fragmentId: f.fragmentId,
        state: f.state,
        assignedNode: f.assignedNode,
      })),
    };
  }
}
