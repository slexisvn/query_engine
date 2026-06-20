import { compileExpression } from '../expression-eval.js';
import type { DataChunk } from '../../storage/chunk.js';
import type { PipelineGraph } from '../pipeline.js';
import type { BoundExpr } from '../../binder/expression-binder.js';
import type {
  LogicalPlanNode,
  LogicalExchangeNode,
  LogicalMergeExchangeNode,
  LogicalExchangeReceiveNode,
} from '../../planner/logical-plan.js';
import type { CompiledPipeline, ColumnMapping, ExecColumn, ExecSchema, Sink } from '../execution-types.js';
import type { Transport } from '../../distributed/transport/transport.js';
import type { ExchangeType as ExchangeTypeEnum, KeyExtractor } from '../../distributed/distributed-types.js';

interface ExchangeConfig {
  transport: Transport;
  sourceNodes: string[];
  channelId: string;
  exchangeType?: string;
}

interface MergeExchangeConfig {
  transport: Transport;
  sourceNodes: string[];
  channelId: string;
}

interface DistributedContextLike {
  role: string;
  getExchangeConfig(node: LogicalExchangeNode): ExchangeConfig;
  getMergeExchangeConfig(node: LogicalMergeExchangeNode): MergeExchangeConfig;
}

interface DistributedExchangeNode extends LogicalExchangeNode {
  _targetNodes?: string[];
}

interface ChunkReceiverLike {
  generate(): AsyncGenerator<DataChunk>;
  cleanup(): void;
}

interface ExecutorLike {
  buildPipeline(node: LogicalPlanNode): Promise<CompiledPipeline>;
  _distributedContext: DistributedContextLike | null;
  _exchangeReceivers: Map<number, ChunkReceiverLike> | null;
}

function buildKeyExtractors(partitionKeys: BoundExpr[] | null, columnMapping: ColumnMapping): KeyExtractor[] {
  if (!partitionKeys || partitionKeys.length === 0) return [];
  return partitionKeys.map((key: BoundExpr) => {
    const evalFn = compileExpression(key, columnMapping);
    return (chunk: DataChunk, rowIdx: number) => evalFn(chunk, rowIdx);
  }) as KeyExtractor[];
}

export async function buildExchange(executor: ExecutorLike, node: LogicalExchangeNode): Promise<CompiledPipeline> {
  const child = await executor.buildPipeline(node.children[0]);

  if (executor._distributedContext) {
    const { transport, sourceNodes, channelId, exchangeType } = executor._distributedContext.getExchangeConfig(node);
    const isReceiver = executor._distributedContext.role === 'receiver';

    if (isReceiver) {
      const { ExchangeReceiver } = await import('../../distributed/execution/exchange-operator.js');
      const receiver = new ExchangeReceiver(transport, sourceNodes, { channelId });
      await receiver.init();

      return {
        schema: child.schema,
        columnMapping: child.columnMapping,
        register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
          graph.setSource(currentPipelineId, async function* (): AsyncGenerator<DataChunk> {
            for await (const chunk of receiver.generate()) {
              await currentSink.consume(chunk);
              yield chunk;
            }
            receiver.cleanup();
            if (currentSink.finalize) await currentSink.finalize();
          });
        }
      };
    }

    const { ExchangeSender } = await import('../../distributed/execution/exchange-operator.js');
    const sender = new ExchangeSender(transport, (node as DistributedExchangeNode)._targetNodes || [], {
      exchangeType: (exchangeType || node.exchangeType) as ExchangeTypeEnum,
      channelId,
      partitionCount: node.partitionCount,
      keyExtractors: buildKeyExtractors(node.partitionKeys, child.columnMapping),
    });

    return {
      schema: child.schema,
      columnMapping: child.columnMapping,
      register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
        const childSink: Sink = {
          get cancelToken() { return currentSink.cancelToken; },
          async consume(chunk: DataChunk) {
            await sender.consume(chunk);
            await currentSink.consume(chunk);
          },
          async finalize() {
            await sender.finalize();
            if (currentSink.finalize) await currentSink.finalize();
          }
        };
        child.register(graph, currentPipelineId, childSink);
      }
    };
  }

  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      child.register(graph, currentPipelineId, currentSink);
    }
  };
}

export async function buildMergeExchange(executor: ExecutorLike, node: LogicalMergeExchangeNode): Promise<CompiledPipeline> {
  const child = await executor.buildPipeline(node.children[0]);

  if (executor._distributedContext) {
    const { transport, sourceNodes, channelId } = executor._distributedContext.getMergeExchangeConfig(node);
    const { MergeExchangeOperator } = await import('../../distributed/execution/merge-exchange.js');
    const merge = new MergeExchangeOperator(transport, sourceNodes, {
      orderKeys: node.orderKeys,
      limit: node.limit,
      channelId,
    });
    await merge.init();

    return {
      schema: child.schema,
      columnMapping: child.columnMapping,
      register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
        graph.setSource(currentPipelineId, async function* (): AsyncGenerator<DataChunk> {
          for await (const chunk of merge.generate()) {
            await currentSink.consume(chunk);
            yield chunk;
          }
          merge.cleanup();
          if (currentSink.finalize) await currentSink.finalize();
        });
      }
    };
  }

  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      child.register(graph, currentPipelineId, currentSink);
    }
  };
}

export async function buildExchangeReceive(executor: ExecutorLike, node: LogicalExchangeReceiveNode): Promise<CompiledPipeline> {
  const receivers = executor._exchangeReceivers;
  const fragmentIds = node.sourceFragmentIds || [];

  const matchingReceivers: ChunkReceiverLike[] = [];
  if (receivers) {
    for (const fid of fragmentIds) {
      const receiver = receivers.get(fid);
      if (receiver) matchingReceivers.push(receiver);
    }
  }

  const schema = (node.schema || []) as ExecSchema;
  const columnMapping: ColumnMapping = new Map<string, number>();
  schema.forEach((col: ExecColumn, idx: number) => {
    if (col.tableAlias) columnMapping.set(`${col.tableAlias}.${col.name}`.toUpperCase(), idx);
    columnMapping.set(col.name.toUpperCase(), idx);
  });

  return {
    schema,
    columnMapping,
    register: (graph: PipelineGraph, currentPipelineId: number, currentSink: Sink) => {
      graph.setSource(currentPipelineId, async function* (): AsyncGenerator<DataChunk> {
        for (const receiver of matchingReceivers) {
          for await (const chunk of receiver.generate()) {
            if (chunk && chunk.size > 0) {
              await currentSink.consume(chunk);
              yield chunk;
            }
          }
          receiver.cleanup();
        }
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };
}
