import { PlanNodeType } from '../planner/logical-plan.js';
import { BoundExprKind } from '../binder/expression-binder.js';
import { DataType, byteWidthFor } from '../storage/data-type.js';
import { compileExpression } from './expression-eval.js';
import { FilterOperator } from './operators/filter.js';
import { ProjectionOperator } from './operators/projection.js';
import { HashAggregateOperator, getAccumulatorFactory } from './operators/hash-aggregate.js';

export enum StageKind {
  FILTER = 'filter',
  PROJECT = 'project',
}

export function normalizeExecType(dt: any): any {
  if (dt === DataType.DECIMAL || dt === DataType.INT64) return DataType.FLOAT64;
  return dt;
}

export function normalizeAggResultType(agg: any): any {
  const name = (agg.name || '').toUpperCase();
  if (name === 'COUNT' || name === 'COUNT_STAR') return DataType.INT32;
  return DataType.FLOAT64;
}

export function expressionCacheKey(expr: any): any {
  if (!expr || typeof expr !== 'object') return String(expr);
  switch (expr.kind) {
    case BoundExprKind.COLUMN_REF:
      return `COL:${expr.tableAlias || ''}.${expr.columnName}`;
    case BoundExprKind.LITERAL:
      return `LIT:${String(expr.value)}`;
    case BoundExprKind.BINARY:
      return `BIN:${expr.op}:${expressionCacheKey(expr.left)}:${expressionCacheKey(expr.right)}`;
    case BoundExprKind.UNARY:
      return `UNARY:${expr.op}:${expressionCacheKey(expr.operand)}`;
    case BoundExprKind.CASE:
      return `CASE:${JSON.stringify(expr)}`;
    default:
      return JSON.stringify(expr);
  }
}

export function schemaMappingOf(schema: any): any {
  const mapping = new Map();
  for (let i = 0; i < schema.length; i++) {
    const col = schema[i];
    const key = `${col.tableAlias || ''}.${col.name}`.toUpperCase();
    mapping.set(key, i);
    if (!mapping.has(col.name.toUpperCase())) {
      mapping.set(col.name.toUpperCase(), i);
    }
  }
  return mapping;
}

export function projectionSchemaOf(expressions: any): any {
  return expressions.map((expr: any, i: number) => ({
    name: expr?.outputName || expr?.alias || expr?.name || expr?.columnName || `col${i}`,
    dataType: normalizeExecType(expr?.dataType || expr?.resultType || DataType.VARCHAR),
    tableAlias: '',
  }));
}

export function collectColumnRefs(node: any, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectColumnRefs(item, acc);
    return acc;
  }
  if (node.kind === BoundExprKind.COLUMN_REF) {
    acc.push(node);
    return acc;
  }
  for (const value of Object.values(node)) collectColumnRefs(value, acc);
  return acc;
}

export function resolveRef(ref: any, mapping: any): any {
  const qualified = `${ref.tableAlias || ''}.${ref.columnName}`.toUpperCase();
  if (mapping.has(qualified)) return mapping.get(qualified);
  const bare = String(ref.columnName).toUpperCase();
  if (mapping.has(bare)) return mapping.get(bare);
  return undefined;
}

function exprResolvable(exprOrList: any, mapping: any): boolean {
  for (const ref of collectColumnRefs(exprOrList)) {
    if (resolveRef(ref, mapping) === undefined) return false;
  }
  return true;
}

export function buildAggregateDefs(aggregates: any, columnMapping: any): any {
  const valueKeyCounts = new Map();
  for (const agg of aggregates) {
    if (!agg.args || agg.args.length === 0) continue;
    const key = expressionCacheKey(agg.args[0]);
    valueKeyCounts.set(key, (valueKeyCounts.get(key) || 0) + 1);
  }

  return aggregates.map((agg: any) => {
    const hasArgs = agg.args && agg.args.length > 0;
    const valueExtractor = hasArgs
      ? compileExpression(agg.args[0], columnMapping)
      : () => 1;
    const valueKey = hasArgs ? expressionCacheKey(agg.args[0]) : null;

    let wasmColIndex: any;
    if (hasArgs && agg.args[0].kind === BoundExprKind.COLUMN_REF) {
      const resolved = resolveRef(agg.args[0], columnMapping);
      if (resolved !== undefined) wasmColIndex = resolved;
    }

    return {
      name: agg.name,
      valueKey: valueKey && valueKeyCounts.get(valueKey) > 1 ? valueKey : null,
      resultType: normalizeAggResultType(agg),
      createAccumulator: getAccumulatorFactory(agg.name, agg.distinct),
      extractValue: (chunk: any, rowIdx: any) => {
        const val = valueExtractor(chunk, rowIdx);
        return typeof val === 'bigint' ? Number(val) : val;
      },
      _wasmColIndex: wasmColIndex,
      _sourceExpr: hasArgs ? agg.args[0] : null,
      _columnMapping: columnMapping,
    };
  });
}

