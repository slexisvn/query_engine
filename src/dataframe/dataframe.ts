import {
  LogicalProject,
  LogicalFilter,
  LogicalAggregate,
  LogicalSort,
  LogicalLimit,
  LogicalDistinct,
  LogicalUnion,
  LogicalJoin,
  JoinType,
  SortDirection,
  planToString,
} from '../planner/logical-plan.js';
import type { LogicalPlanNode, ProjectedExpr } from '../planner/logical-plan.js';
import {
  BoundColumnRef,
  BoundBinary,
  BoundFunction,
  BoundAggregate,
  BoundExprKind,
  getExprType,
} from '../binder/expression-binder.js';
import type { BoundExpr, BoundColumnRefNode } from '../binder/expression-binder.js';
import { DataType, isComparable } from '../storage/data-type.js';
import type { ColumnValue } from '../storage/data-type.js';
import type { DataChunk } from '../storage/chunk.js';
import { DFField, DFSchema } from './schema.js';
import { Col, col, expr } from './column-expr.js';
import type { CatalogLike } from '../binder/binder.js';
import type { Catalog } from '../catalog/catalog.js';
import type { defaultFunctionRegistry } from '../catalog/function-registry.js';

const LEFT_JOIN_PREFIX = '__l';
const RIGHT_JOIN_PREFIX = '__r';
const SELF_FRAME_NAME = 'self';

type FunctionRegistry = typeof defaultFunctionRegistry;

type CteMap = Map<string, LogicalPlanNode>;

interface BindContext {
  catalog: CatalogLike;
  functionRegistry: FunctionRegistry;
}

interface BoundColumn {
  expr: BoundExpr;
  outputName: string | null;
  dataType: string | null;
}

interface OutputColumnLike {
  name: string;
  expr: BoundExpr | null;
  dataType: DataType | string | null;
}

interface ResultLike {
  toArray(): Promise<Record<string, ColumnValue>[]>;
  chunks(): AsyncGenerator<DataChunk>;
}

interface SqlFrameLike {
  name: string;
  columns: { name: string; dataType: DataType }[];
  plan: LogicalPlanNode;
  cteMap: CteMap | null;
}

interface EngineLike {
  catalog: Catalog;
  functionRegistry: FunctionRegistry;
  sql(sqlString: string, options: { frames: SqlFrameLike[]; params?: readonly ColumnValue[] }): DataFrame;
  _nextDfId(): number;
  _runPlan(plan: LogicalPlanNode, outputColumns: OutputColumnLike[], streaming: boolean, cteMap: CteMap | null): Promise<ResultLike>;
}

interface OrderByDescriptor {
  col: Col | string;
  desc?: boolean;
}

type OrderBySpec = OrderByDescriptor | Col | string;

interface AggregateGroupField {
  ref: BoundColumnRefNode;
  outputName: string;
  dataType: DataType;
}

function fieldCol(field: DFField): Col {
  return new Col(
    () => BoundColumnRef(field.tableAlias, field.name, field.index, field.dataType),
    field.name,
  );
}

function reconcileKeyType(left: DataType, right: DataType): DataType {
  if (left === right) return left;
  if (left === DataType.VARCHAR) return right;
  if (right === DataType.VARCHAR) return left;
  return left;
}

function coalesceCol(leftName: string, rightName: string, dataType: DataType): Col {
  return new Col((schema, ctx) => BoundFunction('COALESCE', [
    col(leftName).bind(schema, ctx).expr,
    col(rightName).bind(schema, ctx).expr,
  ], dataType));
}

function selectArg(item: Col | string): Col {
  if (item instanceof Col) return item;
  return col(item);
}

function predicateArg(item: Col | string): Col {
  if (item instanceof Col) return item;
  return expr(item);
}

function uniquify(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map(name => {
    const key = name.toUpperCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    return count === 0 ? name : `${name}_${count}`;
  });
}

export class DataFrame {
  _engine: EngineLike;
  _plan: LogicalPlanNode;
  _schema: DFSchema;
  _cteMap: CteMap | null;

  constructor(engine: EngineLike, plan: LogicalPlanNode, schema: DFSchema, cteMap: CteMap | null = null) {
    this._engine = engine;
    this._plan = plan;
    this._schema = schema;
    this._cteMap = cteMap;
  }

