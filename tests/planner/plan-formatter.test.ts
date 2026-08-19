import { formatExpression, formatPlan } from '../../src/planner/plan-formatter.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import {
  LogicalScan, LogicalFilter, LogicalProject, LogicalJoin, LogicalAggregate,
  LogicalSort, LogicalLimit, LogicalDistinct, LogicalUnion, LogicalCTEScan,
  LogicalCTEAnchor, LogicalMaterialize, LogicalDependentJoin, LogicalTopN,
  LogicalIndexScan, JoinType, PlanNodeType,
} from '../../src/planner/logical-plan.js';

function col(table, name) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: name };
}
function lit(v) {
  return { kind: BoundExprKind.LITERAL, value: v, dataType: 'INT32' };
}
function strLit(v) {
  return { kind: BoundExprKind.LITERAL, value: v, dataType: 'VARCHAR' };
}
function bin(op, l, r) {
  return { kind: BoundExprKind.BINARY, op, left: l, right: r };
}
function unary(op, operand) {
  return { kind: BoundExprKind.UNARY, op, operand };
}
function fn(name, args) {
  return { kind: BoundExprKind.FUNCTION, name, args };
}
function agg(name, args) {
  return { kind: BoundExprKind.AGGREGATE, name, args };
}

describe('formatExpression', () => {
  it('returns empty string for null/undefined', () => {
    expect(formatExpression(null)).toBe('');
    expect(formatExpression(undefined)).toBe('');
  });

  it('formats column ref with and without table prefix', () => {
    expect(formatExpression(col('T', 'ID'))).toBe('T.ID');
    expect(formatExpression({ kind: BoundExprKind.COLUMN_REF, tableAlias: '', columnName: 'X' })).toBe('X');
    expect(formatExpression({ kind: BoundExprKind.COLUMN_REF, tableAlias: null, columnName: 'X' })).toBe('X');
  });

  it('formats string literal with quotes, number and null without', () => {
    expect(formatExpression(strLit('hello'))).toBe("'hello'");
    expect(formatExpression(lit(42))).toBe('42');
    expect(formatExpression({ kind: BoundExprKind.LITERAL, value: null })).toBe('null');
    expect(formatExpression(lit(0))).toBe('0');
    expect(formatExpression(lit(-3.14))).toBe('-3.14');
  });

  it('wraps binary expression in parens and recurses into both sides', () => {
    const expr = bin('AND',
      bin('>', col('T', 'AGE'), lit(18)),
      bin('<', col('T', 'AGE'), lit(65)));
    expect(formatExpression(expr)).toBe('((T.AGE > 18) AND (T.AGE < 65))');
  });

  it('formats deeply nested binary: ((a + b) * (c - d))', () => {
    const expr = bin('*', bin('+', col('', 'A'), col('', 'B')), bin('-', col('', 'C'), col('', 'D')));
    expect(formatExpression(expr)).toBe('((A + B) * (C - D))');
  });

  it('formats unary with operand', () => {
    expect(formatExpression(unary('NOT', col('T', 'ACTIVE')))).toBe('NOT T.ACTIVE');
    expect(formatExpression(unary('-', lit(5)))).toBe('- 5');
  });

  it('formats function call with multiple args', () => {
    expect(formatExpression(fn('COALESCE', [col('T', 'A'), lit(0)]))).toBe('COALESCE(T.A, 0)');
    expect(formatExpression(fn('SUBSTRING', [col('T', 'NAME'), lit(1), lit(3)]))).toBe('SUBSTRING(T.NAME, 1, 3)');
  });

  it('formats aggregate call', () => {
    expect(formatExpression(agg('SUM', [col('T', 'PRICE')]))).toBe('SUM(T.PRICE)');
    expect(formatExpression(agg('COUNT', [col('O', 'ID')]))).toBe('COUNT(O.ID)');
  });

  it('formats aggregate with no args (COUNT(*))', () => {
    expect(formatExpression(agg('COUNT_STAR', []))).toBe('COUNT_STAR()');
  });

  it('formats unknown expression kind with angle brackets', () => {
    expect(formatExpression({ kind: 'BoundSomethingNew' })).toBe('<BoundSomethingNew>');
  });

  it('formats complex expression: NOT (a > 10 AND b < 20)', () => {
    const expr = unary('NOT', bin('AND', bin('>', col('T', 'A'), lit(10)), bin('<', col('T', 'B'), lit(20))));
    expect(formatExpression(expr)).toBe('NOT ((T.A > 10) AND (T.B < 20))');
  });
});

