import { describe, it, expect } from 'vitest';
import { CorrelationSet, collectCorrelatedNodes } from '../../../src/optimizer/dependent-join/correlation.js';
import { chooseDomain } from '../../../src/optimizer/dependent-join/domain-choice.js';
import { DomainKind } from '../../../src/optimizer/dependent-join/domain.js';
import {
  JoinType,
  LogicalAggregate,
  LogicalDistinct,
  LogicalFilter,
  LogicalJoin,
  LogicalLimit,
  LogicalProject,
  LogicalScan,
  LogicalUnion,
  LogicalWindow,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const colRef = (table, name, opts = {}) => ({
  kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: name, columnIndex: 0, dataType: null, depth: 0, isCorrelated: false, ...opts,
});
const corrRef = (table, name) => colRef(table, name, { depth: 1, isCorrelated: true });
const lit = (value) => ({ kind: BoundExprKind.LITERAL, value, dataType: null });
const bin = (left, op, right) => ({ kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' });
const agg = (name, args) => ({ kind: BoundExprKind.AGGREGATE, name, args, distinct: false, resultType: 'INT64', outputName: 'n' });
const window = (name, partitionBy) => ({
  kind: BoundExprKind.WINDOW, name, args: [], partitionBy, orderBy: [], frame: null, resultType: 'INT64',
});
const scan = (name) => LogicalScan(name, [], name);

const CORRELATION = new CorrelationSet([corrRef('a', 'id'), corrRef('a', 'val')]);

function kindFor(subquery, set = CORRELATION) {
  const correlated = collectCorrelatedNodes(subquery, set);
  return chooseDomain(subquery, scan('a'), set, correlated, false).kind;
}

const equality = () => bin(corrRef('a', 'id'), '=', colRef('b', 'id'));
const inequality = () => bin(corrRef('a', 'val'), '>', colRef('b', 'val'));

describe('correlation domain choice', () => {
  describe('predicates that can be hoisted', () => {
    it('lifts an equality correlation with nothing above it', () => {
      expect(kindFor(LogicalProject([colRef('b', 'val')], LogicalFilter(equality(), scan('b'))))).toBe(DomainKind.LIFTED);
    });

    it('lifts a non-equality correlation with nothing above it', () => {
      expect(kindFor(LogicalProject([colRef('b', 'val')], LogicalFilter(inequality(), scan('b'))))).toBe(DomainKind.LIFTED);
    });

    it('lifts a correlated condition on an inner join', () => {
      const join = LogicalJoin(JoinType.INNER, equality(), scan('b'), scan('c'));
      expect(kindFor(LogicalProject([colRef('b', 'val')], join))).toBe(DomainKind.LIFTED);
    });

    it('lifts through a join that preserves the correlated side', () => {
      const join = LogicalJoin(JoinType.LEFT, bin(colRef('b', 'id'), '=', colRef('c', 'id')), LogicalFilter(inequality(), scan('b')), scan('c'));
      expect(kindFor(LogicalProject([colRef('b', 'val')], join))).toBe(DomainKind.LIFTED);
    });
  });

  describe('correlation that has to be materialized', () => {
    it('materializes when a correlated reference sits in a projection', () => {
      const project = LogicalProject([bin(colRef('b', 'val'), '+', corrRef('a', 'val'))], scan('b'));
      expect(kindFor(project)).toBe(DomainKind.MATERIALIZED);
    });

    it('materializes when a correlated reference sits in an aggregate argument', () => {
      const aggregate = LogicalAggregate([], [agg('SUM', [bin(colRef('b', 'val'), '+', corrRef('a', 'val'))])], scan('b'));
      expect(kindFor(LogicalProject([colRef('', 'n')], aggregate))).toBe(DomainKind.MATERIALIZED);
    });

    it('materializes a non-equality correlation underneath a row limit', () => {
      const limited = LogicalLimit(1, 0, LogicalProject([colRef('b', 'val')], LogicalFilter(inequality(), scan('b'))));
      expect(kindFor(limited)).toBe(DomainKind.MATERIALIZED);
    });

    it('materializes a non-equality correlation underneath an aggregate', () => {
      const aggregate = LogicalAggregate([], [agg('COUNT', [])], LogicalFilter(inequality(), scan('b')));
      expect(kindFor(LogicalProject([colRef('', 'n')], aggregate))).toBe(DomainKind.MATERIALIZED);
    });

    it('materializes a non-equality correlation underneath DISTINCT', () => {
      const distinct = LogicalDistinct(LogicalProject([colRef('b', 'val')], LogicalFilter(inequality(), scan('b'))));
      expect(kindFor(distinct)).toBe(DomainKind.MATERIALIZED);
    });

    it('materializes a non-equality correlation underneath a window', () => {
      const windowed = LogicalWindow([window('SUM', [])], LogicalFilter(inequality(), scan('b')));
      expect(kindFor(LogicalProject([colRef('b', 'val')], windowed))).toBe(DomainKind.MATERIALIZED);
    });

    it('materializes correlation inside a set operation', () => {
      const union = LogicalUnion(
        LogicalProject([colRef('b', 'val')], LogicalFilter(equality(), scan('b'))),
        LogicalProject([colRef('c', 'val')], scan('c')),
        false,
      );
      expect(kindFor(union)).toBe(DomainKind.MATERIALIZED);
    });

    it('materializes when both sides of a join correlate', () => {
      const join = LogicalJoin(JoinType.INNER, null, LogicalFilter(equality(), scan('b')), LogicalFilter(equality(), scan('c')));
      expect(kindFor(LogicalProject([colRef('b', 'val')], join))).toBe(DomainKind.MATERIALIZED);
    });

    it('materializes when only the null-producing side of an outer join correlates', () => {
      const join = LogicalJoin(JoinType.LEFT, null, scan('c'), LogicalFilter(equality(), scan('b')));
      expect(kindFor(LogicalProject([colRef('c', 'val')], join))).toBe(DomainKind.MATERIALIZED);
    });

    it('materializes a correlated condition on an outer join', () => {
      const join = LogicalJoin(JoinType.LEFT, inequality(), scan('c'), scan('b'));
      expect(kindFor(LogicalProject([colRef('c', 'val')], join))).toBe(DomainKind.MATERIALIZED);
    });

    it('materializes a correlated sort key', () => {
      const aggregate = LogicalAggregate([], [agg('COUNT', [])], LogicalFilter(bin(colRef('b', 'val'), '>', lit(1)), scan('b')));
      const project = LogicalProject([bin(colRef('', 'n'), '+', corrRef('a', 'id'))], aggregate);
      expect(kindFor(project)).toBe(DomainKind.MATERIALIZED);
    });
  });

  it('lifts trivially when nothing correlates at all', () => {
    expect(kindFor(LogicalProject([colRef('b', 'val')], scan('b')), new CorrelationSet([]))).toBe(DomainKind.LIFTED);
  });
});
