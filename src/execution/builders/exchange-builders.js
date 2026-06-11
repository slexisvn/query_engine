import { compileExpression } from '../expression-eval.js';

function buildKeyExtractors(partitionKeys, columnMapping) {
  if (!partitionKeys || partitionKeys.length === 0) return [];
  return partitionKeys.map(key => {
    const evalFn = compileExpression(key, columnMapping);
    return (chunk, rowIdx) => evalFn(chunk, rowIdx);
  });
}

export async function buildExchange(executor, node) {
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
        register: (graph, currentPipelineId, currentSink) => {
          graph.setSource(currentPipelineId, async function* () {
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
    const sender = new ExchangeSender(transport, node._targetNodes || [], {
      exchangeType: exchangeType || node.exchangeType,
      channelId,
      partitionCount: node.partitionCount,
      keyExtractors: buildKeyExtractors(node.partitionKeys, child.columnMapping),
    });

    return {
      schema: child.schema,
      columnMapping: child.columnMapping,
      register: (graph, currentPipelineId, currentSink) => {
        const childSink = {
          get cancelToken() { return currentSink.cancelToken; },
          async consume(chunk) {
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
    register: (graph, currentPipelineId, currentSink) => {
      child.register(graph, currentPipelineId, currentSink);
    }
  };
}

export async function buildMergeExchange(executor, node) {
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
      register: (graph, currentPipelineId, currentSink) => {
        graph.setSource(currentPipelineId, async function* () {
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
    register: (graph, currentPipelineId, currentSink) => {
      child.register(graph, currentPipelineId, currentSink);
    }
  };
}

export async function buildExchangeReceive(executor, node) {
  const receivers = executor._exchangeReceivers;
  const fragmentIds = node.sourceFragmentIds || [];

  const matchingReceivers = [];
  if (receivers) {
    for (const fid of fragmentIds) {
      const receiver = receivers.get(fid);
      if (receiver) matchingReceivers.push(receiver);
    }
  }

  const schema = node.schema || [];
  const columnMapping = new Map();
  schema.forEach((col, idx) => {
    if (col.tableAlias) columnMapping.set(`${col.tableAlias}.${col.name}`.toUpperCase(), idx);
    columnMapping.set(col.name.toUpperCase(), idx);
  });

  return {
    schema,
    columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      graph.setSource(currentPipelineId, async function* () {
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
