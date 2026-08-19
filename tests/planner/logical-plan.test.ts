import {
  PlanNodeType, JoinType,
  LogicalScan, LogicalFilter, LogicalProject, LogicalJoin, LogicalAggregate,
  LogicalSort, LogicalLimit, LogicalDistinct, LogicalUnion, LogicalCTEScan,
  LogicalCTEAnchor, LogicalDependentJoin, LogicalTopN, LogicalIndexScan,
  LogicalMaterialize, getChildren, setChildren, planToString,
} from '../../src/planner/logical-plan.js';

function lit(v) {
  return { kind: 'BoundLiteral', value: v };
}

describe('setChildren immutability', () => {
  it('returns a new node object, does not mutate the original', () => {
    const scanA = LogicalScan('A', []);
    const scanB = LogicalScan('B', []);
    const filter = LogicalFilter(lit(1), scanA);

    const updated = setChildren(filter, [scanB]);

    expect(filter.children[0]).toBe(scanA);
    expect(updated.children[0]).toBe(scanB);
    expect(updated).not.toBe(filter);
  });

  it('preserves all non-children properties', () => {
    const join = LogicalJoin(JoinType.LEFT, lit('cond'), LogicalScan('A', []), LogicalScan('B', []));
    const newLeft = LogicalScan('C', []);
    const updated = setChildren(join, [newLeft, join.children[1]]);

    expect(updated.joinType).toBe(JoinType.LEFT);
    expect(updated.condition).toBe(join.condition);
    expect(updated.joinType).toBe(JoinType.LEFT);
    expect(updated.children[0].table).toBe('C');
  });

  it('handles replacing children of aggregate node', () => {
    const agg = LogicalAggregate([lit('dept')], [{ name: 'COUNT' }], LogicalScan('T', []));
    const newChild = LogicalFilter(lit(1), LogicalScan('T', []));
    const updated = setChildren(agg, [newChild]);

    expect(updated.groupBy).toBe(agg.groupBy);
    expect(updated.aggregates).toBe(agg.aggregates);
    expect(updated.children[0].type).toBe(PlanNodeType.FILTER);
  });
});

describe('getChildren edge cases', () => {
  it('returns empty array for plain object with no children', () => {
    expect(getChildren({})).toEqual([]);
    expect(getChildren({ type: 'Unknown' })).toEqual([]);
  });

  it('returns the actual children array (not a copy)', () => {
    const scan = LogicalScan('T', []);
    const filter = LogicalFilter(lit(1), scan);
    expect(getChildren(filter)).toBe(filter.children);
  });

  it('returns empty for CTE_SCAN which has no children', () => {
    expect(getChildren(LogicalCTEScan('x', 1))).toEqual([]);
  });
});

describe('LogicalLimit offset defaulting', () => {
  it('coerces null offset to 0', () => {
    expect(LogicalLimit(10, null, LogicalScan('T', [])).offset).toBe(0);
  });

  it('coerces undefined offset to 0', () => {
    expect(LogicalLimit(10, undefined, LogicalScan('T', [])).offset).toBe(0);
  });

  it('preserves explicit 0', () => {
    expect(LogicalLimit(10, 0, LogicalScan('T', [])).offset).toBe(0);
  });

  it('preserves non-zero offset', () => {
    expect(LogicalLimit(10, 25, LogicalScan('T', [])).offset).toBe(25);
  });
});

describe('LogicalUnion boolean coercion', () => {
  it('coerces truthy values to true', () => {
    expect(LogicalUnion(LogicalScan('A', []), LogicalScan('B', []), 1).all).toBe(true);
    expect(LogicalUnion(LogicalScan('A', []), LogicalScan('B', []), 'yes').all).toBe(true);
  });

  it('coerces falsy values to false', () => {
    expect(LogicalUnion(LogicalScan('A', []), LogicalScan('B', []), 0).all).toBe(false);
    expect(LogicalUnion(LogicalScan('A', []), LogicalScan('B', []), '').all).toBe(false);
    expect(LogicalUnion(LogicalScan('A', []), LogicalScan('B', []), null).all).toBe(false);
    expect(LogicalUnion(LogicalScan('A', []), LogicalScan('B', []), undefined).all).toBe(false);
  });
});

describe('LogicalScan / LogicalIndexScan alias defaulting', () => {
  it('Scan defaults alias to table when omitted', () => {
    expect(LogicalScan('USERS', []).alias).toBe('USERS');
  });

  it('Scan uses provided alias when given', () => {
    expect(LogicalScan('USERS', [], 'U').alias).toBe('U');
  });

  it('IndexScan defaults alias to table when null', () => {
    expect(LogicalIndexScan('T', null, 'idx', 'X', 'point', 1, null, null, true, true, []).alias).toBe('T');
  });
});

