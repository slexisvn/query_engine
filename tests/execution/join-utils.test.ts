import { describe, it, expect } from 'vitest';
import { extractJoinKeys, findCommonEquiJoinKeys } from '../../src/execution/join-utils.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

function colRef(tableAlias, columnName) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias, columnName };
}

function lit(value) {
  return { kind: BoundExprKind.LITERAL, value };
}

function eq(left, right) {
  return { kind: BoundExprKind.BINARY, op: '=', left, right };
}

function gt(left, right) {
  return { kind: BoundExprKind.BINARY, op: '>', left, right };
}

function and(left, right) {
  return { kind: BoundExprKind.BINARY, op: 'AND', left, right };
}

function or(left, right) {
  return { kind: BoundExprKind.BINARY, op: 'OR', left, right };
}

const leftMapping = new Map([['L.ID', 0], ['ID', 0], ['L.NAME', 1], ['NAME', 1]]);
const rightMapping = new Map([['R.KEY', 0], ['KEY', 0], ['R.VAL', 1], ['VAL', 1]]);

describe('extractJoinKeys', () => {
  it('extracts single equi-join key pair', () => {
    const cond = eq(colRef('L', 'ID'), colRef('R', 'KEY'));
    const { buildKeys, probeKeys, residualCondition } = extractJoinKeys(cond, leftMapping, rightMapping);

    expect(buildKeys.length).toBe(1);
    expect(buildKeys[0].columnName).toBe('ID');
    expect(probeKeys[0].columnName).toBe('KEY');
    expect(residualCondition).toBeNull();
  });

  it('extracts multiple equi-join keys from AND', () => {
    const cond = and(
      eq(colRef('L', 'ID'), colRef('R', 'KEY')),
      eq(colRef('L', 'NAME'), colRef('R', 'VAL'))
    );
    const { buildKeys, probeKeys } = extractJoinKeys(cond, leftMapping, rightMapping);

    expect(buildKeys.length).toBe(2);
    expect(buildKeys[0].columnName).toBe('ID');
    expect(buildKeys[1].columnName).toBe('NAME');
  });

  it('handles reversed column order (right = left)', () => {
    const cond = eq(colRef('R', 'KEY'), colRef('L', 'ID'));
    const { buildKeys, probeKeys } = extractJoinKeys(cond, leftMapping, rightMapping);

    expect(buildKeys[0].columnName).toBe('ID');
    expect(probeKeys[0].columnName).toBe('KEY');
  });

  it('separates non-equi predicates into residual', () => {
    const cond = and(
      eq(colRef('L', 'ID'), colRef('R', 'KEY')),
      gt(colRef('L', 'NAME'), colRef('R', 'VAL'))
    );
    const { buildKeys, residualCondition } = extractJoinKeys(cond, leftMapping, rightMapping);

    expect(buildKeys.length).toBe(1);
    expect(residualCondition).not.toBeNull();
    expect(residualCondition.op).toBe('>');
  });

  it('falls back to literal keys when no equi-join found', () => {
    const cond = gt(colRef('L', 'ID'), colRef('R', 'KEY'));
    const { buildKeys, probeKeys } = extractJoinKeys(cond, leftMapping, rightMapping);

    expect(buildKeys[0].kind).toBe(BoundExprKind.LITERAL);
    expect(probeKeys[0].kind).toBe(BoundExprKind.LITERAL);
  });

  it('returns empty keys for null condition', () => {
    const { buildKeys, probeKeys, residualCondition } = extractJoinKeys(null, leftMapping, rightMapping);

    expect(buildKeys.length).toBe(0);
    expect(probeKeys.length).toBe(0);
    expect(residualCondition).toBeNull();
  });

  it('handles mixed equi + residual in triple AND', () => {
    const cond = and(
      and(
        eq(colRef('L', 'ID'), colRef('R', 'KEY')),
        gt(colRef('L', 'ID'), lit(5))
      ),
      eq(colRef('L', 'NAME'), colRef('R', 'VAL'))
    );
    const { buildKeys, probeKeys, residualCondition } = extractJoinKeys(cond, leftMapping, rightMapping);

    expect(buildKeys.length).toBe(2);
    expect(residualCondition).not.toBeNull();
  });
});

