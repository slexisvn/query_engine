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
import {
  BoundColumnRef,
  BoundBinary,
  BoundFunction,
  BoundAggregate,
  BoundExprKind,
  getExprType,
} from '../binder/expression-binder.js';
import { DataType, isComparable } from '../storage/data-type.js';
import { DFField, DFSchema } from './schema.js';
import { Col, col, expr } from './column-expr.js';

const LEFT_JOIN_PREFIX = '__l';
const RIGHT_JOIN_PREFIX = '__r';

function fieldCol(field) {
  return new Col(
    () => BoundColumnRef(field.tableAlias, field.name, field.index, field.dataType),
    field.name,
  );
}

function reconcileKeyType(left, right) {
  if (left === right) return left;
  if (left === DataType.VARCHAR) return right;
  if (right === DataType.VARCHAR) return left;
  return left;
}

function coalesceCol(leftName, rightName, dataType) {
  return new Col((schema, ctx) => BoundFunction('COALESCE', [
    col(leftName).bind(schema, ctx).expr,
    col(rightName).bind(schema, ctx).expr,
  ], dataType));
}

function selectArg(item) {
  if (item instanceof Col) return item;
  return col(item);
}

function predicateArg(item) {
  if (item instanceof Col) return item;
  return expr(item);
}

function uniquify(names) {
  const seen = new Map();
  return names.map(name => {
    const key = name.toUpperCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    return count === 0 ? name : `${name}_${count}`;
  });
}

export class DataFrame {
  constructor(engine, plan, schema, cteMap = null) {
    this._engine = engine;
    this._plan = plan;
    this._schema = schema;
    this._cteMap = cteMap;
  }

  _ctx() {
    return { catalog: this._engine.catalog, functionRegistry: this._engine.functionRegistry };
  }

  _derive(plan, schema, extraCteMap = null) {
    return new DataFrame(this._engine, plan, schema, mergeCteMaps(this._cteMap, extraCteMap));
  }

  columns() {
    return this._schema.names();
  }

  schema() {
    return this._schema;
  }

  explain() {
    return planToString(this._plan);
  }

  select(...items) {
    const ctx = this._ctx();
    const bounds = items.map(item => selectArg(item).bind(this._schema, ctx));
    const exprs = bounds.map(b => b.expr);
    const fields = bounds.map((b, i) => new DFField(b.outputName || `col${i}`, b.dataType, i, ''));
    return this._derive(LogicalProject(exprs, this._plan), DFSchema.fromFields(fields));
  }

  filter(condition) {
    const { expr: cond, dataType } = predicateArg(condition).bind(this._schema, this._ctx());
    if (dataType !== DataType.BOOLEAN) {
      throw new TypeError(`filter condition must be boolean, got ${dataType}`);
    }
    return this._derive(LogicalFilter(cond, this._plan), this._schema);
  }

  where(condition) {
    return this.filter(condition);
  }

  withColumn(name, column) {
    const replacement = (column instanceof Col ? column : expr(column)).alias(name);
    const idx = this._schema.fields.findIndex(f => f.name.toUpperCase() === name.toUpperCase());
    const items = idx >= 0
      ? this._schema.fields.map((f, i) => (i === idx ? replacement : fieldCol(f)))
      : [...this._schema.fields.map(fieldCol), replacement];
    return this.select(...items);
  }

  drop(...names) {
    for (const name of names) this._schema.resolve(name);
    const removed = new Set(names.map(n => n.toUpperCase()));
    const items = this._schema.fields
      .filter(f => !removed.has(f.name.toUpperCase()))
      .map(fieldCol);
    return this.select(...items);
  }

  groupBy(...items) {
    const ctx = this._ctx();
    const bounds = items.map(item => selectArg(item).bind(this._schema, ctx));
    return new GroupedData(this._engine, this._plan, this._schema, bounds, this._cteMap);
  }

  orderBy(...specs) {
    const ctx = this._ctx();
    const orderKeys = specs.map(spec => {
      const descriptor = spec && typeof spec === 'object' && !(spec instanceof Col)
        ? spec
        : { col: spec, desc: false };
      const { expr: keyExpr } = selectArg(descriptor.col).bind(this._schema, ctx);
      return { expr: keyExpr, direction: descriptor.desc ? SortDirection.DESC : SortDirection.ASC };
    });
    return this._derive(LogicalSort(orderKeys, this._plan), this._schema);
  }

  sort(...specs) {
    return this.orderBy(...specs);
  }

  limit(count, offset = 0) {
    return this._derive(LogicalLimit(count, offset, this._plan), this._schema);
  }

  distinct() {
    return this._derive(LogicalDistinct(this._plan), this._schema);
  }