describe('planToString', () => {
  it('renders simple scan without alias duplication', () => {
    const s = planToString(LogicalScan('USERS', []));
    expect(s).toBe('Scan(USERS)\n');
  });

  it('renders scan with different alias', () => {
    const s = planToString(LogicalScan('USERS', [], 'U'));
    expect(s).toBe('Scan(USERS AS U)\n');
  });

  it('omits alias when alias equals table name', () => {
    const s = planToString(LogicalScan('USERS', [], 'USERS'));
    expect(s).toBe('Scan(USERS)\n');
  });

  it('renders 4-level deep tree with correct indentation per level', () => {
    const plan = LogicalLimit(10, 0,
      LogicalSort([],
        LogicalFilter(lit(1),
          LogicalScan('T', []))));
    const lines = planToString(plan).split('\n').filter(l => l.length > 0);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('Limit(10)');
    expect(lines[1]).toBe('  Sort');
    expect(lines[2]).toBe('    Filter');
    expect(lines[3]).toBe('      Scan(T)');
  });

  it('renders join with two children at same indent level', () => {
    const join = LogicalJoin(JoinType.INNER, null, LogicalScan('A', []), LogicalScan('B', []));
    const lines = planToString(join).split('\n').filter(l => l.length > 0);

    expect(lines[0]).toBe('Join(INNER)');
    expect(lines[1]).toBe('  Scan(A)');
    expect(lines[2]).toBe('  Scan(B)');
  });

  it('renders limit with offset', () => {
    const s = planToString(LogicalLimit(10, 5, LogicalScan('T', [])));
    expect(s).toContain('Limit(10, offset=5)');
  });

  it('omits offset=0 in limit', () => {
    const s = planToString(LogicalLimit(10, 0, LogicalScan('T', [])));
    expect(s).toBe('Limit(10)\n  Scan(T)\n');
  });

  it('renders TopN with offset', () => {
    expect(planToString(LogicalTopN([], 5, 3, LogicalScan('T', [])))).toContain('TopN(5, offset=3)');
  });

  it('omits offset=0 in TopN', () => {
    expect(planToString(LogicalTopN([], 5, 0, LogicalScan('T', [])))).toBe('TopN(5)\n  Scan(T)\n');
  });

  it('renders DependentJoin with subquery type', () => {
    const dj = LogicalDependentJoin(LogicalScan('A', []), LogicalScan('B', []), [], 'EXISTS', null);
    const lines = planToString(dj).split('\n').filter(l => l.length > 0);
    expect(lines[0]).toBe('DependentJoin(EXISTS)');
    expect(lines[1]).toBe('  Scan(A)');
    expect(lines[2]).toBe('  Scan(B)');
  });

  it('renders IndexScan with index name', () => {
    const iscan = LogicalIndexScan('USERS', 'U', 'pk_users', 'ID', 'point', 42, null, null, true, true, []);
    expect(planToString(iscan).trim()).toBe('IndexScan(USERS using pk_users)');
  });

  it('renders CTE nodes with cteName', () => {
    const anchor = LogicalCTEAnchor('active', 1, LogicalScan('T', []), LogicalCTEScan('active', 1));
    const lines = planToString(anchor).split('\n').filter(l => l.length > 0);
    expect(lines[0]).toBe('CTEAnchor(active)');
    expect(lines[1]).toBe('  Scan(T)');
    expect(lines[2]).toBe('  CTEScan(active)');
  });

  it('renders complex plan tree with correct full structure', () => {
    const plan = LogicalLimit(100, 10,
      LogicalSort([],
        LogicalProject([],
          LogicalFilter(lit(1),
            LogicalJoin(JoinType.LEFT, null,
              LogicalScan('ORDERS', [], 'O'),
              LogicalScan('CUSTOMERS', [], 'C'))))));

    const lines = planToString(plan).split('\n').filter(l => l.length > 0);
    expect(lines).toEqual([
      'Limit(100, offset=10)',
      '  Sort',
      '    Project',
      '      Filter',
      '        Join(LEFT)',
      '          Scan(ORDERS AS O)',
      '          Scan(CUSTOMERS AS C)',
    ]);
  });

  it('renders Union with two complete subtrees', () => {
    const union = LogicalUnion(
      LogicalProject([], LogicalScan('A', [])),
      LogicalProject([], LogicalScan('B', [])),
      false,
    );
    const lines = planToString(union).split('\n').filter(l => l.length > 0);
    expect(lines).toEqual([
      'SetOp(UNION)',
      '  Project',
      '    Scan(A)',
      '  Project',
      '    Scan(B)',
    ]);
  });
});
