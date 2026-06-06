import { describe, it, expect } from 'vitest';
import {
  vectorizedFilter,
  vectorizedHashProbe,
  buildJoinOutputDirect,
  vectorizedProject,
  compileVectorExpression,
  vectorGet,
} from '../../src/execution/vector-ops.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { Column } from '../../src/storage/column.js';
import { DataChunk } from '../../src/storage/chunk.js';

function makeChunk(colDefs) {
  const size = colDefs[0].values.length;
  const cols = colDefs.map(({ type, values }) => {
    const col = new Column(type, values.length);
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return col;
  });
  return new DataChunk(cols, size);
}

describe('vectorizedFilter', () => {
  it('selects rows where predicate is true', () => {
    const chunk = makeChunk([{ type: 'INT32', values: [10, 20, 30, 40, 50] }]);
    const evalFn = (c, r) => c.columns[0].get(r) > 25;

    const { sv, count } = vectorizedFilter(chunk, evalFn);

    expect(count).toBe(3);
    const selected = Array.from(sv.slice(0, count));
    expect(selected).toEqual([2, 3, 4]);
  });

  it('returns count 0 when nothing matches', () => {
    const chunk = makeChunk([{ type: 'INT32', values: [1, 2, 3] }]);
    const { count } = vectorizedFilter(chunk, () => false);
    expect(count).toBe(0);
  });

  it('selects all when everything matches', () => {
    const chunk = makeChunk([{ type: 'INT32', values: [1, 2, 3] }]);
    const { count } = vectorizedFilter(chunk, () => true);
    expect(count).toBe(3);
  });

  it('respects existing selectionVector', () => {
    const chunk = makeChunk([{ type: 'INT32', values: [10, 20, 30, 40, 50] }]);
    chunk.setSelectionVector(new Uint32Array([1, 3, 4]), 3);
    const evalFn = (c, r) => c.columns[0].get(r) >= 40;

    const { sv, count } = vectorizedFilter(chunk, evalFn);

    expect(count).toBe(2);
    expect(Array.from(sv.slice(0, count))).toEqual([3, 4]);
  });
});

describe('vectorizedHashProbe', () => {
  it('finds matching build refs for probe keys', () => {
    const probeChunk = makeChunk([{ type: 'INT32', values: [1, 2, 3] }]);
    const hashTable = new Map([
      ['1', [{ chunkIdx: 0, rowIdx: 0 }]],
      ['3', [{ chunkIdx: 0, rowIdx: 2 }]],
    ]);

    const { buildRefs, probeIndices } = vectorizedHashProbe(
      probeChunk, (c, r) => c.columns[0].get(r), hashTable
    );

    expect(buildRefs.length).toBe(2);
    expect(probeIndices.length).toBe(2);
    expect(probeIndices[0]).toBe(0);
    expect(probeIndices[1]).toBe(2);
  });

  it('handles duplicate matches in hash table', () => {
    const probeChunk = makeChunk([{ type: 'INT32', values: [1] }]);
    const hashTable = new Map([
      ['1', [{ chunkIdx: 0, rowIdx: 0 }, { chunkIdx: 0, rowIdx: 1 }]],
    ]);

    const { buildRefs } = vectorizedHashProbe(
      probeChunk, (c, r) => c.columns[0].get(r), hashTable
    );

    expect(buildRefs.length).toBe(2);
  });

  it('skips null probe keys', () => {
    const probeChunk = makeChunk([{ type: 'INT32', values: [null, 1] }]);
    const hashTable = new Map([['1', [{ chunkIdx: 0, rowIdx: 0 }]]]);

    const { buildRefs } = vectorizedHashProbe(
      probeChunk, (c, r) => c.columns[0].get(r), hashTable
    );

    expect(buildRefs.length).toBe(1);
  });

  it('returns empty when no matches found', () => {
    const probeChunk = makeChunk([{ type: 'INT32', values: [99] }]);
    const hashTable = new Map([['1', [{ chunkIdx: 0, rowIdx: 0 }]]]);

    const { buildRefs } = vectorizedHashProbe(
      probeChunk, (c, r) => c.columns[0].get(r), hashTable
    );

    expect(buildRefs.length).toBe(0);
  });
});

describe('buildJoinOutputDirect', () => {
  it('combines build and probe columns into output chunk', () => {
    const buildChunks = [makeChunk([
      { type: 'INT32', values: [1, 2, 3] },
      { type: 'VARCHAR', values: ['a', 'b', 'c'] },
    ])];
    const probeChunk = makeChunk([
      { type: 'INT32', values: [10, 20, 30] },
    ]);
    const buildRefs = [
      { chunkIdx: 0, rowIdx: 0 },
      { chunkIdx: 0, rowIdx: 2 },
    ];
    const probeIndices = [0, 2];

    const result = buildJoinOutputDirect(buildChunks, buildRefs, probeChunk, probeIndices, 2, 1);

    expect(result.size).toBe(2);
    expect(result.columns.length).toBe(3);
    expect(result.columns[0].get(0)).toBe(1);
    expect(result.columns[1].get(0)).toBe('a');
    expect(result.columns[2].get(0)).toBe(10);
    expect(result.columns[0].get(1)).toBe(3);
    expect(result.columns[1].get(1)).toBe('c');
    expect(result.columns[2].get(1)).toBe(30);
  });

  it('returns empty chunk for no matches', () => {
    const result = buildJoinOutputDirect([], [], makeChunk([{ type: 'INT32', values: [] }]), [], 1, 1);
    expect(result.size).toBe(0);
  });
});

