import { describe, it, expect } from 'vitest';
import { DistributedSetOpPass } from '../../../src/distributed/optimizer/distributed-setop.js';
import { PlanNodeType, SetOpType, LogicalScan, LogicalProject, LogicalSetOp, LogicalUnion, LogicalJoin, JoinType } from '../../../src/planner/logical-plan.js';
import { ExchangeType } from '../../../src/distributed/planner/fragment.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';
import { DataType } from '../../../src/storage/data-type.js';

const partitioned = { getTableInfo: (table) => (table === 'T' || table === 'U' ? { partitionCount: 3 } : null) };

function projection(name, index) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: 'T', columnName: name, columnIndex: index, dataType: DataType.INT32, outputName: name };
}

function branch(table, names = ['A']) {
  return LogicalProject(names.map(projection), LogicalScan(table, names.map(name => ({ name }))));
}

function setOp(op, all, left = branch('T'), right = branch('T')) {
  const node = LogicalSetOp(op, left, right, all);
  node._distributed = true;
  return node;
}

describe('DistributedSetOpPass', () => {
  const pass = new DistributedSetOpPass(partitioned);

  it('leaves non-distributed plans alone', () => {
    const plan = LogicalUnion(branch('T'), branch('T'), false);

    expect(pass.apply(plan)).toBe(plan);
  });

  it('leaves set operations over unpartitioned tables alone', () => {
    const plan = setOp(SetOpType.UNION, false, branch('LOCAL'), branch('LOCAL'));

    expect(pass.apply(plan)).toBe(plan);
  });

  describe('UNION over identically partitioned inputs', () => {
    it('unions per partition then dedupes globally', () => {
      const result = pass.apply(setOp(SetOpType.UNION, false));

      expect(result.type).toBe(PlanNodeType.DISTINCT);
      expect(result.children[0].type).toBe(PlanNodeType.EXCHANGE);
      expect(result.children[0].exchangeType).toBe(ExchangeType.HASH_SHUFFLE);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.SET_OP);
    });

    it('shuffles on every output column of the left input', () => {
      const plan = setOp(SetOpType.UNION, false, branch('T', ['A', 'B']), branch('T', ['A', 'B']));

      const keys = pass.apply(plan).children[0].partitionKeys;
      expect(keys.map(k => k.columnName)).toEqual(['A', 'B']);
      expect(keys.map(k => k.columnIndex)).toEqual([0, 1]);
    });

    it('leaves UNION ALL untouched because concatenation is partition-safe', () => {
      const plan = setOp(SetOpType.UNION, true);

      expect(pass.apply(plan)).toBe(plan);
    });

    it('carries the cardinality estimate onto the rewritten nodes', () => {
      const plan = setOp(SetOpType.UNION, false);
      plan._cardinality = 400;

      const result = pass.apply(plan);
      expect(result._cardinality).toBe(400);
      expect(result.children[0]._cardinality).toBe(400);
    });
  });

  describe('set operations that must see complete inputs', () => {
    for (const [op, all] of [[SetOpType.INTERSECT, false], [SetOpType.INTERSECT, true], [SetOpType.EXCEPT, false], [SetOpType.EXCEPT, true]]) {
      it(`gathers both inputs for ${op}${all ? ' ALL' : ''}`, () => {
        const result = pass.apply(setOp(op, all));

        expect(result.type).toBe(PlanNodeType.SET_OP);
        for (const child of result.children) {
          expect(child.type).toBe(PlanNodeType.EXCHANGE);
          expect(child.children[0].type).toBe(PlanNodeType.PROJECT);
        }
      });
    }
  });

  describe('inputs that cannot be evaluated partition-locally', () => {
    it('gathers a UNION whose input spans a join', () => {
      const joined = LogicalProject([projection('A', 0)], LogicalJoin(JoinType.INNER, null, LogicalScan('T', [{ name: 'A' }]), LogicalScan('U', [{ name: 'A' }])));

      const result = pass.apply(setOp(SetOpType.UNION, false, joined, branch('T')));
      expect(result.type).toBe(PlanNodeType.SET_OP);
      expect(result.children.map(c => c.type)).toEqual([PlanNodeType.EXCHANGE, PlanNodeType.EXCHANGE]);
    });

    it('gathers a UNION whose inputs are partitioned on different tables', () => {
      const result = pass.apply(setOp(SetOpType.UNION, false, branch('T'), branch('U')));

      expect(result.type).toBe(PlanNodeType.SET_OP);
      expect(result.children.map(c => c.type)).toEqual([PlanNodeType.EXCHANGE, PlanNodeType.EXCHANGE]);
    });

    it('gathers an outer UNION once its input already carries an exchange', () => {
      const inner = setOp(SetOpType.UNION, false);
      const outer = LogicalUnion(inner, branch('T'), false);
      outer._distributed = true;

      const result = pass.apply(outer);
      expect(result.type).toBe(PlanNodeType.SET_OP);
      expect(result.children.map(c => c.type)).toEqual([PlanNodeType.EXCHANGE, PlanNodeType.EXCHANGE]);
      expect(result.children[0].children[0].type).toBe(PlanNodeType.DISTINCT);
    });

    it('gathers only the partitioned side when the other is local', () => {
      const result = pass.apply(setOp(SetOpType.INTERSECT, false, branch('T'), branch('LOCAL')));

      expect(result.children[0].type).toBe(PlanNodeType.EXCHANGE);
      expect(result.children[1].type).toBe(PlanNodeType.PROJECT);
    });
  });
});
