import {
  BoundExprKind,
  BoundColumnRef, BoundLiteral, BoundBinary, BoundUnary,
  BoundFunction, BoundAggregate, BoundCase, BoundCast,
  BoundBetween, BoundInList, BoundLike, BoundIsNull,
  BoundSubquery, BoundExists, BoundExtract, BoundInterval,
  getExprType, collectCorrelatedColumns,
} from '../../src/binder/expression-binder.js';
import { DataType } from '../../src/storage/data-type.js';

// ─── BoundColumnRef: isCorrelated logic ───────────────────────────────────────

describe('BoundColumnRef correlation', () => {
  it('depth 0 → isCorrelated false', () => {
    expect(BoundColumnRef('T', 'ID', 0, DataType.INT32, 0).isCorrelated).toBe(false);
  });

  it('depth 1 → isCorrelated true', () => {
    expect(BoundColumnRef('T', 'ID', 0, DataType.INT32, 1).isCorrelated).toBe(true);
  });

  it('depth 2 → isCorrelated true', () => {
    expect(BoundColumnRef('T', 'ID', 0, DataType.INT32, 2).isCorrelated).toBe(true);
  });

  it('default depth is 0 → isCorrelated false', () => {
    // no explicit depth arg
    expect(BoundColumnRef('T', 'ID', 0, DataType.INT32).isCorrelated).toBe(false);
    expect(BoundColumnRef('T', 'ID', 0, DataType.INT32).depth).toBe(0);
  });

  it('two refs at same depth are independent objects', () => {
    const a = BoundColumnRef('T', 'A', 0, DataType.INT32, 1);
    const b = BoundColumnRef('T', 'B', 1, DataType.INT32, 1);
    expect(a).not.toBe(b);
    expect(a.columnName).not.toBe(b.columnName);
  });
});

// ─── Boolean-result-type contracts ────────────────────────────────────────────

describe('Boolean result type contracts', () => {
  const col = () => BoundColumnRef('T', 'X', 0, DataType.INT32);
  const n = () => BoundLiteral(1, DataType.INT32);

  it('BoundBetween always BOOLEAN regardless of expr types', () => {
    expect(BoundBetween(col(), n(), n(), false).resultType).toBe(DataType.BOOLEAN);
    expect(BoundBetween(col(), n(), n(), true).resultType).toBe(DataType.BOOLEAN);
  });

  it('BoundBetween negated=false vs negated=true are separate', () => {
    expect(BoundBetween(col(), n(), n(), false).negated).toBe(false);
    expect(BoundBetween(col(), n(), n(), true).negated).toBe(true);
  });

  it('BoundInList always BOOLEAN regardless of list types', () => {
    expect(BoundInList(col(), [n(), n()], false).resultType).toBe(DataType.BOOLEAN);
    expect(BoundInList(col(), [n(), n()], true).resultType).toBe(DataType.BOOLEAN);
  });

  it('BoundLike always BOOLEAN', () => {
    const pat = BoundLiteral('%foo%', DataType.VARCHAR);
    expect(BoundLike(BoundColumnRef('T', 'NAME', 0, DataType.VARCHAR), pat, false).resultType).toBe(DataType.BOOLEAN);
    expect(BoundLike(BoundColumnRef('T', 'NAME', 0, DataType.VARCHAR), pat, true).resultType).toBe(DataType.BOOLEAN);
  });

  it('BoundIsNull always BOOLEAN for both IS NULL and IS NOT NULL', () => {
    expect(BoundIsNull(col(), false).resultType).toBe(DataType.BOOLEAN);
    expect(BoundIsNull(col(), true).resultType).toBe(DataType.BOOLEAN);
  });

  it('BoundExists always BOOLEAN', () => {
    const plan = { type: 'MockPlan' };
    expect(BoundExists(plan, false).resultType).toBe(DataType.BOOLEAN);
    expect(BoundExists(plan, true).resultType).toBe(DataType.BOOLEAN);
  });
});