  union(other) {
    return this._union(other, true);
  }

  unionAll(other) {
    return this._union(other, true);
  }

  _union(other, all) {
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

  join(other, on, joinType = 'INNER') {
    const keys = Array.isArray(on) ? on : [on];
    const type = JoinType[joinType.toUpperCase()];
    if (!type) throw new Error(`Unknown join type: ${joinType}`);

    const leftPrefix = `${LEFT_JOIN_PREFIX}${this._engine._nextDfId()}_`;
    const rightPrefix = `${RIGHT_JOIN_PREFIX}${this._engine._nextDfId()}_`;

    const leftRenamed = this.select(
      ...this._schema.fields.map(f => fieldCol(f).alias(`${leftPrefix}${f.name}`)));
    const rightRenamed = other.select(
      ...other._schema.fields.map(f => fieldCol(f).alias(`${rightPrefix}${f.name}`)));

    const ctx = this._ctx();
    let condition = null;
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

    const projected = [];
    const outputNames = [];
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

  _outputColumns() {
    return this._schema.fields.map(f => ({ name: f.name, expr: null, dataType: f.dataType }));
  }

  async collect() {
    const result = await this._engine._runPlan(this._plan, this._outputColumns(), false, this._cteMap);
    return result.toArray();
  }

  toArray() {
    return this.collect();
  }

  async count() {
    const agg = BoundAggregate('COUNT_STAR', [], false, DataType.INT64);
    agg.outputName = 'count';
    const plan = LogicalAggregate([], [agg], this._plan);
    const outputColumns = [{ name: 'count', expr: null, dataType: DataType.INT64 }];
    const result = await this._engine._runPlan(plan, outputColumns, false, this._cteMap);
    const rows = await result.toArray();
    return rows.length > 0 ? Number(rows[0].count) : 0;
  }

  async *chunks() {
    const result = await this._engine._runPlan(this._plan, this._outputColumns(), true, this._cteMap);
    for await (const chunk of result.chunks()) {
      yield chunk;
    }
  }

  async show(n = 20) {
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
    const renderRow = cells => cells.map((c, i) => c.padEnd(widths[i])).join(' | ');
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

function formatCell(value) {
  if (value === null || value === undefined) return 'NULL';
  return String(value);
}

function mergeCteMaps(a, b) {
  if (!a && !b) return null;
  const merged = new Map();
  if (a) for (const [k, v] of a) merged.set(k, v);
  if (b) for (const [k, v] of b) merged.set(k, v);
  return merged;
}

function aggregateGroupField(groupExpr, bound, index) {
  const name = groupExpr.kind === BoundExprKind.COLUMN_REF ? groupExpr.columnName : `group${index}`;
  const tableAlias = groupExpr.tableAlias || '';
  return {
    ref: BoundColumnRef(tableAlias, name, index, getExprType(groupExpr)),
    outputName: bound.outputName || name,
    dataType: bound.dataType,
  };
}

export class GroupedData {
  constructor(engine, childPlan, childSchema, groupBounds, cteMap) {
    this._engine = engine;
    this._childPlan = childPlan;
    this._childSchema = childSchema;
    this._groupBounds = groupBounds;
    this._cteMap = cteMap;
  }

  agg(...aggColumns) {
    const ctx = { catalog: this._engine.catalog, functionRegistry: this._engine.functionRegistry };
    const aggBounds = aggColumns.map(c => c.bind(this._childSchema, ctx));

    const groupExprs = this._groupBounds.map(b => b.expr);
    const aggregates = aggBounds.map(b => b.expr);
    const aggPlan = LogicalAggregate(groupExprs, aggregates, this._childPlan);

    const groupProjections = [];
    const groupFields = [];
    for (let i = 0; i < this._groupBounds.length; i++) {
      const resolved = aggregateGroupField(groupExprs[i], this._groupBounds[i], i);
      resolved.ref.outputName = resolved.outputName;
      groupProjections.push(resolved.ref);
      groupFields.push(new DFField(resolved.outputName, resolved.dataType, i, ''));
    }

    const aggProjections = [];
    const aggFields = [];
    for (let a = 0; a < aggBounds.length; a++) {
      const bound = aggBounds[a];
      const outputName = bound.outputName || aggregates[a].name.toLowerCase();
      bound.expr.outputName = outputName;
      aggProjections.push(bound.expr);
      aggFields.push(new DFField(outputName, bound.dataType, this._groupBounds.length + a, ''));
    }

    const projectPlan = LogicalProject([...groupProjections, ...aggProjections], aggPlan);
    const schema = DFSchema.aggregateOutput(groupFields, aggFields);
    return new DataFrame(this._engine, projectPlan, schema, this._cteMap);
  }
}