describe('compileVectorExpression', () => {
  it('compiles COLUMN_REF to column accessor', () => {
    const expr = { kind: BoundExprKind.COLUMN_REF, tableAlias: '', columnName: '', columnIndex: 1 };
    const fn = compileVectorExpression(expr, null);
    const chunk = makeChunk([
      { type: 'INT32', values: [10] },
      { type: 'VARCHAR', values: ['hello'] },
    ]);
    const result = fn(chunk);

    expect(result.ref).toBe(true);
    expect(result.column).toBe(chunk.columns[1]);
  });

  it('compiles LITERAL to constant', () => {
    const expr = { kind: BoundExprKind.LITERAL, value: 42 };
    const fn = compileVectorExpression(expr, null);
    const chunk = makeChunk([{ type: 'INT32', values: [1, 2] }]);
    const result = fn(chunk);

    expect(result.constant).toBe(true);
    expect(result.value).toBe(42);
  });

  it('returns null for unsupported expression', () => {
    const expr = { kind: BoundExprKind.CASE, whenClauses: [] };
    const result = compileVectorExpression(expr, null);
    expect(result).toBeNull();
  });
});

describe('vectorGet', () => {
  it('reads from column ref result', () => {
    const chunk = makeChunk([{ type: 'INT32', values: [10, 20, 30] }]);
    const result = { ref: true, column: chunk.columns[0] };
    expect(vectorGet(result, chunk, 1)).toBe(20);
  });

  it('reads constant result', () => {
    const chunk = makeChunk([{ type: 'INT32', values: [1] }]);
    const result = { constant: true, value: 99 };
    expect(vectorGet(result, chunk, 0)).toBe(99);
  });

  it('reads from data array result', () => {
    const chunk = makeChunk([{ type: 'INT32', values: [1] }]);
    const result = { data: [100, 200, 300] };
    expect(vectorGet(result, chunk, 2)).toBe(300);
  });

  it('returns null for null result', () => {
    const chunk = makeChunk([{ type: 'INT32', values: [1] }]);
    expect(vectorGet(null, chunk, 0)).toBeNull();
  });

  it('respects selectionVector for column ref', () => {
    const chunk = makeChunk([{ type: 'INT32', values: [10, 20, 30, 40] }]);
    chunk.setSelectionVector(new Uint32Array([1, 3]), 2);
    const result = { ref: true, column: chunk.columns[0] };

    expect(vectorGet(result, chunk, 0)).toBe(20);
    expect(vectorGet(result, chunk, 1)).toBe(40);
  });
});

describe('vectorizedProject', () => {
  it('projects columns via evaluators', () => {
    const chunk = makeChunk([
      { type: 'INT32', values: [1, 2, 3] },
      { type: 'INT32', values: [10, 20, 30] },
    ]);
    const evaluators = [(c, r) => c.columns[0].get(r) + c.columns[1].get(r)];
    const expressions = [null];
    const resultTypes = ['INT32'];

    const result = vectorizedProject(chunk, evaluators, expressions, resultTypes);

    expect(result.size).toBe(3);
    expect(result.columns[0].get(0)).toBe(11);
    expect(result.columns[0].get(1)).toBe(22);
    expect(result.columns[0].get(2)).toBe(33);
  });

  it('passes through column ref without copy', () => {
    const chunk = makeChunk([
      { type: 'INT32', values: [1, 2] },
      { type: 'VARCHAR', values: ['a', 'b'] },
    ]);
    const expr = { kind: BoundExprKind.COLUMN_REF, tableAlias: '', columnName: '', columnIndex: 1 };
    const result = vectorizedProject(chunk, [(c, r) => c.columns[1].get(r)], [expr], ['VARCHAR']);

    expect(result.columns[0]).toBe(chunk.columns[1]);
  });

  it('evaluates column ref when selectionVector present', () => {
    const chunk = makeChunk([{ type: 'INT32', values: [10, 20, 30, 40] }]);
    chunk.setSelectionVector(new Uint32Array([0, 2]), 2);
    const expr = { kind: BoundExprKind.COLUMN_REF, tableAlias: '', columnName: '', columnIndex: 0 };

    const result = vectorizedProject(chunk, [(c, r) => c.columns[0].get(r)], [expr], ['INT32']);

    expect(result.size).toBe(2);
    expect(result.columns[0].get(0)).toBe(10);
    expect(result.columns[0].get(1)).toBe(30);
  });
});