describe('formatPlan', () => {
  it('every line starts with -> prefix', () => {
    const plan = LogicalLimit(10, 0, LogicalFilter(bin('=', col('T', 'ID'), lit(1)), LogicalScan('T', [])));
    const lines = formatPlan(plan).split('\n').filter(l => l.trim());
    for (const line of lines) {
      expect(line.trimStart()).toMatch(/^-> /);
    }
  });

  it('Scan shows table name, adds alias only when different', () => {
    expect(formatPlan(LogicalScan('USERS', []))).toContain('Seq Scan on USERS');
    expect(formatPlan(LogicalScan('USERS', [], 'U'))).toContain('Seq Scan on USERS as U');
    const noAliasDup = formatPlan(LogicalScan('USERS', [], 'USERS'));
    expect(noAliasDup).toContain('Seq Scan on USERS as USERS');
  });

  it('Filter includes the formatted condition', () => {
    const plan = LogicalFilter(bin('=', col('U', 'ID'), lit(1)), LogicalScan('USERS', []));
    expect(formatPlan(plan)).toContain('Filter (condition: (U.ID = 1))');
  });

  it('Project lists all expressions', () => {
    const plan = LogicalProject([col('T', 'A'), col('T', 'B'), lit(42)], LogicalScan('T', []));
    expect(formatPlan(plan)).toContain('Project (T.A, T.B, 42)');
  });

  it('Join: INNER omits type prefix, LEFT/RIGHT/FULL show type', () => {
    const inner = LogicalJoin(JoinType.INNER, null, LogicalScan('A', []), LogicalScan('B', []));
    expect(formatPlan(inner)).toContain('Join');
    expect(formatPlan(inner)).not.toContain('INNER');

    const left = LogicalJoin(JoinType.LEFT, null, LogicalScan('A', []), LogicalScan('B', []));
    expect(formatPlan(left)).toContain('LEFT Join');
  });

  it('Join omits any physical operator name from the logical plan', () => {
    const inner = LogicalJoin(JoinType.INNER, null, LogicalScan('A', []), LogicalScan('B', []));
    expect(formatPlan(inner)).not.toContain('Hash');
    expect(formatPlan(inner)).not.toContain('Merge');
  });

  it('Join includes condition when present', () => {
    const join = LogicalJoin(JoinType.INNER, bin('=', col('A', 'ID'), col('B', 'AID')),
      LogicalScan('A', []), LogicalScan('B', []));
    expect(formatPlan(join)).toContain('condition: (A.ID = B.AID)');
  });

  it('Aggregate omits any physical operator name from the logical plan', () => {
    const agg = LogicalAggregate([], [], LogicalScan('T', []));
    expect(formatPlan(agg)).toContain('Aggregate');
    expect(formatPlan(agg)).not.toContain('Hash Aggregate');
    expect(formatPlan(agg)).not.toContain('Stream Aggregate');
  });

  it('Aggregate includes group by expressions', () => {
    const a = LogicalAggregate([col('T', 'DEPT'), col('T', 'REGION')], [], LogicalScan('T', []));
    expect(formatPlan(a)).toContain('group by: T.DEPT, T.REGION');
  });

  it('Sort formats order keys with direction', () => {
    const sort = LogicalSort([
      { expr: col('T', 'NAME'), direction: 'ASC' },
      { expr: col('T', 'AGE'), direction: 'DESC' },
    ], LogicalScan('T', []));
    expect(formatPlan(sort)).toContain('Sort (T.NAME ASC, T.AGE DESC)');
  });

  it('Limit shows count, offset only when non-zero', () => {
    expect(formatPlan(LogicalLimit(10, 0, LogicalScan('T', [])))).toContain('Limit (count: 10)');
    expect(formatPlan(LogicalLimit(10, 0, LogicalScan('T', [])))).not.toContain('offset');
    expect(formatPlan(LogicalLimit(10, 5, LogicalScan('T', [])))).toContain('Limit (count: 10, offset: 5)');
  });

  it('TopN shows count, offset, and order', () => {
    const topn = LogicalTopN([{ expr: col('T', 'ID'), direction: 'DESC' }], 5, 2, LogicalScan('T', []));
    expect(formatPlan(topn)).toContain('Top-N (count: 5, offset: 2, order: T.ID DESC)');
  });

  it('Union vs Union All', () => {
    const u = formatPlan(LogicalUnion(LogicalScan('A', []), LogicalScan('B', []), false));
    expect(u).toMatch(/-> Union\n/);
    expect(u).not.toContain('All');

    const uAll = formatPlan(LogicalUnion(LogicalScan('A', []), LogicalScan('B', []), true));
    expect(uAll).toContain('Union All');
  });

  it('CTE Scan and Anchor show cteName', () => {
    expect(formatPlan(LogicalCTEScan('active', 1))).toContain('CTE Scan (active)');
    const anchor = LogicalCTEAnchor('active', 1, LogicalScan('T', []), LogicalCTEScan('active', 1));
    const s = formatPlan(anchor);
    expect(s).toContain('CTE Anchor (active)');
    expect(s).toContain('CTE Scan (active)');
  });

  it('DependentJoin shows subquery type', () => {
    const dj = LogicalDependentJoin(LogicalScan('A', []), LogicalScan('B', []), [], 'NOT_EXISTS', null);
    expect(formatPlan(dj)).toContain('Dependent Join (NOT_EXISTS)');
  });

  it('IndexScan point lookup shows key, range shows bounds', () => {
    const point = LogicalIndexScan('T', 'T', 'pk', 'ID', 'point', 42, null, null, true, true, []);
    expect(formatPlan(point)).toContain('Index Scan using pk on T');
    expect(formatPlan(point)).toContain('key: 42');

    const range = LogicalIndexScan('T', 'T', 'idx_age', 'AGE', 'range', null, 18, 65, true, true, []);
    expect(formatPlan(range)).toContain('range: 18 to 65');
  });

  it('IndexScan with null bounds shows infinity symbols', () => {
    const open = LogicalIndexScan('T', 'T', 'idx', 'X', 'range', null, null, 100, true, true, []);
    expect(formatPlan(open)).toContain('range: -∞ to 100');

    const openHigh = LogicalIndexScan('T', 'T', 'idx', 'X', 'range', null, 50, null, true, true, []);
    expect(formatPlan(openHigh)).toContain('range: 50 to ∞');
  });

  it('IndexScan alias shown when different from table', () => {
    const iscan = LogicalIndexScan('USERS', 'U', 'pk', 'ID', 'point', 1, null, null, true, true, []);
    expect(formatPlan(iscan)).toContain('as U');
  });

  it('Materialize, Distinct, Empty', () => {
    expect(formatPlan(LogicalMaterialize(LogicalScan('T', [])))).toContain('Materialize');
    expect(formatPlan(LogicalDistinct(LogicalScan('T', [])))).toContain('Distinct');
    expect(formatPlan({ type: PlanNodeType.EMPTY, children: [] })).toContain('Empty (short-circuit)');
  });

  it('indentation increases by 2 spaces per depth level', () => {
    const plan = LogicalLimit(10, 0,
      LogicalSort([{ expr: col('T', 'ID'), direction: 'ASC' }],
        LogicalProject([col('T', 'ID')],
          LogicalFilter(bin('>', col('T', 'ID'), lit(0)),
            LogicalScan('T', [])))));

    const lines = formatPlan(plan).split('\n').filter(l => l.trim());
    expect(lines).toHaveLength(5);
    for (let i = 0; i < lines.length; i++) {
      const leadingSpaces = lines[i].match(/^(\s*)/)[1].length;
      expect(leadingSpaces).toBe(i * 2);
    }
  });

  it('complex plan: full readable output for a join under a filter', () => {
    const plan = LogicalProject(
      [col('U', 'NAME'), agg('SUM', [col('O', 'TOTAL')])],
      LogicalAggregate(
        [col('U', 'NAME')],
        [agg('SUM', [col('O', 'TOTAL')])],
        LogicalFilter(
          bin('=', col('U', 'ACTIVE'), { kind: BoundExprKind.LITERAL, value: true }),
          LogicalJoin(JoinType.INNER, bin('=', col('U', 'ID'), col('O', 'USER_ID')),
            LogicalScan('USERS', [], 'U'),
            LogicalScan('ORDERS', [], 'O')))));

    const output = formatPlan(plan);
    const lines = output.split('\n').filter(l => l.trim());

    expect(lines[0]).toContain('Project (U.NAME, SUM(O.TOTAL))');
    expect(lines[1]).toContain('Aggregate');
    expect(lines[1]).toContain('group by: U.NAME');
    expect(lines[2]).toContain('Filter (condition: (U.ACTIVE = true))');
    expect(lines[3]).toContain('Join (condition: (U.ID = O.USER_ID))');
    expect(lines[4]).toContain('Seq Scan on USERS as U');
    expect(lines[5]).toContain('Seq Scan on ORDERS as O');
  });
});
