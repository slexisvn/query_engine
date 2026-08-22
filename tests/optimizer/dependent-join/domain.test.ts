import { describe, it, expect } from 'vitest';
import { CorrelationSet } from '../../../src/optimizer/dependent-join/correlation.js';
import {
  DomainKind,
  LiftedDomain,
  MaterializedDomain,
  equiBindingColumn,
  nullSafeEquals,
} from '../../../src/optimizer/dependent-join/domain.js';
import { JoinType, LogicalScan, PlanNodeType } from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const colRef = (table, name, opts = {}) => ({
  kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: name, columnIndex: 0, dataType: null, depth: 0, isCorrelated: false, ...opts,
});
const corrRef = (table, name) => colRef(table, name, { depth: 1, isCorrelated: true });
const lit = (value) => ({ kind: BoundExprKind.LITERAL, value, dataType: null });
const bin = (left, op, right) => ({ kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' });
const scan = (name) => LogicalScan(name, [], name);

const CORRELATION = new CorrelationSet([corrRef('a', 'id'), corrRef('a', 'val')]);

function evaluate(expr, values) {
  switch (expr.kind) {
    case BoundExprKind.LITERAL: return expr.value;
    case BoundExprKind.COLUMN_REF: return values[`${expr.tableAlias}.${expr.columnName}`];
    case BoundExprKind.IS_NULL: {
      const operand = evaluate(expr.expr, values);
      return expr.negated ? operand !== null : operand === null;
    }
    case BoundExprKind.BINARY: {
      const left = evaluate(expr.left, values);
      const right = evaluate(expr.right, values);
      if (expr.op === 'AND') return (left === false || right === false) ? false : (left === null || right === null) ? null : true;
      if (expr.op === 'OR') return (left === true || right === true) ? true : (left === null || right === null) ? null : false;
      return (left === null || right === null) ? null : left === right;
    }
    default: throw new Error(`unexpected ${expr.kind}`);
  }
}

describe('correlation domains', () => {
  describe('equality bindings', () => {
    it('reads the inner column that an equality binds a correlated column to', () => {
      const binding = equiBindingColumn(bin(corrRef('a', 'id'), '=', colRef('b', 'id')), CORRELATION);
      expect(binding).toEqual(colRef('b', 'id'));
    });

    it('reads the binding whichever side the correlation is on', () => {
      const binding = equiBindingColumn(bin(colRef('b', 'id'), '=', corrRef('a', 'id')), CORRELATION);
      expect(binding).toEqual(colRef('b', 'id'));
    });

    it('refuses a comparison that is not an equality', () => {
      expect(equiBindingColumn(bin(corrRef('a', 'id'), '>', colRef('b', 'id')), CORRELATION)).toBeNull();
    });

    it('refuses an equality whose inner side is not a plain column', () => {
      expect(equiBindingColumn(bin(corrRef('a', 'id'), '=', bin(colRef('b', 'id'), '+', lit(1))), CORRELATION)).toBeNull();
    });

    it('refuses an equality that correlates on both sides', () => {
      expect(equiBindingColumn(bin(corrRef('a', 'id'), '=', corrRef('a', 'val')), CORRELATION)).toBeNull();
    });
  });

  describe('null-safe equality', () => {
    const expr = nullSafeEquals(colRef('a', 'val'), colRef('d', 'c0'));
    const check = (outer, domain) => evaluate(expr, { 'a.val': outer, 'd.c0': domain });

    it('matches two equal values', () => {
      expect(check(1, 1)).toBe(true);
    });

    it('matches two nulls', () => {
      expect(check(null, null)).toBe(true);
    });

    it('reports false, never unknown, when only one side is null', () => {
      expect(check(null, 1)).toBe(false);
      expect(check(1, null)).toBe(false);
    });

    it('reports false for two different values', () => {
      expect(check(1, 2)).toBe(false);
    });
  });

  describe('the lifted domain', () => {
    const domain = new LiftedDomain(CORRELATION, false);

    it('leaves the subquery untouched where the dependent join stops', () => {
      const node = scan('b');
      expect(domain.anchor(node)).toEqual({ plan: node, columns: [] });
    });

    it('hoists a correlated predicate into the join condition instead of keeping it', () => {
      const outcome = domain.correlatedConjunct(bin(corrRef('a', 'id'), '=', colRef('b', 'id')));

      expect(outcome.keep).toBeNull();
      expect(outcome.lift.left.isCorrelated).toBe(false);
      expect(outcome.column).toEqual(colRef('b', 'id'));
    });

    it('hoists a non-equality correlation without offering a domain column', () => {
      const outcome = domain.correlatedConjunct(bin(corrRef('a', 'id'), '>', colRef('b', 'id')));

      expect(outcome.lift).not.toBeNull();
      expect(outcome.column).toBeNull();
    });

    it('contributes nothing to the join condition of its own', () => {
      expect(domain.kind).toBe(DomainKind.LIFTED);
      expect(domain.width).toBe(0);
      expect(domain.joinBack()).toEqual([]);
    });
  });

  describe('the materialized domain', () => {
    it('cross-joins the distinct correlating tuples into the subquery', () => {
      const domain = new MaterializedDomain(CORRELATION, scan('a'));
      const anchor = domain.anchor(scan('b'));

      expect(anchor.plan.type).toBe(PlanNodeType.JOIN);
      expect(anchor.plan.joinType).toBe(JoinType.CROSS);
      expect(anchor.plan.children[0].table).toBe('b');

      const relation = anchor.plan.children[1];
      expect(relation.type).toBe(PlanNodeType.DISTINCT);
      expect(relation.children[0].expressions.map((expr) => expr.outputName)).toEqual(['c0', 'c1']);
      expect(relation.children[0].expressions.every((expr) => expr.isCorrelated === false)).toBe(true);
      expect(relation.children[0].children[0].table).toBe('a');
    });

    it('gives each instance its own alias so two of them never collide', () => {
      const domain = new MaterializedDomain(CORRELATION, scan('a'));
      const first = domain.anchor(scan('b'));
      const second = domain.anchor(scan('c'));

      expect(first.columns[0].tableAlias).not.toBe(second.columns[0].tableAlias);
    });

    it('keeps the correlated predicate in place, rewritten onto the domain columns', () => {
      const domain = new MaterializedDomain(CORRELATION, scan('a'));
      const { columns } = domain.anchor(scan('b'));

      const outcome = domain.correlatedConjunct(bin(corrRef('a', 'id'), '>', colRef('b', 'id')), columns);

      expect(outcome.lift).toBeNull();
      expect(outcome.column).toBeNull();
      expect(outcome.keep.left).toEqual(columns[0]);
    });

    it('joins the outer row back onto one condition per correlated column', () => {
      const domain = new MaterializedDomain(CORRELATION, scan('a'));
      const { columns } = domain.anchor(scan('b'));

      const conditions = domain.joinBack(columns, [false, false]);

      expect(conditions).toHaveLength(2);
      expect(conditions[0].op).toBe('=');
      expect(conditions[0].left).toEqual(colRef('a', 'id'));
      expect(conditions[0].right).toEqual(columns[0]);
    });

    it('compares null to null only for the columns asked to be null-safe', () => {
      const domain = new MaterializedDomain(CORRELATION, scan('a'));
      const { columns } = domain.anchor(scan('b'));

      const conditions = domain.joinBack(columns, [false, true]);

      expect(conditions[0].op).toBe('=');
      expect(conditions[1].op).toBe('OR');
      expect(evaluate(conditions[1], { 'a.val': null, [`${columns[1].tableAlias}.c1`]: null })).toBe(true);
    });

    it('recognises its own domain columns for the null-rejection question', () => {
      const domain = new MaterializedDomain(CORRELATION, scan('a'));
      const { columns } = domain.anchor(scan('b'));
      const matcher = domain.columnMatcher(1);

      expect(matcher(columns[1])).toBe(true);
      expect(matcher(columns[0])).toBe(false);
      expect(matcher(colRef('b', 'c1'))).toBe(false);
    });
  });
});