// ─── BoundExtract / BoundInterval fixed result types ─────────────────────────

describe('Fixed result types', () => {
  it('BoundExtract always INT32 regardless of field', () => {
    const src = BoundColumnRef('T', 'D', 0, DataType.DATE);
    for (const field of ['YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND']) {
      expect(BoundExtract(field, src).resultType).toBe(DataType.INT32);
    }
  });

  it('BoundInterval always INT32 regardless of unit', () => {
    for (const unit of ['YEAR', 'MONTH', 'DAY', 'HOUR']) {
      expect(BoundInterval(5, unit).resultType).toBe(DataType.INT32);
    }
  });
});

// ─── getExprType priority: resultType > dataType ──────────────────────────────

describe('getExprType', () => {
  it('prefers resultType over dataType when both present', () => {
    const expr = { resultType: DataType.INT64, dataType: DataType.INT32 };
    expect(getExprType(expr)).toBe(DataType.INT64);
  });

  it('falls back to dataType when no resultType', () => {
    expect(getExprType(BoundLiteral(42, DataType.INT32))).toBe(DataType.INT32);
  });

  it('uses resultType from binary expression', () => {
    const bin = BoundBinary('+',
      BoundLiteral(1, DataType.INT32),
      BoundLiteral(2, DataType.INT32),
      DataType.FLOAT64,  // promoted type
    );
    expect(getExprType(bin)).toBe(DataType.FLOAT64);
  });

  it('returns null when both resultType and dataType are absent', () => {
    expect(getExprType({ kind: BoundExprKind.SUBQUERY })).toBeNull();
  });

  it('returns null for null and undefined', () => {
    expect(getExprType(null)).toBeNull();
    expect(getExprType(undefined)).toBeNull();
  });

  it('returns null when fields are explicitly undefined', () => {
    expect(getExprType({ kind: 'X', resultType: undefined, dataType: undefined })).toBeNull();
  });
});

// ─── collectCorrelatedColumns: tree walking logic ─────────────────────────────