export function extractStageChain(startNode: any): any {
  const stages: any[] = [];
  let current = startNode;
  while (current) {
    if (current.type === PlanNodeType.FILTER) {
      stages.push({ kind: StageKind.FILTER, condition: current.condition });
      current = current.children[0];
    } else if (current.type === PlanNodeType.PROJECT) {
      stages.push({ kind: StageKind.PROJECT, expressions: current.expressions });
      current = current.children[0];
    } else if (current.type === PlanNodeType.SCAN) {
      stages.reverse();
      return {
        table: current.table,
        alias: current.alias || current.table,
        scanColumns: current.columns,
        stages,
      };
    } else {
      return null;
    }
  }
  return null;
}

export function extractAggregateFragment(node: any): any {
  return extractStageChain(node.children[0]);
}

export function stagedSchemaOf(baseSchema: any, stages: any): any {
  let schema = baseSchema;
  for (const stage of stages) {
    if (stage.kind === StageKind.PROJECT) {
      schema = projectionSchemaOf(stage.expressions);
    }
  }
  return schema;
}

function stagesResolvable(baseSchema: any, stages: any): boolean {
  let schema = baseSchema;
  let mapping = schemaMappingOf(schema);
  for (const stage of stages) {
    if (stage.kind === StageKind.FILTER) {
      if (!exprResolvable(stage.condition, mapping)) return false;
    } else {
      if (!exprResolvable(stage.expressions, mapping)) return false;
      schema = projectionSchemaOf(stage.expressions);
      mapping = schemaMappingOf(schema);
    }
  }
  return true;
}

export function instantiateStages(baseSchema: any, stages: any): any {
  let schema = baseSchema;
  let mapping = schemaMappingOf(schema);
  const operators = [];

  for (const stage of stages) {
    if (stage.kind === StageKind.FILTER) {
      const evaluator = compileExpression(stage.condition, mapping);
      operators.push(new FilterOperator(stage.condition, evaluator, mapping, null));
    } else {
      const evaluators = stage.expressions.map((expr: any) => compileExpression(expr, mapping));
      const resultTypes = stage.expressions.map((expr: any) =>
        normalizeExecType(expr?.dataType || expr?.resultType || DataType.VARCHAR)
      );
      operators.push(new ProjectionOperator(stage.expressions, evaluators, resultTypes, mapping, null));
      schema = projectionSchemaOf(stage.expressions);
      mapping = schemaMappingOf(schema);
    }
  }

  return { operators, schema, mapping };
}

export function buildFragmentSpec(fragment: any, node: any, storageSchema: any): any {
  const aliased = storageSchema.map((col: any) => ({
    name: col.name,
    dataType: col.dataType,
    tableAlias: fragment.alias,
  }));

  const baseRefs: any[] = [];
  let prunedAtProject = false;
  for (const stage of fragment.stages) {
    if (stage.kind === StageKind.FILTER) {
      collectColumnRefs(stage.condition, baseRefs);
    } else {
      collectColumnRefs(stage.expressions, baseRefs);
      prunedAtProject = true;
      break;
    }
  }
  if (!prunedAtProject) {
    collectColumnRefs(node.groupBy || [], baseRefs);
    for (const agg of node.aggregates) collectColumnRefs(agg.args || [], baseRefs);
  }

  const fullMapping = schemaMappingOf(aliased);
  const needed = new Set<any>();
  for (const ref of baseRefs) {
    const idx = resolveRef(ref, fullMapping);
    if (idx === undefined) return null;
    needed.add(idx);
  }

  const columnIndexes = Array.from(needed).sort((a, b) => a - b);
  const baseSchema = columnIndexes.map((i: any) => aliased[i]);

  const spec = {
    baseSchema,
    stages: fragment.stages,
    groupBy: node.groupBy || [],
    aggregates: node.aggregates.map((agg: any) => ({
      name: agg.name,
      distinct: !!agg.distinct,
      args: agg.args || [],
    })),
  };

  if (!validateFragmentSpec(spec)) return null;

  let estimatedRowBytes = Math.ceil(columnIndexes.length / 8);
  for (const i of columnIndexes) {
    estimatedRowBytes += byteWidthFor(aliased[i].dataType) || Uint16Array.BYTES_PER_ELEMENT;
  }

  return { spec, columnIndexes, estimatedRowBytes };
}

