import { PlanNodeType } from '../../planner/logical-plan.js';
import { QueryExecutor } from '../../execution/query-executor.js';
import { ResultSink } from '../../execution/result-sink.js';
import { ExchangeSender } from './exchange-operator.js';
import { ExchangeReceiver } from './exchange-operator.js';
import { FragmentState } from '../planner/fragment.js';

export class FragmentExecutor {
  constructor(catalog, tempManager, transport, options = {}) {
    this._catalog = catalog;
    this._tempManager = tempManager;
    this._transport = transport;
    this._activeFragments = new Map();
    this._localExecutor = new QueryExecutor(catalog, tempManager);
  }

  async execute(fragment, outputConfig) {
    const fragmentId = fragment.fragmentId;
    const cancelToken = { cancelled: false };
    this._activeFragments.set(fragmentId, { fragment, cancelToken });

    try {
      fragment.markRunning();

      const receivers = await this._setupReceivers(fragment);
      const sender = outputConfig ? await this._setupSender(outputConfig) : null;

      const sink = new ResultSink(false);
      await sink.init();

      await this._executePlan(fragment.planRoot, sink, receivers, cancelToken);

      if (sender && !cancelToken.cancelled) {
        for (const chunk of sink.chunks) {
          await sender.consume(chunk);
        }
        await sender.finalize();
      }

      fragment.markCompleted();

      return {
        sink,
        sender,
        receivers,
      };
    } catch (err) {
      fragment.markFailed(err);
      throw err;
    } finally {
      this._activeFragments.delete(fragmentId);
      this._cleanupReceivers(fragment);
    }
  }

  async cancel(fragmentId) {
    const active = this._activeFragments.get(fragmentId);
    if (active) {
      active.cancelToken.cancelled = true;
      active.fragment.markCancelled();
    }
  }

  isRunning(fragmentId) {
    return this._activeFragments.has(fragmentId);
  }

  async _executePlan(planRoot, sink, receivers, cancelToken) {
    const executor = this._localExecutor;
    executor._exchangeReceivers = receivers;
    const compiled = await executor.buildPipeline(planRoot);
    executor._exchangeReceivers = null;

    const { PipelineGraph } = await import('../../execution/pipeline.js');
    const { TaskScheduler } = await import('../../execution/scheduler.js');

    const graph = new PipelineGraph();
    const rootPipelineId = graph.createPipeline(sink);
    compiled.register(graph, rootPipelineId, sink);

    const scheduler = new TaskScheduler();
    await scheduler.schedule(graph);
  }

  async _setupReceivers(fragment) {
    const receivers = new Map();
    for (const input of fragment.exchangeInputs) {
      const channelId = `frag-${input.sourceFragmentId}-output`;
      const receiver = new ExchangeReceiver(this._transport, ['_source_'], {
        channelId,
      });
      await receiver.init();
      receivers.set(input.sourceFragmentId, receiver);
    }
    return receivers;
  }

  async _setupSender(outputConfig) {
    const sender = new ExchangeSender(this._transport, outputConfig.targetNodes, {
      exchangeType: outputConfig.exchangeType,
      keyExtractors: outputConfig.keyExtractors || [],
      partitionCount: outputConfig.partitionCount,
      channelId: outputConfig.channelId,
    });
    await sender.init();
    return sender;
  }

  _cleanupReceivers(fragment) {
    for (const input of fragment.exchangeInputs) {
      const channelId = `frag-${input.sourceFragmentId}-to-${fragment.fragmentId}`;
      this._transport.removeChunkListener(channelId);
    }
  }
}
