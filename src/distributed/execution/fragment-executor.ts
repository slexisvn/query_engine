import { PlanNodeType } from '../../planner/logical-plan.js';
import type { LogicalPlanNode } from '../../planner/logical-plan.js';
import { QueryExecutor } from '../../execution/query-executor.js';
import { ResultSink } from '../../execution/result-sink.js';
import { CancelToken } from '../../execution/pipeline.js';
import { ExchangeSender } from './exchange-operator.js';
import { ExchangeReceiver } from './exchange-operator.js';
import { FragmentState, fragmentOutputChannel } from '../planner/fragment.js';
import type { Transport } from '../transport/transport.js';
import type { CompiledPipeline } from '../../execution/execution-types.js';
import type { DataChunk } from '../../storage/chunk.js';
import type {
  FragmentId,
  OutputConfig,
  ExchangeInput,
  KeyExtractor,
} from '../distributed-types.js';

type QueryExecutorArgs = ConstructorParameters<typeof QueryExecutor>;

type CatalogLike = QueryExecutorArgs[0];

type TempManagerLike = QueryExecutorArgs[1];

type StorageBackendLike = NonNullable<QueryExecutorArgs[2]>;

interface FragmentLike {
  fragmentId: FragmentId;
  planRoot: LogicalPlanNode;
  exchangeInputs: ExchangeInput[];
  markRunning(): void;
  markCompleted(): void;
  markFailed(error: Error): void;
  markCancelled(): void;
}

interface ActiveFragment {
  fragment: FragmentLike;
  cancelToken: CancelToken;
}

interface ExecuteResult {
  sink: ResultSink;
  sender: ExchangeSender | null;
  receivers: Map<FragmentId, ExchangeReceiver>;
}

interface ExchangeReceiverHost {
  _exchangeReceivers: Map<FragmentId, ExchangeReceiver> | null;
}

export class FragmentExecutor {
  _catalog: CatalogLike;
  _tempManager: TempManagerLike;
  _transport: Transport;
  _activeFragments: Map<FragmentId, ActiveFragment>;
  _localExecutor: QueryExecutor;

  constructor(
    catalog: CatalogLike,
    tempManager: TempManagerLike,
    transport: Transport,
    storageBackend: StorageBackendLike,
    options: Record<string, never> = {},
  ) {
    this._catalog = catalog;
    this._tempManager = tempManager;
    this._transport = transport;
    this._activeFragments = new Map();
    this._localExecutor = new QueryExecutor(catalog, tempManager, storageBackend);
  }

  async execute(fragment: FragmentLike, outputConfig: OutputConfig | null): Promise<ExecuteResult> {
    const fragmentId = fragment.fragmentId;
    const cancelToken = new CancelToken();
    this._activeFragments.set(fragmentId, { fragment, cancelToken });

    try {
      fragment.markRunning();

      const receivers = await this._setupReceivers(fragment);
      const sender = outputConfig ? await this._setupSender(outputConfig) : null;

      const sink = new ResultSink(false);
      await sink.init();

      await this._executePlan(fragment.planRoot, sink, receivers, cancelToken);

      if (sender && !cancelToken.cancelled) {
        for await (const chunk of sink) {
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
      fragment.markFailed(err as Error);
      throw err;
    } finally {
      this._activeFragments.delete(fragmentId);
      this._cleanupReceivers(fragment);
    }
  }

  async cancel(fragmentId: FragmentId): Promise<void> {
    const active = this._activeFragments.get(fragmentId);
    if (active) {
      active.cancelToken.cancel();
      active.fragment.markCancelled();
    }
  }

  isRunning(fragmentId: FragmentId): boolean {
    return this._activeFragments.has(fragmentId);
  }

  async _executePlan(
    planRoot: LogicalPlanNode,
    sink: ResultSink,
    receivers: Map<FragmentId, ExchangeReceiver>,
    cancelToken: CancelToken,
  ): Promise<void> {
    const executor = this._localExecutor;
    (executor as QueryExecutor & ExchangeReceiverHost)._exchangeReceivers = receivers;
    const compiled: CompiledPipeline = await executor.buildLogicalPipeline(planRoot);
    (executor as QueryExecutor & ExchangeReceiverHost)._exchangeReceivers = null;

    const { PipelineGraph } = await import('../../execution/pipeline.js');
    const { TaskScheduler } = await import('../../execution/scheduler.js');

    const graph = new PipelineGraph();
    const rootPipelineId = graph.createPipeline(sink);
    compiled.register(graph, rootPipelineId, sink);

    const scheduler = new TaskScheduler();
    await scheduler.schedule(graph);
  }

  async _setupReceivers(fragment: FragmentLike): Promise<Map<FragmentId, ExchangeReceiver>> {
    const receivers = new Map<FragmentId, ExchangeReceiver>();
    for (const input of fragment.exchangeInputs) {
      const channelId = fragmentOutputChannel(input.sourceFragmentId);
      const receiver = new ExchangeReceiver(this._transport, ['_source_'], {
        channelId,
      });
      await receiver.init();
      receivers.set(input.sourceFragmentId, receiver);
    }
    return receivers;
  }

  async _setupSender(outputConfig: OutputConfig): Promise<ExchangeSender> {
    let keyExtractors: KeyExtractor[] = outputConfig.keyExtractors || [];
    if (outputConfig.keyColumns && outputConfig.keyColumns.length > 0) {
      keyExtractors = outputConfig.keyColumns.map(idx => (chunk: DataChunk, rowIdx: number) => chunk.columns[idx].get(rowIdx));
    }
    const sender = new ExchangeSender(this._transport, outputConfig.targetNodes, {
      exchangeType: outputConfig.exchangeType,
      keyExtractors,
      partitionCount: outputConfig.partitionCount,
      channelId: outputConfig.channelId,
    });
    await sender.init();
    return sender;
  }

  _cleanupReceivers(fragment: FragmentLike): void {
    for (const input of fragment.exchangeInputs) {
      this._transport.removeChunkListener(fragmentOutputChannel(input.sourceFragmentId));
    }
  }
}