describe('findCommonEquiJoinKeys', () => {
  it('finds equi-join key from simple equality', () => {
    const cond = eq(colRef('L', 'ID'), colRef('R', 'KEY'));
    const result = findCommonEquiJoinKeys(cond, leftMapping, rightMapping);

    expect(result).not.toBeNull();
    expect(result.buildKey.columnName).toBe('ID');
    expect(result.probeKey.columnName).toBe('KEY');
  });

  it('finds common key across OR branches', () => {
    const cond = or(
      eq(colRef('L', 'ID'), colRef('R', 'KEY')),
      eq(colRef('L', 'ID'), colRef('R', 'KEY'))
    );
    const result = findCommonEquiJoinKeys(cond, leftMapping, rightMapping);

    expect(result).not.toBeNull();
    expect(result.buildKey.columnName).toBe('ID');
  });

  it('returns null when OR branches have different keys', () => {
    const cond = or(
      eq(colRef('L', 'ID'), colRef('R', 'KEY')),
      eq(colRef('L', 'NAME'), colRef('R', 'VAL'))
    );
    const result = findCommonEquiJoinKeys(cond, leftMapping, rightMapping);

    expect(result).toBeNull();
  });

  it('finds key from AND (returns first found)', () => {
    const cond = and(
      gt(colRef('L', 'ID'), lit(5)),
      eq(colRef('L', 'ID'), colRef('R', 'KEY'))
    );
    const result = findCommonEquiJoinKeys(cond, leftMapping, rightMapping);

    expect(result).not.toBeNull();
    expect(result.buildKey.columnName).toBe('ID');
  });

  it('returns null for non-equi condition', () => {
    const cond = gt(colRef('L', 'ID'), colRef('R', 'KEY'));
    const result = findCommonEquiJoinKeys(cond, leftMapping, rightMapping);

    expect(result).toBeNull();
  });

  it('returns null for null input', () => {
    expect(findCommonEquiJoinKeys(null, leftMapping, rightMapping)).toBeNull();
  });
});

describe('extractJoinKeys side classification', () => {
  const sameNameLeft = new Map([['EMP.MGR', 4], ['MGR', 4], ['EMP.ID', 0], ['ID', 0]]);
  const sameNameRight = new Map([['EMP:1.ID', 0], ['ID', 0], ['EMP:1.MGR', 1], ['MGR', 1]]);

  it('prefers the qualified match when both sides carry the bare name', () => {
    const result = extractJoinKeys(eq(colRef('EMP', 'MGR'), colRef('EMP:1', 'ID')), sameNameLeft, sameNameRight);
    expect(result.buildKeys[0].tableAlias).toBe('EMP');
    expect(result.buildKeys[0].columnName).toBe('MGR');
    expect(result.probeKeys[0].tableAlias).toBe('EMP:1');
    expect(result.probeKeys[0].columnName).toBe('ID');
  });

  it('swaps the sides when the qualified match points the other way', () => {
    const result = extractJoinKeys(eq(colRef('EMP:1', 'ID'), colRef('EMP', 'MGR')), sameNameLeft, sameNameRight);
    expect(result.buildKeys[0].tableAlias).toBe('EMP');
    expect(result.probeKeys[0].tableAlias).toBe('EMP:1');
  });

  it('still falls back to bare names when neither side is qualified', () => {
    const bareLeft = new Map([['ID', 0]]);
    const bareRight = new Map([['KEY', 0]]);
    const result = extractJoinKeys(eq(colRef('', 'ID'), colRef('', 'KEY')), bareLeft, bareRight);
    expect(result.buildKeys[0].columnName).toBe('ID');
    expect(result.probeKeys[0].columnName).toBe('KEY');
  });
});
