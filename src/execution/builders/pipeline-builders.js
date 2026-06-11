import { compileExpression } from '../expression-eval.js';
import { FilterOperator } from '../operators/filter.js';
import { ProjectionOperator } from '../operators/projection.js';
import { SortOperator, LimitOperator } from '../operators/sort.js';
import { DistinctOperator } from '../operators/distinct.js';
import { UnionOperator } from '../operators/union.js';
import { WindowOperator } from '../operators/window.js';
import { CancelToken } from '../pipeline.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import { registerBufferedChild } from './builder-utils.js';

export async function buildFilter(executor, node) {
  const child = await executor.buildPipeline(node.children[0]);
  const evalFn = compileExpression(node.condition, child.columnMapping);
  const parallelDispatch = executor.parallelDispatch;

  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      const filterOp = new FilterOperator(node.condition, evalFn, child.columnMapping, parallelDispatch);
      const childSink = {
        get cancelToken() { return currentSink.cancelToken; },
        async consume(chunk) {
          if (this.cancelToken?.isCancelled) return;
          const filtered = await filterOp.process(chunk);
          if (filtered && filtered.size > 0) {
            await currentSink.consume(filtered);
          }
        },
        async finalize() {
          if (currentSink.finalize) await currentSink.finalize();
        }
      };
      child.register(graph, currentPipelineId, childSink);
    }
  };
}

export async function buildProject(executor, node) {
  const child = await executor.buildPipeline(node.children[0]);
  const evaluators = node.expressions.map(expr => compileExpression(expr, child.columnMapping));
  const resultTypes = node.expressions.map(expr => executor.normalizeExecType(expr?.dataType || expr?.resultType || 'VARCHAR'));

  const schema = node.expressions.map((expr, i) => ({
    name: expr?.outputName || expr?.alias || expr?.name || expr?.columnName || `col${i}`,
    dataType: executor.normalizeExecType(expr?.dataType || expr?.resultType || 'VARCHAR'),
    tableAlias: '',
  }));
  const columnMapping = executor.buildSchemaMapping(schema, '');

  return {
    schema,
    columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      const projOp = new ProjectionOperator(node.expressions, evaluators, resultTypes, child.columnMapping, executor.parallelDispatch);
      const childSink = {
        get cancelToken() { return currentSink.cancelToken; },
        async consume(chunk) {
          if (this.cancelToken?.isCancelled) return;
          const projected = await projOp.process(chunk);
          await currentSink.consume(projected);
        },
        async finalize() {
          if (currentSink.finalize) await currentSink.finalize();
        }
      };
      child.register(graph, currentPipelineId, childSink);
    }
  };
}

export async function buildSort(executor, node) {
  const child = await executor.buildPipeline(node.children[0]);
  const keyExtractors = node.orderKeys.map(ok => ({
    eval: compileExpression(ok.expr, child.columnMapping),
    direction: ok.direction || 'ASC',
  }));

  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      const spillHandle = executor.tempManager.allocate('spill', 'sort');
      const sortOp = new SortOperator(keyExtractors, node.limit, node.offset || 0, executor.storageBackend.createSpillManager(spillHandle));
      const sortSink = {
        async consume(chunk) { await sortOp.consume(chunk); },
        async finalize() {}
      };
      const childPipelineId = graph.createPipeline(sortSink);
      child.register(graph, childPipelineId, sortSink);

      graph.addDependency(currentPipelineId, childPipelineId);

      graph.setSource(currentPipelineId, async function* () {
        const resultChunks = await sortOp.finalize();
        for (const chunk of resultChunks) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };
}

export async function buildTopN(executor, node) {
  const child = await executor.buildPipeline(node.children[0]);
  const keyExtractors = node.orderKeys.map(ok => ({
    eval: compileExpression(ok.expr, child.columnMapping),
    direction: ok.direction || 'ASC',
  }));

  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      const spillHandle = executor.tempManager.allocate('spill', 'topn');
      const sortOp = new SortOperator(keyExtractors, node.count, node.offset || 0, executor.storageBackend.createSpillManager(spillHandle));
      const sortSink = {
        async consume(chunk) { await sortOp.consume(chunk); },
        async finalize() {}
      };
      const childPipelineId = graph.createPipeline(sortSink);
      child.register(graph, childPipelineId, sortSink);

      graph.addDependency(currentPipelineId, childPipelineId);

      graph.setSource(currentPipelineId, async function* () {
        const resultChunks = await sortOp.finalize();
        for (const chunk of resultChunks) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };
}

export async function buildLimit(executor, node) {
  const child = await executor.buildPipeline(node.children[0]);
  const limit = node.count;
  const offset = node.offset || 0;

  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      const limitOp = new LimitOperator(limit, offset);
      const cancelToken = new CancelToken();
      const childSink = {
        async consume(chunk) {
          if (cancelToken.isCancelled) return;
          await limitOp.consume(chunk);
          const resultChunks = await limitOp.finalize();
          for (const rc of resultChunks) {
            if (rc.size > 0) await currentSink.consume(rc);
          }
          limitOp.chunks = [];
          if (limitOp.done) {
            cancelToken.cancel();
          }
        },
        async finalize() {
          const resultChunks = await limitOp.finalize();
          for (const rc of resultChunks) {
            if (rc.size > 0) await currentSink.consume(rc);
          }
          if (currentSink.finalize) await currentSink.finalize();
        },
        cancelToken,
      };
      child.register(graph, currentPipelineId, childSink);
    }
  };
}

