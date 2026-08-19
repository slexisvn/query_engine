import { describe, it, expect } from 'vitest';
import {
  extractStageChain,
  extractAggregateFragment,
  buildFragmentSpec,
  buildJoinSpec,
  instantiateStages,
  instantiateFragment,
  stagedSchemaOf,
  schemasEqual,
  schemaMappingOf,
  projectionSchemaOf,
  collectColumnRefs,
  StageKind,
} from '../../src/execution/fragment-spec.js';
import { PlanNodeType } from '../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { DataType } from '../../src/storage/data-type.js';
import { Column } from '../../src/storage/column.js';
import { DataChunk } from '../../src/storage/chunk.js';

const ALIAS = 'T';
const colRef = (name, dataType, tableAlias = ALIAS) => ({ kind: BoundExprKind.COLUMN_REF, columnName: name, tableAlias, dataType });
const lit = (value) => ({ kind: BoundExprKind.LITERAL, value });
const gt = (left, right) => ({ kind: BoundExprKind.BINARY, op: '>', left, right });

const scanNode = (table = 'T', columns = null) => ({ type: PlanNodeType.SCAN, table, alias: ALIAS, columns, children: [] });
const filterNode = (condition, child) => ({ type: PlanNodeType.FILTER, condition, children: [child] });
const projectNode = (expressions, child) => ({ type: PlanNodeType.PROJECT, expressions, children: [child] });

const STORAGE_SCHEMA = [
  { name: 'A', dataType: DataType.INT32 },
  { name: 'B', dataType: DataType.FLOAT64 },
  { name: 'C', dataType: DataType.VARCHAR },
  { name: 'D', dataType: DataType.INT32 },
];

describe('extractStageChain', () => {
  it('collects filter and project stages bottom-up down to a scan', () => {
    const condition = gt(colRef('A', DataType.INT32), lit(1));
    const expressions = [colRef('B', DataType.FLOAT64)];
    const plan = projectNode(expressions, filterNode(condition, scanNode('T', ['cols'])));
    const fragment = extractStageChain(plan);
    expect(fragment.table).toBe('T');
    expect(fragment.alias).toBe(ALIAS);
    expect(fragment.scanColumns).toEqual(['cols']);
    expect(fragment.stages).toEqual([
      { kind: StageKind.FILTER, condition },
      { kind: StageKind.PROJECT, expressions },
    ]);
  });

  it('returns null when the chain hits a non scan/filter/project node', () => {
    const join = { type: PlanNodeType.JOIN, children: [scanNode(), scanNode()] };
    expect(extractStageChain(filterNode(gt(colRef('A', DataType.INT32), lit(0)), join))).toBeNull();
  });

  it('extractAggregateFragment walks from the aggregate child', () => {
    const node = { type: PlanNodeType.AGGREGATE, children: [scanNode()] };
    expect(extractAggregateFragment(node).table).toBe('T');
  });
});

describe('schema helpers', () => {
  it('stagedSchemaOf applies project stages and keeps filters transparent', () => {
    const base = [{ name: 'A', dataType: DataType.INT32, tableAlias: ALIAS }];
    const projected = stagedSchemaOf(base, [
      { kind: StageKind.FILTER, condition: gt(colRef('A', DataType.INT32), lit(0)) },
      { kind: StageKind.PROJECT, expressions: [{ ...colRef('A', DataType.INT32), outputName: 'X' }] },
    ]);
    expect(projected).toEqual([{ name: 'X', dataType: DataType.INT32, tableAlias: '' }]);
    expect(stagedSchemaOf(base, [])).toBe(base);
  });

  it('schemasEqual compares name, type and alias case-insensitively', () => {
    const a = [{ name: 'a', dataType: DataType.INT32, tableAlias: 't' }];
    expect(schemasEqual(a, [{ name: 'A', dataType: DataType.INT32, tableAlias: 'T' }])).toBe(true);
    expect(schemasEqual(a, [{ name: 'A', dataType: DataType.FLOAT64, tableAlias: 'T' }])).toBe(false);
    expect(schemasEqual(a, [])).toBe(false);
  });

  it('schemaMappingOf maps qualified and first-wins bare names', () => {
    const mapping = schemaMappingOf([
      { name: 'K', dataType: DataType.INT32, tableAlias: 'X' },
      { name: 'K', dataType: DataType.INT32, tableAlias: 'Y' },
    ]);
    expect(mapping.get('X.K')).toBe(0);
    expect(mapping.get('Y.K')).toBe(1);
    expect(mapping.get('K')).toBe(0);
  });

  it('collectColumnRefs walks nested expressions and arrays', () => {
    const expr = gt(
      { kind: BoundExprKind.BINARY, op: '+', left: colRef('A', DataType.INT32), right: colRef('B', DataType.FLOAT64) },
      lit(3),
    );
    const refs = collectColumnRefs([expr, colRef('D', DataType.INT32)]);
    expect(refs.map(r => r.columnName)).toEqual(['A', 'B', 'D']);
  });
});

