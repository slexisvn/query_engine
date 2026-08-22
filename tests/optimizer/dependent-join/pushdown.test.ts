import { describe, it, expect } from 'vitest';
import { CorrelationSet, collectCorrelatedNodes } from '../../../src/optimizer/dependent-join/correlation.js';
import { LiftedDomain, MaterializedDomain } from '../../../src/optimizer/dependent-join/domain.js';
import { DomainRole, domainRoleOf, pushDependentJoin, rowLimitOf } from '../../../src/optimizer/dependent-join/pushdown.js';
import {
  JoinType,
  LogicalAggregate,
  LogicalDistinct,
  LogicalFilter,
  LogicalJoin,
  LogicalLimit,
  LogicalProject,
  LogicalScan,
  LogicalSort,
  LogicalTopN,
  LogicalUnion,
  LogicalWindow,
  PlanNodeType,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

const colRef = (table, name, opts = {}) => ({
  kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: name, columnIndex: 0, dataType: null, depth: 0, isCorrelated: false, ...opts,
});
const corrRef = (table, name) => colRef(table, name, { depth: 1, isCorrelated: true });
const lit = (value) => ({ kind: BoundExprKind.LITERAL, value, dataType: null });
const bin = (left, op, right) => ({ kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' });
const agg = (name, args) => ({ kind: BoundExprKind.AGGREGATE, name, args, distinct: false, resultType: 'INT64', outputName: 'n' });
const win = (name, partitionBy, outputName) => ({
  kind: BoundExprKind.WINDOW, name, args: [], partitionBy, orderBy: [], frame: null, resultType: 'INT64', outputName,
});
const scan = (name) => LogicalScan(name, [], name);

const CORRELATION = new CorrelationSet([corrRef('a', 'id')]);
const equality = () => bin(corrRef('a', 'id'), '=', colRef('b', 'id'));
const inequality = () => bin(corrRef('a', 'id'), '>', colRef('b', 'id'));

function pushLifted(subquery, set = CORRELATION) {
  return pushDependentJoin(subquery, set, new LiftedDomain(set, false), collectCorrelatedNodes(subquery, set), false);
}

function pushMaterialized(subquery, { alwaysNullSafe = false, set = CORRELATION } = {}) {
  const domain = new MaterializedDomain(set, scan('a'));
  return pushDependentJoin(subquery, set, domain, collectCorrelatedNodes(subquery, set), alwaysNullSafe);
}

function findNode(node, type, matches = () => true) {
  if (!node) return null;
  if (node.type === type && matches(node)) return node;
  for (const child of node.children || []) {
    const found = findNode(child, type, matches);
    if (found) return found;
  }
  return null;
}

describe('dependent join pushdown', () => {
  describe('operator roles', () => {
    it('treats the operators that need a partition as domain consumers', () => {
      expect(domainRoleOf(LogicalAggregate([], [], scan('b')))).toBe(DomainRole.CONSUMES);
      expect(domainRoleOf(LogicalDistinct(scan('b')))).toBe(DomainRole.CONSUMES);
      expect(domainRoleOf(LogicalLimit(1, 0, scan('b')))).toBe(DomainRole.CONSUMES);
      expect(domainRoleOf(LogicalTopN([], 1, 0, scan('b')))).toBe(DomainRole.CONSUMES);
      expect(domainRoleOf(LogicalWindow([], scan('b')))).toBe(DomainRole.CONSUMES);
    });

    it('treats a sort as a consumer only once it carries a limit', () => {
      const sort = LogicalSort([], scan('b'));
      expect(domainRoleOf(sort)).toBe(DomainRole.TRANSPARENT);
      expect(domainRoleOf({ ...sort, limit: 3 })).toBe(DomainRole.CONSUMES);
    });

    it('treats operators with two inputs as branching', () => {
      expect(domainRoleOf(LogicalJoin(JoinType.INNER, null, scan('b'), scan('c')))).toBe(DomainRole.BRANCHING);
      expect(domainRoleOf(LogicalUnion(scan('b'), scan('c'), true))).toBe(DomainRole.BRANCHING);
    });

    it('reads the count, offset and ordering of every row-limiting operator', () => {
      expect(rowLimitOf(LogicalLimit(3, 2, scan('b')))).toMatchObject({ count: 3, offset: 2 });
      expect(rowLimitOf(LogicalTopN([{ expr: colRef('b', 'id') }], 3, 2, scan('b')))).toMatchObject({ count: 3, offset: 2 });
      expect(rowLimitOf(LogicalSort([], scan('b')))).toBeNull();
    });
  });

  describe('the lifted domain', () => {
    it('hoists the correlated predicate out of the subquery into the join condition', () => {
      const pushed = pushLifted(LogicalProject([colRef('b', 'val')], LogicalFilter(equality(), scan('b'))));

      expect(findNode(pushed.plan, PlanNodeType.FILTER)).toBeNull();
      expect(pushed.conditions).toHaveLength(1);
      expect(pushed.conditions[0].left.isCorrelated).toBe(false);
    });

    it('keeps the local part of a mixed predicate in the subquery', () => {
      const condition = bin(equality(), 'AND', bin(colRef('b', 'val'), '>', lit(0)));
      const pushed = pushLifted(LogicalProject([colRef('b', 'val')], LogicalFilter(condition, scan('b'))));

      const filter = findNode(pushed.plan, PlanNodeType.FILTER);
      expect(filter.condition.op).toBe('>');
    });

    it('projects the columns the hoisted predicate still needs', () => {
      const pushed = pushLifted(LogicalProject([colRef('b', 'val')], LogicalFilter(inequality(), scan('b'))));

      const project = findNode(pushed.plan, PlanNodeType.PROJECT);
      expect(project.expressions.map((expr) => expr.columnName)).toEqual(['val', 'id']);
    });

    it('renames the hoisted predicate when a derived table renames its column', () => {
      const derived = LogicalProject([{ ...colRef('b', 'id'), outputName: 'dd' }], LogicalFilter(inequality(), scan('b')), 'x');
      const pushed = pushLifted(derived);

      expect(pushed.conditions[0].right).toMatchObject({ tableAlias: 'x', columnName: 'dd' });
    });

    it('groups a correlated aggregate by the column the correlation binds', () => {
      const aggregate = LogicalAggregate([], [agg('COUNT', [])], LogicalFilter(equality(), scan('b')));
      const pushed = pushLifted(LogicalProject([colRef('', 'n')], aggregate));

      const grouped = findNode(pushed.plan, PlanNodeType.AGGREGATE);
      expect(grouped.groupBy).toEqual([colRef('b', 'id')]);
    });
  });

  describe('the materialized domain', () => {
    it('cross-joins the correlating values in and keeps the predicate in place', () => {
      const pushed = pushMaterialized(LogicalProject([colRef('b', 'val')], LogicalFilter(inequality(), scan('b'))));

      const cross = findNode(pushed.plan, PlanNodeType.JOIN, (node) => node.joinType === JoinType.CROSS);
      expect(cross).not.toBeNull();
      const filter = findNode(pushed.plan, PlanNodeType.FILTER);
      expect(filter.condition.left.tableAlias).toMatch(/^__domain_/);
    });

    it('joins the outer row back onto the domain column', () => {
      const pushed = pushMaterialized(LogicalProject([colRef('b', 'val')], LogicalFilter(inequality(), scan('b'))));

      expect(pushed.conditions).toHaveLength(1);
      expect(pushed.conditions[0].op).toBe('=');
      expect(pushed.conditions[0].right.tableAlias).toMatch(/^__domain_/);
    });

    it('compares null to null when the subquery can still produce rows for a null correlation', () => {
      const condition = bin(colRef('b', 'val'), '=', lit(1));
      const project = LogicalProject([bin(colRef('b', 'val'), '+', corrRef('a', 'id'))], LogicalFilter(condition, scan('b')));

      const pushed = pushMaterialized(project);

      expect(pushed.conditions[0].op).toBe('OR');
    });

    it('uses a plain equality when the subquery rejects a null correlation', () => {
      const pushed = pushMaterialized(LogicalProject([colRef('b', 'val')], LogicalFilter(inequality(), scan('b'))));

      expect(pushed.conditions[0].op).toBe('=');
    });

    it('compares null to null on demand even when the subquery rejects nulls', () => {
      const pushed = pushMaterialized(LogicalProject([colRef('b', 'val')], LogicalFilter(inequality(), scan('b'))), { alwaysNullSafe: true });

      expect(pushed.conditions[0].op).toBe('OR');
    });

    it('groups an aggregate by the domain columns', () => {
      const aggregate = LogicalAggregate([], [agg('COUNT', [])], LogicalFilter(inequality(), scan('b')));
      const pushed = pushMaterialized(LogicalProject([colRef('', 'n')], aggregate));

      const grouped = findNode(pushed.plan, PlanNodeType.AGGREGATE);
      expect(grouped.groupBy).toHaveLength(1);
      expect(grouped.groupBy[0].tableAlias).toMatch(/^__domain_/);
    });

    it('partitions an existing window by the domain columns', () => {
      const windowed = LogicalWindow([win('SUM', [colRef('b', 'val')])], LogicalFilter(inequality(), scan('b')));
      const pushed = pushMaterialized(LogicalProject([colRef('b', 'val')], windowed));

      const window = findNode(pushed.plan, PlanNodeType.WINDOW);
      expect(window.windowExprs[0].partitionBy).toHaveLength(2);
      expect(window.windowExprs[0].partitionBy[1].tableAlias).toMatch(/^__domain_/);
    });

    it('keeps the name a projection gave a rewritten window expression', () => {
      const windowExpr = win('SUM', [], 'rn');
      const windowed = LogicalWindow([windowExpr], LogicalFilter(inequality(), scan('b')));
      const pushed = pushMaterialized(LogicalProject([{ ...windowExpr, outputName: 'rn' }], windowed));

      const project = findNode(pushed.plan, PlanNodeType.PROJECT);
      expect(project.expressions[0].outputName).toBe('rn');
      expect(project.expressions[0].partitionBy).toHaveLength(1);
    });

    it('gives every branch of a set operation its own copy of the correlating values', () => {
      const union = LogicalUnion(
        LogicalProject([colRef('b', 'val')], LogicalFilter(inequality(), scan('b'))),
        LogicalProject([colRef('c', 'val')], scan('c')),
        false,
      );

      const pushed = pushMaterialized(union);

      const setOp = findNode(pushed.plan, PlanNodeType.SET_OP);
      const domains = setOp.children.map((branch) => findNode(branch, PlanNodeType.DISTINCT));
      expect(domains.every(Boolean)).toBe(true);
      expect(domains[0].children[0].outputAlias).not.toBe(domains[1].children[0].outputAlias);
    });

    it('appends the domain column to a correlated set operation branch', () => {
      const union = LogicalUnion(
        LogicalProject([colRef('b', 'val')], LogicalFilter(inequality(), scan('b'))),
        LogicalProject([colRef('c', 'val')], scan('c')),
        false,
      );

      const branch = findNode(pushMaterialized(union).plan, PlanNodeType.SET_OP).children[0];

      expect(branch.expressions).toHaveLength(2);
      expect(branch.expressions[1].tableAlias).toMatch(/^__domain_/);
    });

    it('aligns the domains it pushed into both sides of a join', () => {
      const join = LogicalJoin(JoinType.INNER, null, LogicalFilter(inequality(), scan('b')), LogicalFilter(inequality(), scan('c')));
      const pushed = pushMaterialized(LogicalProject([colRef('b', 'val')], join));

      const inner = findNode(pushed.plan, PlanNodeType.JOIN, (node) => node.joinType === JoinType.INNER);
      expect(inner.condition.op).toBe('OR');
    });
  });

  describe('row limits', () => {
    it('turns a correlated limit into a row number gated by the count', () => {
      const limited = LogicalLimit(2, 0, LogicalProject([colRef('b', 'val')], LogicalFilter(inequality(), scan('b'))));
      const pushed = pushMaterialized(limited);

      expect(findNode(pushed.plan, PlanNodeType.LIMIT)).toBeNull();
      const window = findNode(pushed.plan, PlanNodeType.WINDOW);
      expect(window.windowExprs[0].name).toBe('ROW_NUMBER');
      expect(window.windowExprs[0].partitionBy[0].tableAlias).toMatch(/^__domain_/);
    });

    it('carries the ordering of the limited subquery into the row number', () => {
      const sorted = LogicalSort([{ expr: colRef('b', 'val'), direction: 'DESC' }], LogicalFilter(inequality(), scan('b')));
      const pushed = pushMaterialized(LogicalLimit(1, 0, LogicalProject([colRef('b', 'val')], sorted)));

      const window = findNode(pushed.plan, PlanNodeType.WINDOW);
      expect(window.windowExprs[0].orderBy).toEqual([
        expect.objectContaining({ direction: 'DESC', expr: expect.objectContaining({ columnName: 'val' }) }),
      ]);
    });

    it('refuses a row limit it cannot partition', () => {
      const limited = LogicalLimit(1, 0, LogicalProject([colRef('b', 'val')], LogicalFilter(inequality(), scan('b'))));
      expect(() => pushLifted(limited)).toThrow(/no correlation domain/);
    });
  });

  it('refuses an operator it has no rule for', () => {
    const materialize = { type: PlanNodeType.MATERIALIZE, children: [LogicalFilter(inequality(), scan('b'))] };
    const unsupported = { type: PlanNodeType.CTE_SCAN, cteName: 'x', cteId: 1, alias: 'x', children: [materialize] };
    expect(() => pushLifted(unsupported)).toThrow(/cannot carry a dependent join/);
  });
});