describe('collectCorrelatedColumns', () => {
  const outer = (name, idx = 0) => BoundColumnRef('OUTER', name, idx, DataType.INT32, 1);
  const inner = (name, idx = 0) => BoundColumnRef('INNER', name, idx, DataType.INT32, 0);
  const n = (v = 1) => BoundLiteral(v, DataType.INT32);

  it('returns empty for null', () => {
    expect(collectCorrelatedColumns(null)).toEqual([]);
  });

  it('returns empty when no correlated refs exist', () => {
    const expr = BoundBinary('=', inner('A'), n());
    expect(collectCorrelatedColumns(expr)).toEqual([]);
  });

  it('finds correlated ref at left of binary', () => {
    const corr = outer('ID');
    const refs = collectCorrelatedColumns(BoundBinary('=', corr, inner('FK')));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toBe(corr);
  });

  it('finds correlated ref at right of binary', () => {
    const corr = outer('ID');
    const refs = collectCorrelatedColumns(BoundBinary('=', inner('FK'), corr));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toBe(corr);
  });

  it('finds multiple correlated refs in one binary tree', () => {
    const c1 = outer('ID', 0);
    const c2 = outer('NAME', 1);
    const expr = BoundBinary('AND',
      BoundBinary('=', inner('A'), c1),
      BoundBinary('=', inner('B'), c2),
    );
    const refs = collectCorrelatedColumns(expr);
    expect(refs).toHaveLength(2);
    expect(refs).toContain(c1);
    expect(refs).toContain(c2);
  });

  it('does not return non-correlated refs even when mixed with correlated', () => {
    const corr = outer('ID');
    const notCorr = inner('FK');
    const refs = collectCorrelatedColumns(BoundBinary('=', notCorr, corr));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toBe(corr);
  });

  it('walks into UNARY operand', () => {
    const corr = outer('ACTIVE');
    const refs = collectCorrelatedColumns(BoundUnary('NOT', corr, DataType.BOOLEAN));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toBe(corr);
  });

  it('walks into all FUNCTION args', () => {
    const c1 = outer('A', 0);
    const c2 = outer('B', 1);
    const refs = collectCorrelatedColumns(BoundFunction('COALESCE', [inner('X'), c1, c2], DataType.INT32));
    expect(refs).toHaveLength(2);
    expect(refs).toContain(c1);
    expect(refs).toContain(c2);
  });

  it('walks into all AGGREGATE args', () => {
    const corr = outer('VAL');
    const refs = collectCorrelatedColumns(BoundAggregate('SUM', [corr], false, DataType.INT32));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toBe(corr);
  });

  it('walks into CASE: each WHEN condition, each WHEN result, ELSE', () => {
    const cCond = outer('COND');
    const cRes = outer('RES');
    const cElse = outer('ELSE');

    const expr = BoundCase(
      [{ condition: cCond, result: cRes }],
      cElse,
      DataType.INT32,
    );
    const refs = collectCorrelatedColumns(expr);
    expect(refs).toHaveLength(3);
    expect(refs).toContain(cCond);
    expect(refs).toContain(cRes);
    expect(refs).toContain(cElse);
  });

  it('CASE with null elseExpr only walks WHEN clauses', () => {
    const corr = outer('X');
    const expr = BoundCase([{ condition: corr, result: n() }], null, DataType.INT32);
    const refs = collectCorrelatedColumns(expr);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toBe(corr);
  });

  it('walks into CAST inner expression', () => {
    const corr = outer('X');
    const refs = collectCorrelatedColumns(BoundCast(corr, DataType.VARCHAR));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toBe(corr);
  });

  it('walks into BETWEEN: expr, low, high — all three', () => {
    const cExpr = outer('E');
    const cLow = outer('L', 1);
    const cHigh = outer('H', 2);
    const refs = collectCorrelatedColumns(BoundBetween(cExpr, cLow, cHigh, false));
    expect(refs).toHaveLength(3);
    expect(refs).toContain(cExpr);
    expect(refs).toContain(cLow);
    expect(refs).toContain(cHigh);
  });

  it('walks INTO IN_LIST array items', () => {
    const c1 = outer('A', 0);
    const c2 = outer('B', 1);
    const refs = collectCorrelatedColumns(BoundInList(inner('X'), [c1, c2], false));
    expect(refs).toHaveLength(2);
  });

  it('walks into LIKE: expr and pattern', () => {
    const cExpr = outer('NAME');
    const cPat = outer('PAT', 1);
    const refs = collectCorrelatedColumns(BoundLike(cExpr, cPat, false));
    expect(refs).toHaveLength(2);
  });

  it('walks into IS_NULL expr', () => {
    const corr = outer('X');
    const refs = collectCorrelatedColumns(BoundIsNull(corr, false));
    expect(refs).toHaveLength(1);
  });

  it('walks into EXTRACT source', () => {
    const corr = BoundColumnRef('OUTER', 'D', 0, DataType.DATE, 1);
    const refs = collectCorrelatedColumns(BoundExtract('YEAR', corr));
    expect(refs).toHaveLength(1);
  });

  it('depth-2 refs are also collected (any depth > 0 is correlated)', () => {
    const d2 = BoundColumnRef('FAR', 'X', 0, DataType.INT32, 2);
    const refs = collectCorrelatedColumns(d2);
    expect(refs).toHaveLength(1);
    expect(refs[0].depth).toBe(2);
  });

  it('does not walk into SUBQUERY plan (subquery refs stay opaque)', () => {
    const plan = { kind: BoundExprKind.COLUMN_REF, isCorrelated: true }; // fake inner
    const refs = collectCorrelatedColumns(BoundSubquery(plan, 'SCALAR'));
    expect(refs).toEqual([]);
  });

  it('returns the exact same object references, not copies', () => {
    const corr = outer('ID');
    const refs = collectCorrelatedColumns(BoundUnary('NOT', corr, DataType.BOOLEAN));
    expect(refs[0]).toBe(corr);
  });
});
