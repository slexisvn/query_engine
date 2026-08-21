import { PlanNodeType, type LogicalPlanNode } from '../planner/logical-plan.js';
import type { ColumnInfo } from '../binder/scope.js';
import { BoundExprKind } from '../binder/expression-binder.js';
import type {
  BoundExpr,
  BoundColumnRefNode,
  BoundAggregateNode,
} from '../binder/expression-binder.js';
import { DataType, byteWidthFor } from '../storage/data-type.js';
import { compileExpression } from './expression-eval.js';
import { FilterOperator } from './operators/filter.js';
import { ProjectionOperator } from './operators/projection.js';
import { HashAggregateOperator, getAccumulatorFactory } from './operators/hash-aggregate.js';
import type { DataChunk } from '../storage/chunk.js';
import type { ColumnValue } from '../storage/data-type.js';
import type {
  CompiledExpr,
  ColumnMapping,
  ExecColumn,
  ExecSchema,
  EvalValue,
} from './execution-types.js';
import { optionalColumnIndex, UNRESOLVED_COLUMN } from './column-resolve.js';

export enum StageKind {
  FILTER = 'filter',
  PROJECT = 'project',
}

interface FilterStage {
  kind: StageKind.FILTER;
  condition: BoundExpr | null;
}

interface ProjectStage {
  kind: StageKind.PROJECT;
  expressions: BoundExpr[];
}

export type Stage = FilterStage | ProjectStage;

interface AggregateSpec {
  name: string;
  distinct: boolean;
  args: BoundExpr[];
}

interface AggregateDef {
  name: string;
  valueKey: string | null;
  resultType: DataType;
  createAccumulator: ReturnType<typeof getAccumulatorFactory>;
  extractValue: CompiledExpr;
  _wasmColIndex?: number;
  _sourceExpr: BoundExpr | null;
  _columnMapping: ColumnMapping;
}

interface ScanChain {
  table: string;
  alias: string;
  scanColumns: ColumnInfo[];
  stages: Stage[];
}

export interface StageChain {
  baseSchema: ExecSchema;
  stages: Stage[];
}

export interface FragmentSpec {
  source: StageChain;
  groupBy: BoundExpr[];
  aggregates: AggregateSpec[];
}

interface BuiltFragmentSpec {
  spec: FragmentSpec;
  columnIndexes: number[];
  estimatedRowBytes: number;
}

interface InstantiatedStages {
  operators: (FilterOperator | ProjectionOperator)[];
  schema: ExecSchema;
  mapping: ColumnMapping;
}

interface InstantiatedFragment {
  operators: (FilterOperator | ProjectionOperator)[];
  aggregate: HashAggregateOperator;
}

interface JoinSpecInput {
  build: StageChain;
  probe: StageChain;
  buildKeys: BoundExpr[];
  probeKeys: BoundExpr[];
  residualCondition: BoundExpr | null;
  joinType: string;
  buildPreserved: boolean;
  uniqueKeys: boolean;
  buildMapping: ColumnMapping;
  probeMapping: ColumnMapping;
  combinedMapping: ColumnMapping;
}

export interface JoinSpec {
  build: StageChain;
  probe: StageChain;
  buildKeys: BoundExpr[];
  probeKeys: BoundExpr[];
  residualCondition: BoundExpr | null;
  joinType: string;
  buildPreserved: boolean;
  uniqueKeys: boolean;
}

interface InstantiatedJoinSpec {
  buildOperators: (FilterOperator | ProjectionOperator)[];
  probeOperators: (FilterOperator | ProjectionOperator)[];
  buildExtractors: CompiledExpr[];
  probeExtractors: CompiledExpr[];
  conditionEvaluator: CompiledExpr | null;
  buildColCount: number;
  probeColCount: number;
}

interface AggregateLike {
  name?: string;
  resultType?: DataType | null;
}

interface ExprMeta {
  outputName?: string;
  alias?: string;
  name?: string;
  columnName?: string;
  dataType?: DataType | string | null;
  resultType?: DataType | string | null;
}

const WIDE_STORAGE_TYPES: ReadonlySet<DataType> = new Set([
  DataType.DECIMAL,
  DataType.INT64,
  DataType.TIMESTAMP,
]);

export function normalizeExecType(dt: DataType | string): DataType {
  if (WIDE_STORAGE_TYPES.has(dt as DataType)) return DataType.FLOAT64;
  return dt as DataType;
}

const VALUE_PRESERVING_AGGREGATES: ReadonlySet<string> = new Set(['MIN', 'MAX']);

export function normalizeAggResultType(agg: BoundAggregateNode | AggregateLike): DataType {
  const name = (agg.name || '').toUpperCase();
  if (name === 'COUNT' || name === 'COUNT_STAR') return DataType.INT32;
  if (VALUE_PRESERVING_AGGREGATES.has(name)) return normalizeExecType(agg.resultType || DataType.FLOAT64);
  return DataType.FLOAT64;
}