export async function buildDistinct(executor, node) {
  const child = await executor.buildPipeline(node.children[0]);

  return {
    schema: child.schema,
    columnMapping: child.columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      const distinctOp = new DistinctOperator();
      const childSink = {
        async consume(chunk) {
          const result = await distinctOp.process(chunk);
          if (result && result.size > 0) {
            await currentSink.consume(result);
          }
        },
        async finalize() {
          if (currentSink.finalize) await currentSink.finalize();
        }
      };
      child.register(graph, currentPipelineId, childSink);
    }
  };
}

export async function buildUnion(executor, node) {
  const left = await executor.buildPipeline(node.children[0]);
  const right = await executor.buildPipeline(node.children[1]);

  return {
    schema: left.schema,
    columnMapping: left.columnMapping,
    register: (graph, currentPipelineId, currentSink) => {
      if (!node.all) {
        const unionOp = new UnionOperator(false);
        const dedupSink = {
          async consume(chunk) {
            const result = await unionOp.process(chunk);
            if (result && result.size > 0) {
              await currentSink.consume(result);
            }
          },
          async finalize() {}
        };

        const leftPipelineId = graph.createPipeline(dedupSink);
        const rightPipelineId = graph.createPipeline(dedupSink);

        left.register(graph, leftPipelineId, dedupSink);
        right.register(graph, rightPipelineId, dedupSink);

        graph.addDependency(rightPipelineId, leftPipelineId);
        graph.addDependency(currentPipelineId, rightPipelineId);

        graph.setSource(currentPipelineId, async function* () {
          if (currentSink.finalize) await currentSink.finalize();
        });
      } else {
        const leftPipelineId = graph.createPipeline(currentSink);
        const rightPipelineId = graph.createPipeline(currentSink);

        left.register(graph, leftPipelineId, currentSink);
        right.register(graph, rightPipelineId, currentSink);

        graph.addDependency(currentPipelineId, leftPipelineId);
        graph.addDependency(currentPipelineId, rightPipelineId);

        graph.setSource(currentPipelineId, async function* () {
        });
      }
    }
  };
}

export async function buildWindow(executor, node) {
  const child = await executor.buildPipeline(node.children[0]);
  const windowExprs = node.windowExprs;

  const windowSchema = [
    ...child.schema,
    ...windowExprs.map((w, i) => ({
      name: `__window_${i}`,
      dataType: executor.normalizeExecType(w.resultType || 'FLOAT64'),
      tableAlias: '',
    })),
  ];
  const windowMapping = new Map();
  let idx = 0;
  for (const col of windowSchema) {
    const key = col.tableAlias ? `${col.tableAlias}.${col.name}`.toUpperCase() : col.name.toUpperCase();
    windowMapping.set(key, idx);
    if (!windowMapping.has(col.name.toUpperCase())) {
      windowMapping.set(col.name.toUpperCase(), idx);
    }
    idx++;
  }
  for (let w = 0; w < windowExprs.length; w++) {
    const wKey = windowExprKey(windowExprs[w]);
    windowMapping.set(wKey, child.schema.length + w);
  }

  return {
    schema: windowSchema,
    columnMapping: windowMapping,
    register: (graph, currentPipelineId, currentSink) => {
      const childChunks = registerBufferedChild(graph, currentPipelineId, child);

      graph.setSource(currentPipelineId, async function* () {
        const windowOp = new WindowOperator(windowExprs, child.schema, child.columnMapping, compileExpression);
        const resultChunks = await windowOp.execute(childChunks);
        for (const chunk of resultChunks) {
          await currentSink.consume(chunk);
          yield chunk;
        }
        if (currentSink.finalize) await currentSink.finalize();
      });
    }
  };
}

function windowExprKey(expr) {
  const name = expr.name?.toUpperCase() || 'WIN';
  const argKey = (expr.args || []).map(a => {
    if (a.kind === BoundExprKind.COLUMN_REF) return `${a.tableAlias}.${a.columnName}`.toUpperCase();
    return JSON.stringify(a).slice(0, 30);
  }).join(',');
  const partKey = (expr.partitionBy || []).map(p => {
    if (p.kind === BoundExprKind.COLUMN_REF) return `${p.tableAlias}.${p.columnName}`.toUpperCase();
    return '';
  }).join(',');
  return `__WIN__${name}(${argKey})[${partKey}]`;
}