  _ctx(): BindContext {
    return { catalog: this._engine.catalog as CatalogLike, functionRegistry: this._engine.functionRegistry };
  }

  _derive(plan: LogicalPlanNode, schema: DFSchema, extraCteMap: CteMap | null = null): DataFrame {
    return new DataFrame(this._engine, plan, schema, mergeCteMaps(this._cteMap, extraCteMap));
  }

  columns(): string[] {
    return this._schema.names();
  }

  schema(): DFSchema {
    return this._schema;
  }

  explain(): string {
    return planToString(this._plan);
  }

  sql(sqlString: string, options: { params?: readonly ColumnValue[] } = {}): DataFrame {
    const columns = this._schema.fields.map(f => ({ name: f.name, dataType: f.dataType }));
    return this._engine.sql(sqlString, {
      frames: [{
        name: SELF_FRAME_NAME,
        columns,
        plan: this._plan,
        cteMap: this._cteMap,
      }],
      params: options.params,
    });
  }

  select(...items: (Col | string)[]): DataFrame {
    const ctx = this._ctx();
    const bounds = items.map(item => selectArg(item).bind(this._schema, ctx));
    const exprs = bounds.map(b => b.expr) as ProjectedExpr[];
    const fields = bounds.map((b, i) => new DFField(b.outputName || `col${i}`, b.dataType as DataType, i, ''));
    return this._derive(LogicalProject(exprs, this._plan), DFSchema.fromFields(fields));
  }

  filter(condition: Col | string): DataFrame {
    const { expr: cond, dataType } = predicateArg(condition).bind(this._schema, this._ctx());
    if (dataType !== DataType.BOOLEAN) {
      throw new TypeError(`filter condition must be boolean, got ${dataType}`);
    }
    return this._derive(LogicalFilter(cond, this._plan), this._schema);
  }

  where(condition: Col | string): DataFrame {
    return this.filter(condition);
  }

  withColumn(name: string, column: Col | string): DataFrame {
    const replacement = (column instanceof Col ? column : expr(column)).alias(name);
    const idx = this._schema.fields.findIndex(f => f.name.toUpperCase() === name.toUpperCase());
    const items = idx >= 0
      ? this._schema.fields.map((f, i) => (i === idx ? replacement : fieldCol(f)))
      : [...this._schema.fields.map(fieldCol), replacement];
    return this.select(...items);
  }

  drop(...names: string[]): DataFrame {
    for (const name of names) this._schema.resolve(name);
    const removed = new Set(names.map(n => n.toUpperCase()));
    const items = this._schema.fields
      .filter(f => !removed.has(f.name.toUpperCase()))
      .map(fieldCol);
    return this.select(...items);
  }

  groupBy(...items: (Col | string)[]): GroupedData {
    const ctx = this._ctx();
    const bounds = items.map(item => selectArg(item).bind(this._schema, ctx));
    return new GroupedData(this._engine, this._plan, this._schema, bounds, this._cteMap);
  }

  orderBy(...specs: OrderBySpec[]): DataFrame {
    const ctx = this._ctx();
    const orderKeys = specs.map(spec => {
      const descriptor: OrderByDescriptor = spec && typeof spec === 'object' && !(spec instanceof Col)
        ? spec
        : { col: spec as Col | string, desc: false };
      const { expr: keyExpr } = selectArg(descriptor.col).bind(this._schema, ctx);
      return { expr: keyExpr, direction: descriptor.desc ? SortDirection.DESC : SortDirection.ASC };
    });
    return this._derive(LogicalSort(orderKeys, this._plan), this._schema);
  }

  sort(...specs: OrderBySpec[]): DataFrame {
    return this.orderBy(...specs);
  }

  limit(count: number, offset: number = 0): DataFrame {
    return this._derive(LogicalLimit(count, offset, this._plan), this._schema);
  }

  distinct(): DataFrame {
    return this._derive(LogicalDistinct(this._plan), this._schema);
  }

  union(other: DataFrame): DataFrame {
    return this._union(other, false);
  }

  unionAll(other: DataFrame): DataFrame {
    return this._union(other, true);
  }