export function expressionCacheKey(expr: BoundExpr | null): string {
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

export function schemaMappingOf(schema: ExecSchema): ColumnMapping {
  const mapping: ColumnMapping = new Map();
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

export function projectionSchemaOf(expressions: BoundExpr[]): ExecSchema {
  return expressions.map((expr: BoundExpr, i: number) => {
    const meta = expr as ExprMeta;
    return {
      name: meta?.outputName || meta?.alias || meta?.name || meta?.columnName || `col${i}`,
      dataType: normalizeExecType(meta?.dataType || meta?.resultType || DataType.VARCHAR),
      tableAlias: '',
    };
  });
}

export function collectColumnRefs(
  node: BoundExpr | BoundExpr[] | null,
  acc: BoundColumnRefNode[] = [],
): BoundColumnRefNode[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectColumnRefs(item, acc);
    return acc;
  }
  if (node.kind === BoundExprKind.COLUMN_REF) {
    acc.push(node);
    return acc;
  }
  for (const value of Object.values(node)) {
    collectColumnRefs(value as BoundExpr | BoundExpr[] | null, acc);
  }
  return acc;
}

export function resolveRef(ref: BoundColumnRefNode, mapping: ColumnMapping): number | undefined {
  const qualified = `${ref.tableAlias || ''}.${ref.columnName}`.toUpperCase();
  if (mapping.has(qualified)) return mapping.get(qualified);
  const bare = String(ref.columnName).toUpperCase();
  if (mapping.has(bare)) return mapping.get(bare);
  return undefined;
}

function exprResolvable(exprOrList: BoundExpr | BoundExpr[] | null, mapping: ColumnMapping): boolean {
  for (const ref of collectColumnRefs(exprOrList)) {
    if (resolveRef(ref, mapping) === undefined) return false;
  }
  return true;
}

export function buildAggregateDefs(aggregates: AggregateSpec[], columnMapping: ColumnMapping): AggregateDef[] {
  const valueKeyCounts = new Map<string, number>();
  for (const agg of aggregates) {
    if (!agg.args || agg.args.length === 0) continue;
    const key = expressionCacheKey(agg.args[0]);
    valueKeyCounts.set(key, (valueKeyCounts.get(key) || 0) + 1);
  }

  return aggregates.map((agg: AggregateSpec) => {
    const hasArgs = agg.args && agg.args.length > 0;
    const valueExtractor: CompiledExpr = hasArgs
      ? compileExpression(agg.args[0], columnMapping)
      : () => 1;
    const valueKey = hasArgs ? expressionCacheKey(agg.args[0]) : null;

    let wasmColIndex: number | undefined;
    if (hasArgs && agg.args[0].kind === BoundExprKind.COLUMN_REF) {
      const resolved = resolveRef(agg.args[0], columnMapping);
      if (resolved !== undefined) wasmColIndex = resolved;
    }

    return {
      name: agg.name,
      valueKey: valueKey && (valueKeyCounts.get(valueKey) ?? 0) > 1 ? valueKey : null,
      resultType: normalizeAggResultType(agg),
      distinct: !!agg.distinct,
      createAccumulator: getAccumulatorFactory(agg.name, agg.distinct),
      extractValue: (chunk: DataChunk, rowIdx: number): EvalValue => {
        const val = valueExtractor(chunk, rowIdx);
        return typeof val === 'bigint' ? Number(val) : val;
      },
      _wasmColIndex: wasmColIndex,
      _sourceExpr: hasArgs ? agg.args[0] : null,
      _columnMapping: columnMapping,
    };
  });
}

export function extractScanChain(startNode: LogicalPlanNode | null): ScanChain | null {
  const stages: Stage[] = [];
  let current: LogicalPlanNode | null = startNode;
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

export function extractAggregateFragment(node: LogicalPlanNode): ScanChain | null {
  return extractScanChain((node.children || [])[0] ?? null);
}

export function stageChainSchema({ baseSchema, stages }: StageChain): ExecSchema {
  let schema = baseSchema;
  for (const stage of stages) {
    if (stage.kind === StageKind.PROJECT) {
      schema = projectionSchemaOf(stage.expressions);
    }
  }
  return schema;
}

export function stageChainResolvable({ baseSchema, stages }: StageChain): boolean {
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

export function instantiateStageChain({ baseSchema, stages }: StageChain): InstantiatedStages {
  let schema = baseSchema;
  let mapping = schemaMappingOf(schema);
  const operators: (FilterOperator | ProjectionOperator)[] = [];

  for (const stage of stages) {
    if (stage.kind === StageKind.FILTER) {
      const evaluator = compileExpression(stage.condition, mapping);
      operators.push(new FilterOperator(stage.condition, evaluator, mapping, null));
    } else {
      const evaluators = stage.expressions.map((expr: BoundExpr) => compileExpression(expr, mapping));
      const resultTypes = stage.expressions.map((expr: BoundExpr) => {
        const meta = expr as ExprMeta;
        return normalizeExecType(meta?.dataType || meta?.resultType || DataType.VARCHAR);
      });
      operators.push(new ProjectionOperator(stage.expressions, evaluators, resultTypes, mapping, null));
      schema = projectionSchemaOf(stage.expressions);
      mapping = schemaMappingOf(schema);
    }
  }

  return { operators, schema, mapping };
}

export function buildFragmentSpec(
  fragment: ScanChain,
  node: LogicalPlanNode & { groupBy?: BoundExpr[]; aggregates: BoundExpr[] },
  storageSchema: ExecSchema,
): BuiltFragmentSpec | null {
  const aliased: ExecSchema = storageSchema.map((col: ExecColumn) => ({
    name: col.name,
    dataType: col.dataType,
    tableAlias: fragment.alias,
  }));

  const baseRefs: BoundColumnRefNode[] = [];
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
    for (const agg of node.aggregates as BoundAggregateNode[]) collectColumnRefs(agg.args || [], baseRefs);
  }

  const fullMapping = schemaMappingOf(aliased);
  const needed = new Set<number>();
  for (const ref of baseRefs) {
    const idx = resolveRef(ref, fullMapping);
    if (idx === undefined) return null;
    needed.add(idx);
  }

  const columnIndexes = Array.from(needed).sort((a, b) => a - b);
  const baseSchema = columnIndexes.map((i: number) => aliased[i]);

  const spec: FragmentSpec = {
    source: { baseSchema, stages: fragment.stages },
    groupBy: node.groupBy || [],
    aggregates: (node.aggregates as BoundAggregateNode[]).map((agg: BoundAggregateNode) => ({
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

function validateFragmentSpec(spec: FragmentSpec): boolean {
  if (!stageChainResolvable(spec.source)) return false;
  const mapping = schemaMappingOf(stageChainSchema(spec.source));
  for (const groupExpr of spec.groupBy) {
    if (!exprResolvable(groupExpr, mapping)) return false;
  }
  for (const agg of spec.aggregates) {
    if (!exprResolvable(agg.args, mapping)) return false;
  }
  return true;
}

export function instantiateFragment(spec: FragmentSpec): InstantiatedFragment {
  const { operators, mapping } = instantiateStageChain(spec.source);

  const groupByEvals = spec.groupBy.map((expr: BoundExpr) => compileExpression(expr, mapping));
  const groupByTypes = spec.groupBy.map((expr: BoundExpr) => {
    const meta = expr as ExprMeta;
    return normalizeExecType(meta?.dataType || meta?.resultType || DataType.VARCHAR);
  });
  const aggDefs = buildAggregateDefs(spec.aggregates, mapping);

  return {
    operators,
    aggregate: new HashAggregateOperator(groupByEvals, groupByTypes, aggDefs),
  };
}

export function instantiateAggregate(spec: FragmentSpec): HashAggregateOperator {
  return instantiateFragment(spec).aggregate;
}

function refsResolveIdentically(
  exprOrList: BoundExpr | BoundExpr[] | null,
  mainMapping: ColumnMapping,
  workerMapping: ColumnMapping,
): boolean {
  for (const ref of collectColumnRefs(exprOrList)) {
    const mainIdx = optionalColumnIndex(ref, mainMapping);
    if (mainIdx === UNRESOLVED_COLUMN) return false;
    if (mainIdx !== optionalColumnIndex(ref, workerMapping)) return false;
  }
  return true;
}

export function plainSchemaOf(schema: ExecSchema): ExecSchema {
  return schema.map((col: ExecColumn) => ({ name: col.name, dataType: col.dataType, tableAlias: col.tableAlias || '' }));
}

export function schemasEqual(a: ExecSchema, b: ExecSchema): boolean {
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
}: JoinSpecInput): JoinSpec | null {
  if (!stageChainResolvable(build)) return null;
  if (!stageChainResolvable(probe)) return null;

  const buildSchema = stageChainSchema(build);
  const probeSchema = stageChainSchema(probe);
  const workerBuildMapping = schemaMappingOf(buildSchema);
  const workerProbeMapping = schemaMappingOf(probeSchema);
  const workerCombinedMapping = schemaMappingOf([...buildSchema, ...probeSchema]);

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
  };
}

export function instantiateJoinSpec(spec: JoinSpec): InstantiatedJoinSpec {
  const build = instantiateStageChain(spec.build);
  const probe = instantiateStageChain(spec.probe);
  const combinedMapping = schemaMappingOf([...build.schema, ...probe.schema]);
  return {
    buildOperators: build.operators,
    probeOperators: probe.operators,
    buildExtractors: spec.buildKeys.map((key: BoundExpr) => compileExpression(key, build.mapping)),
    probeExtractors: spec.probeKeys.map((key: BoundExpr) => compileExpression(key, probe.mapping)),
    conditionEvaluator: spec.residualCondition
      ? compileExpression(spec.residualCondition, combinedMapping)
      : null,
    buildColCount: build.schema.length,
    probeColCount: probe.schema.length,
  };
}
