import { describe, it, expect } from 'vitest';
import {
  CorrelationSet,
  collectColumnRefs,
  collectCorrelatedNodes,
  decorrelateRefs,
  ownExpressions,
  referencesCorrelation,
  substituteCorrelatedRefs,
} from '../../../src/optimizer/dependent-join/correlation.js';
import {
  LogicalAggregate,
  LogicalFilter,
  LogicalJoin,
  LogicalLimit,
  LogicalProject,
  LogicalScan,
  LogicalWindow,
  JoinType,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const colRef = (table, name, opts = {}) => ({
  kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: name, columnIndex: 0, dataType: null, depth: 0, isCorrelated: false, ...opts,
});
const corrRef = (table, name) => colRef(table, name, { depth: 1, isCorrelated: true });
const lit = (value) => ({ kind: BoundExprKind.LITERAL, value, dataType: null });
const bin = (left, op, right) => ({ kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' });
const scan = (name) => LogicalScan(name, [], name);

describe('correlation analysis', () => {
  describe('CorrelationSet', () => {
    it('deduplicates the correlated columns it was built from', () => {
      const set = new CorrelationSet([corrRef('a', 'id'), corrRef('A', 'ID'), corrRef('a', 'val')]);
      expect(set.size).toBe(2);
    });

    it('matches a reference that carries the correlated flag', () => {
      expect(new CorrelationSet([]).matches(corrRef('a', 'id'))).toBe(true);
    });

    it('matches a reference naming a correlated column even without the flag', () => {
      const set = new CorrelationSet([corrRef('a', 'id')]);
      expect(set.matches(colRef('A', 'ID'))).toBe(true);
      expect(set.matches(colRef('b', 'id'))).toBe(false);
    });

    it('reports the position of a correlated column so domains can line up', () => {
      const set = new CorrelationSet([corrRef('a', 'id'), corrRef('a', 'val')]);
      expect(set.indexOf(corrRef('a', 'val'))).toBe(1);
      expect(set.indexOf(corrRef('a', 'other'))).toBe(-1);
    });
  });

  describe('expression predicates', () => {
    const set = new CorrelationSet([corrRef('a', 'id')]);

    it('finds a correlated reference nested inside an expression', () => {
      expect(referencesCorrelation(bin(lit(1), '+', corrRef('a', 'id')), set)).toBe(true);
    });

    it('reports no correlation for a purely local expression', () => {
      expect(referencesCorrelation(bin(colRef('b', 'id'), '=', lit(1)), set)).toBe(false);
    });

    it('clears the correlation marks when decorrelating', () => {
      const decorrelated = decorrelateRefs(bin(corrRef('a', 'id'), '=', colRef('b', 'id')), set);
      expect(decorrelated.left.isCorrelated).toBe(false);
      expect(decorrelated.left.depth).toBe(0);
      expect(decorrelated.right).toEqual(colRef('b', 'id'));
    });

    it('replaces correlated references with the expression the domain supplies', () => {
      const replaced = substituteCorrelatedRefs(bin(corrRef('a', 'id'), '=', colRef('b', 'id')), set, () => lit(7));
      expect(replaced.left).toEqual(lit(7));
    });

    it('collects every column reference, correlated or not', () => {
      const refs = collectColumnRefs(bin(corrRef('a', 'id'), '=', colRef('b', 'id')));
      expect(refs.map((ref) => ref.columnName)).toEqual(['id', 'id']);
    });
  });

  describe('plan expressions', () => {
    it('reads the expressions each operator owns', () => {
      const condition = bin(colRef('b', 'id'), '=', lit(1));
      expect(ownExpressions(LogicalFilter(condition, scan('b')))).toEqual([condition]);
      expect(ownExpressions(LogicalAggregate([colRef('b', 'id')], [lit(1)], scan('b')))).toHaveLength(2);
      expect(ownExpressions(LogicalWindow([lit(1)], scan('b')))).toHaveLength(1);
      expect(ownExpressions(LogicalLimit(1, 0, scan('b')))).toEqual([]);
    });
  });

  describe('correlated node marking', () => {
    const set = new CorrelationSet([corrRef('a', 'id')]);

    it('marks the operator holding the correlated predicate and every ancestor', () => {
      const filter = LogicalFilter(bin(corrRef('a', 'id'), '=', colRef('b', 'id')), scan('b'));
      const project = LogicalProject([colRef('b', 'id')], filter);

      const correlated = collectCorrelatedNodes(project, set);

      expect(correlated.has(project)).toBe(true);
      expect(correlated.has(filter)).toBe(true);
      expect(correlated.has(filter.children[0])).toBe(false);
    });

    it('leaves an uncorrelated sibling branch unmarked', () => {
      const left = LogicalFilter(bin(corrRef('a', 'id'), '=', colRef('b', 'id')), scan('b'));
      const right = scan('c');
      const join = LogicalJoin(JoinType.INNER, null, left, right);

      const correlated = collectCorrelatedNodes(join, set);

      expect(correlated.has(join)).toBe(true);
      expect(correlated.has(left)).toBe(true);
      expect(correlated.has(right)).toBe(false);
    });
  });
});