  _union(other: DataFrame, all: boolean): DataFrame {
    if (this._schema.length !== other._schema.length) {
      throw new TypeError(`union requires equal column counts: ${this._schema.length} vs ${other._schema.length}`);
    }
    for (let i = 0; i < this._schema.length; i++) {
      const a = this._schema.field(i).dataType;
      const b = other._schema.field(i).dataType;
      if (!isComparable(a, b)) {
        throw new TypeError(`union column ${i} type mismatch: ${a} vs ${b}`);
      }
    }
    const plan = LogicalUnion(this._plan, other._plan, all);
    return this._derive(plan, DFSchema.fromFields(this._schema.fields), other._cteMap);
  }

  join(other: DataFrame, on: string | string[], joinType: string = 'INNER'): DataFrame {
    const keys = Array.isArray(on) ? on : [on];
    const type = JoinType[joinType.toUpperCase() as keyof typeof JoinType];
    if (!type) throw new Error(`Unknown join type: ${joinType}`);

    const leftPrefix = `${LEFT_JOIN_PREFIX}${this._engine._nextDfId()}_`;
    const rightPrefix = `${RIGHT_JOIN_PREFIX}${this._engine._nextDfId()}_`;

    const leftRenamed = this.select(
      ...this._schema.fields.map(f => fieldCol(f).alias(`${leftPrefix}${f.name}`)));
    const rightRenamed = other.select(
      ...other._schema.fields.map(f => fieldCol(f).alias(`${rightPrefix}${f.name}`)));

    const ctx = this._ctx();
    let condition: BoundExpr | null = null;
    for (const key of keys) {
      const leftField = this._schema.resolve(key);
      const rightField = other._schema.resolve(key);
      const eq = BoundBinary(
        '=',
        col(`${leftPrefix}${leftField.name}`).bind(leftRenamed._schema, ctx).expr,
        col(`${rightPrefix}${rightField.name}`).bind(rightRenamed._schema, ctx).expr,
        DataType.BOOLEAN,
      );
      condition = condition ? BoundBinary('AND', condition, eq, DataType.BOOLEAN) : eq;
    }

    const preserveRight = type === JoinType.RIGHT;
    const physicalType = preserveRight ? JoinType.LEFT : type;
    const physicalChildren = preserveRight
      ? [rightRenamed._plan, leftRenamed._plan]
      : [leftRenamed._plan, rightRenamed._plan];

    const joinPlan = LogicalJoin(physicalType, condition, physicalChildren[0], physicalChildren[1]);
    const joined = new DataFrame(this._engine, joinPlan,
      leftRenamed._schema.append(rightRenamed._schema),
      mergeCteMaps(this._cteMap, other._cteMap));

    const keySet = new Set(keys.map(k => k.toUpperCase()));
    const keyByName = new Map(keys.map(k => {
      const lf = this._schema.resolve(k);
      const rf = other._schema.resolve(k);
      return [k.toUpperCase(), {
        left: `${leftPrefix}${lf.name}`,
        right: `${rightPrefix}${rf.name}`,
        dataType: reconcileKeyType(lf.dataType, rf.dataType),
      }];
    }));

    const projected: Col[] = [];
    const outputNames: string[] = [];
    for (const field of this._schema.fields) {
      const keyInfo = keyByName.get(field.name.toUpperCase());
      projected.push(keyInfo
        ? coalesceCol(keyInfo.left, keyInfo.right, keyInfo.dataType)
        : col(`${leftPrefix}${field.name}`));
      outputNames.push(field.name);
    }
    for (const field of other._schema.fields) {
      if (keySet.has(field.name.toUpperCase())) continue;
      projected.push(col(`${rightPrefix}${field.name}`));
      outputNames.push(field.name);
    }

    const unique = uniquify(outputNames);
    return joined.select(...projected.map((item, i) => item.alias(unique[i])));
  }

  _outputColumns(): OutputColumnLike[] {
    return this._schema.fields.map(f => ({ name: f.name, expr: null, dataType: f.dataType }));
  }

  async collect(): Promise<Record<string, ColumnValue>[]> {
    const result = await this._engine._runPlan(this._plan, this._outputColumns(), false, this._cteMap);
    return result.toArray();
  }

  toArray(): Promise<Record<string, ColumnValue>[]> {
    return this.collect();
  }

  async count(): Promise<number> {
    const agg = BoundAggregate('COUNT_STAR', [], false, DataType.INT64);
    (agg as ProjectedExpr).outputName = 'count';
    const plan = LogicalAggregate([], [agg], this._plan);
    const outputColumns: OutputColumnLike[] = [{ name: 'count', expr: null, dataType: DataType.INT64 }];
    const result = await this._engine._runPlan(plan, outputColumns, false, this._cteMap);
    const rows = await result.toArray();
    return rows.length > 0 ? Number(rows[0].count) : 0;
  }