function validateFragmentSpec(spec: any): boolean {
  if (!stagesResolvable(spec.baseSchema, spec.stages)) return false;
  const mapping = schemaMappingOf(stagedSchemaOf(spec.baseSchema, spec.stages));
  for (const groupExpr of spec.groupBy) {
    if (!exprResolvable(groupExpr, mapping)) return false;
  }
  for (const agg of spec.aggregates) {
    if (!exprResolvable(agg.args, mapping)) return false;
  }
  return true;
}

export function instantiateFragment(spec: any): any {
  const { operators, mapping } = instantiateStages(spec.baseSchema, spec.stages);

  const groupByEvals = spec.groupBy.map((expr: any) => compileExpression(expr, mapping));
  const groupByTypes = spec.groupBy.map((expr: any) =>
    normalizeExecType(expr?.dataType || expr?.resultType || DataType.VARCHAR)
  );
  const aggDefs = buildAggregateDefs(spec.aggregates, mapping);

  return {
    operators,
    aggregate: new HashAggregateOperator(groupByEvals, groupByTypes, aggDefs),
  };
}

export function instantiateAggregate(spec: any): any {
  return instantiateFragment(spec).aggregate;
}

function execResolvedIndex(ref: any, mapping: any): any {
  const qualified = `${ref.tableAlias}.${ref.columnName}`.toUpperCase();
  if (mapping.has(qualified)) return mapping.get(qualified);
  const bare = `${ref.columnName}`.toUpperCase();
  if (mapping.has(bare)) return mapping.get(bare);
  return ref.columnIndex;
}

function refsResolveIdentically(exprOrList: any, mainMapping: any, workerMapping: any): boolean {
  for (const ref of collectColumnRefs(exprOrList)) {
    const mainIdx = execResolvedIndex(ref, mainMapping);
    const workerIdx = execResolvedIndex(ref, workerMapping);
    if (mainIdx === undefined || mainIdx === null || mainIdx !== workerIdx) return false;
  }
  return true;
}

export function plainSchemaOf(schema: any): any {
  return schema.map((col: any) => ({ name: col.name, dataType: col.dataType, tableAlias: col.tableAlias || '' }));
}

export function schemasEqual(a: any, b: any): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name.toUpperCase() !== b[i].name.toUpperCase()) return false;
    if (a[i].dataType !== b[i].dataType) return false;
    if ((a[i].tableAlias || '').toUpperCase() !== (b[i].tableAlias || '').toUpperCase()) return false;
  }
  return true;
}

export function buildJoinSpec({
  build, probe, buildKeys, probeKeys, residualCondition,
  joinType, buildPreserved, uniqueKeys, buildMapping, probeMapping, combinedMapping,
}: any): any {
  if (!stagesResolvable(build.baseSchema, build.stages)) return null;
  if (!stagesResolvable(probe.baseSchema, probe.stages)) return null;

  const workerBuildMapping = schemaMappingOf(stagedSchemaOf(build.baseSchema, build.stages));
  const workerProbeMapping = schemaMappingOf(stagedSchemaOf(probe.baseSchema, probe.stages));
  const workerCombinedMapping = schemaMappingOf([...build.schema, ...probe.schema]);

  if (!refsResolveIdentically(buildKeys, buildMapping, workerBuildMapping)) return null;
  if (!refsResolveIdentically(probeKeys, probeMapping, workerProbeMapping)) return null;
  if (residualCondition && !refsResolveIdentically(residualCondition, combinedMapping, workerCombinedMapping)) return null;

  return {
    build,
    probe,
    buildKeys,
    probeKeys,
    residualCondition: residualCondition || null,
    joinType,
    buildPreserved: !!buildPreserved,
    uniqueKeys: !!uniqueKeys,
    buildColCount: build.schema.length,
    probeColCount: probe.schema.length,
  };
}

export function instantiateJoinSpec(spec: any): any {
  const build = instantiateStages(spec.build.baseSchema, spec.build.stages);
  const probe = instantiateStages(spec.probe.baseSchema, spec.probe.stages);
  const combinedMapping = schemaMappingOf([...spec.build.schema, ...spec.probe.schema]);
  return {
    buildOperators: build.operators,
    probeOperators: probe.operators,
    buildExtractors: spec.buildKeys.map((key: any) => compileExpression(key, build.mapping)),
    probeExtractors: spec.probeKeys.map((key: any) => compileExpression(key, probe.mapping)),
    conditionEvaluator: spec.residualCondition
      ? compileExpression(spec.residualCondition, combinedMapping)
      : null,
  };
}