describe('buildFragmentSpec', () => {
  const node = (groupBy, aggregates) => ({ groupBy, aggregates });

  it('prunes the base schema to referenced columns only', () => {
    const fragment = { table: 'T', alias: ALIAS, stages: [] };
    const built = buildFragmentSpec(
      fragment,
      node([colRef('D', DataType.INT32)], [{ name: 'SUM', distinct: false, args: [colRef('B', DataType.FLOAT64)] }]),
      STORAGE_SCHEMA,
    );
    expect(built.columnIndexes).toEqual([1, 3]);
    expect(built.spec.baseSchema.map(c => c.name)).toEqual(['B', 'D']);
    expect(built.estimatedRowBytes).toBeGreaterThan(0);
  });

  it('keeps columns referenced by pre-project filters and stops pruning at the project', () => {
    const fragment = {
      table: 'T', alias: ALIAS,
      stages: [
        { kind: StageKind.FILTER, condition: gt(colRef('A', DataType.INT32), lit(0)) },
        { kind: StageKind.PROJECT, expressions: [{ ...colRef('B', DataType.FLOAT64), outputName: 'V' }] },
      ],
    };
    const built = buildFragmentSpec(
      fragment,
      node([], [{ name: 'SUM', distinct: false, args: [colRef('V', DataType.FLOAT64, '')] }]),
      STORAGE_SCHEMA,
    );
    expect(built.columnIndexes).toEqual([0, 1]);
  });

  it('returns null when a reference cannot be resolved against the scan schema', () => {
    const fragment = { table: 'T', alias: ALIAS, stages: [] };
    expect(buildFragmentSpec(
      fragment,
      node([colRef('MISSING', DataType.INT32)], []),
      STORAGE_SCHEMA,
    )).toBeNull();
  });

  it('returns null when group-by references do not survive a project', () => {
    const fragment = {
      table: 'T', alias: ALIAS,
      stages: [{ kind: StageKind.PROJECT, expressions: [{ ...colRef('B', DataType.FLOAT64), outputName: 'V' }] }],
    };
    expect(buildFragmentSpec(
      fragment,
      node([colRef('A', DataType.INT32)], []),
      STORAGE_SCHEMA,
    )).toBeNull();
  });
});

describe('instantiateStages / instantiateFragment', () => {
  function chunkOf(values) {
    const a = new Column(DataType.INT32, values.length);
    values.forEach((v, i) => a.set(i, v));
    a.length = values.length;
    return new DataChunk([a], values.length);
  }

  it('builds working filter operators against the staged mapping', async () => {
    const base = [{ name: 'A', dataType: DataType.INT32, tableAlias: ALIAS }];
    const { operators, schema, mapping } = instantiateStages(base, [
      { kind: StageKind.FILTER, condition: gt(colRef('A', DataType.INT32), lit(2)) },
    ]);
    expect(schema).toBe(base);
    expect(mapping.get('T.A')).toBe(0);
    const filtered = await operators[0].process(chunkOf([1, 5, 2, 9]));
    const out = [];
    for (let i = 0; i < filtered.size; i++) out.push(filtered.getValue(i, 0));
    expect(out).toEqual([5, 9]);
  });

  it('instantiateFragment runs filter then aggregate end-to-end', async () => {
    const spec = {
      baseSchema: [{ name: 'A', dataType: DataType.INT32, tableAlias: ALIAS }],
      stages: [{ kind: StageKind.FILTER, condition: gt(colRef('A', DataType.INT32), lit(0)) }],
      groupBy: [],
      aggregates: [{ name: 'SUM', distinct: false, args: [colRef('A', DataType.INT32)] }],
    };
    const { operators, aggregate } = instantiateFragment(spec);
    let chunk = chunkOf([-3, 4, 6, -1]);
    for (const op of operators) chunk = await op.process(chunk);
    await aggregate.consume(chunk);
    const result = await aggregate.finalize();
    expect(result[0].getValue(0, 0)).toBe(10);
  });
});

describe('buildJoinSpec validation', () => {
  const sideSchema = [
    { name: 'K', dataType: DataType.INT32, tableAlias: 'L' },
    { name: 'V', dataType: DataType.INT32, tableAlias: 'L' },
  ];
  const side = { schema: sideSchema, baseSchema: sideSchema, stages: [] };
  const otherSchema = [{ name: 'K', dataType: DataType.INT32, tableAlias: 'R' }];
  const other = { schema: otherSchema, baseSchema: otherSchema, stages: [] };

  function makeArgs(overrides = {}) {
    return {
      build: side,
      probe: other,
      buildKeys: [colRef('K', DataType.INT32, 'L')],
      probeKeys: [colRef('K', DataType.INT32, 'R')],
      residualCondition: null,
      joinType: 'INNER',
      uniqueKeys: false,
      buildMapping: schemaMappingOf(sideSchema),
      probeMapping: schemaMappingOf(otherSchema),
      combinedMapping: schemaMappingOf([...sideSchema, ...otherSchema]),
      ...overrides,
    };
  }

  it('accepts a spec whose refs resolve identically on main and worker', () => {
    const spec = buildJoinSpec(makeArgs());
    expect(spec).not.toBeNull();
    expect(spec.buildColCount).toBe(2);
    expect(spec.probeColCount).toBe(1);
  });

  it('rejects when the main mapping resolves a key differently than the worker mapping', () => {
    const skewed = new Map(schemaMappingOf(sideSchema));
    skewed.set('L.K', 1);
    skewed.set('K', 1);
    expect(buildJoinSpec(makeArgs({ buildMapping: skewed }))).toBeNull();
  });

  it('rejects unresolvable residual conditions', () => {
    expect(buildJoinSpec(makeArgs({
      residualCondition: gt(colRef('NOPE', DataType.INT32, 'L'), lit(0)),
    }))).toBeNull();
  });
});

describe('projectionSchemaOf', () => {
  it('derives names from outputName/alias/columnName and normalizes INT64/DECIMAL', () => {
    const schema = projectionSchemaOf([
      { ...colRef('A', DataType.INT64), outputName: 'BIG' },
      colRef('B', DataType.DECIMAL),
      { kind: BoundExprKind.LITERAL, value: 1 },
    ]);
    expect(schema[0]).toEqual({ name: 'BIG', dataType: DataType.FLOAT64, tableAlias: '' });
    expect(schema[1].name).toBe('B');
    expect(schema[1].dataType).toBe(DataType.FLOAT64);
    expect(schema[2].name).toBe('col2');
  });
});