  async *chunks(): AsyncGenerator<DataChunk> {
    const result = await this._engine._runPlan(this._plan, this._outputColumns(), true, this._cteMap);
    for await (const chunk of result.chunks()) {
      yield chunk;
    }
  }

  async show(n: number = 20): Promise<string> {
    const rows = await this.limit(n).collect();
    const names = this._schema.names();
    const widths = names.map((name, i) => {
      let width = name.length;
      for (const row of rows) {
        const text = formatCell(row[names[i]]);
        if (text.length > width) width = text.length;
      }
      return width;
    });
    const renderRow = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join(' | ');
    const separator = widths.map(w => '-'.repeat(w)).join('-+-');
    const lines = [renderRow(names), separator];
    for (const row of rows) {
      lines.push(renderRow(names.map(name => formatCell(row[name]))));
    }
    const output = lines.join('\n');
    console.log(output);
    return output;
  }
}

function formatCell(value?: ColumnValue): string {
  if (value === null || value === undefined) return 'NULL';
  return String(value);
}

function mergeCteMaps(a: CteMap | null, b: CteMap | null): CteMap | null {
  if (!a && !b) return null;
  const merged: CteMap = new Map();
  if (a) for (const [k, v] of a) merged.set(k, v);
  if (b) for (const [k, v] of b) merged.set(k, v);
  return merged;
}

function aggregateGroupField(groupExpr: BoundExpr, bound: BoundColumn, index: number): AggregateGroupField {
  const name = groupExpr.kind === BoundExprKind.COLUMN_REF ? groupExpr.columnName : `group${index}`;
  const tableAlias = (groupExpr as BoundColumnRefNode).tableAlias || '';
  return {
    ref: BoundColumnRef(tableAlias, name, index, getExprType(groupExpr)),
    outputName: bound.outputName || name,
    dataType: bound.dataType as DataType,
  };
}

export class GroupedData {
  _engine: EngineLike;
  _childPlan: LogicalPlanNode;
  _childSchema: DFSchema;
  _groupBounds: BoundColumn[];
  _cteMap: CteMap | null;

  constructor(engine: EngineLike, childPlan: LogicalPlanNode, childSchema: DFSchema, groupBounds: BoundColumn[], cteMap: CteMap | null) {
    this._engine = engine;
    this._childPlan = childPlan;
    this._childSchema = childSchema;
    this._groupBounds = groupBounds;
    this._cteMap = cteMap;
  }

  agg(...aggColumns: Col[]): DataFrame {
    const ctx: BindContext = { catalog: this._engine.catalog as CatalogLike, functionRegistry: this._engine.functionRegistry };
    const aggBounds = aggColumns.map(c => c.bind(this._childSchema, ctx));

    const groupExprs = this._groupBounds.map(b => b.expr);
    const aggregates = aggBounds.map(b => b.expr);
    const aggPlan = LogicalAggregate(groupExprs, aggregates, this._childPlan);

    const groupProjections: BoundExpr[] = [];
    const groupFields: DFField[] = [];
    for (let i = 0; i < this._groupBounds.length; i++) {
      const resolved = aggregateGroupField(groupExprs[i], this._groupBounds[i], i);
      (resolved.ref as ProjectedExpr).outputName = resolved.outputName;
      groupProjections.push(resolved.ref);
      groupFields.push(new DFField(resolved.outputName, resolved.dataType, i, ''));
    }

    const aggProjections: BoundExpr[] = [];
    const aggFields: DFField[] = [];
    for (let a = 0; a < aggBounds.length; a++) {
      const bound = aggBounds[a];
      const outputName = bound.outputName || (aggregates[a] as { name: string }).name.toLowerCase();
      (bound.expr as ProjectedExpr).outputName = outputName;
      aggProjections.push(bound.expr);
      aggFields.push(new DFField(outputName, bound.dataType as DataType, this._groupBounds.length + a, ''));
    }

    const projectPlan = LogicalProject([...groupProjections, ...aggProjections] as ProjectedExpr[], aggPlan);
    const schema = DFSchema.aggregateOutput(groupFields, aggFields);
    return new DataFrame(this._engine, projectPlan, schema, this._cteMap);
  }
}
