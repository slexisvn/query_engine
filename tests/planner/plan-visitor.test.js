import { PlanVisitor, PlanRewriter } from '../../src/planner/plan-visitor.js';
import {
  LogicalScan, LogicalFilter, LogicalProject, LogicalJoin, LogicalLimit,
  LogicalSort, LogicalAggregate, LogicalDistinct, LogicalUnion,
  JoinType, PlanNodeType, setChildren,
} from '../../src/planner/logical-plan.js';

function lit(v) {
  return { kind: 'BoundLiteral', value: v };
}

function deepTree() {
  const scanA = LogicalScan('A', []);
  const scanB = LogicalScan('B', []);
  const join = LogicalJoin(JoinType.INNER, lit('cond'), scanA, scanB);
  const filter = LogicalFilter(lit('where'), join);
  const agg = LogicalAggregate([lit('g')], [{ name: 'COUNT' }], filter);
  const proj = LogicalProject([lit('col')], agg);
  const sort = LogicalSort([{ expr: lit('x'), direction: 'ASC' }], proj);
  const limit = LogicalLimit(10, 0, sort);
  return limit;
}

describe('PlanVisitor', () => {
  it('visits all 8 nodes in a deep tree in pre-order (DFS)', () => {
    const types = [];
    class Collector extends PlanVisitor {
      visitDefault(node) {
        types.push(node.type);
        this.visitChildren(node);
      }
    }

    new Collector().visit(deepTree());
    expect(types).toEqual([
      PlanNodeType.LIMIT,
      PlanNodeType.SORT,
      PlanNodeType.PROJECT,
      PlanNodeType.AGGREGATE,
      PlanNodeType.FILTER,
      PlanNodeType.JOIN,
      PlanNodeType.SCAN,
      PlanNodeType.SCAN,
    ]);
  });

  it('dispatches to named visit method, skips visitDefault for that type', () => {
    const defaultVisited = [];
    const scans = [];

    class Mixed extends PlanVisitor {
      visitScan(node) {
        scans.push(node.table);
      }
      visitDefault(node) {
        defaultVisited.push(node.type);
        this.visitChildren(node);
      }
    }

    new Mixed().visit(deepTree());
    expect(scans).toEqual(['A', 'B']);
    expect(defaultVisited).not.toContain(PlanNodeType.SCAN);
    expect(defaultVisited).toContain(PlanNodeType.LIMIT);
    expect(defaultVisited).toContain(PlanNodeType.JOIN);
  });

  it('stops traversal below a node when visitChildren is not called', () => {
    const visited = [];
    class StopAtAggregate extends PlanVisitor {
      visitAggregate(_node) {
        visited.push('AGG_STOPPED');
      }
      visitDefault(node) {
        visited.push(node.type);
        this.visitChildren(node);
      }
    }

    new StopAtAggregate().visit(deepTree());
    expect(visited).toContain('AGG_STOPPED');
    expect(visited).not.toContain(PlanNodeType.FILTER);
    expect(visited).not.toContain(PlanNodeType.JOIN);
    expect(visited).not.toContain(PlanNodeType.SCAN);
  });

  it('accumulates state: count scans and total nodes', () => {
    class Counter extends PlanVisitor {
      constructor() { super(); this.scanCount = 0; this.totalNodes = 0; }
      visitScan(node) { this.scanCount++; this.totalNodes++; }
      visitDefault(node) { this.totalNodes++; this.visitChildren(node); }
    }

    const counter = new Counter();
    counter.visit(deepTree());
    expect(counter.scanCount).toBe(2);
    expect(counter.totalNodes).toBe(8);
  });

  it('collects all table names from a multi-join tree', () => {
    const tree = LogicalProject([],
      LogicalJoin(JoinType.INNER, null,
        LogicalJoin(JoinType.LEFT, null, LogicalScan('USERS', []), LogicalScan('ORDERS', [])),
        LogicalScan('PRODUCTS', [])));

    const tables = [];
    class TableCollector extends PlanVisitor {
      visitScan(node) { tables.push(node.table); }
      visitDefault(node) { this.visitChildren(node); }
    }

    new TableCollector().visit(tree);
    expect(tables.sort()).toEqual(['ORDERS', 'PRODUCTS', 'USERS']);
  });

  it('visits Union children (both branches)', () => {
    const union = LogicalUnion(
      LogicalProject([], LogicalScan('A', [])),
      LogicalProject([], LogicalScan('B', [])),
      false,
    );
    const tables = [];
    class TC extends PlanVisitor {
      visitScan(node) { tables.push(node.table); }
      visitDefault(node) { this.visitChildren(node); }
    }
    new TC().visit(union);
    expect(tables.sort()).toEqual(['A', 'B']);
  });
});

describe('PlanRewriter', () => {
  it('returns exact same reference when nothing changes', () => {
    const tree = deepTree();
    const result = new PlanRewriter().rewrite(tree);
    expect(result).toBe(tree);
  });

  it('leaf node (Scan) returns same reference from default rewriter', () => {
    const scan = LogicalScan('T', []);
    expect(new PlanRewriter().rewrite(scan)).toBe(scan);
  });

  it('rewriting one leaf causes all ancestors to be new objects', () => {
    class RenameScanA extends PlanRewriter {
      rewriteScan(node) {
        return node.table === 'A' ? { ...node, table: 'X' } : node;
      }
    }

    const tree = deepTree();
    const result = new RenameScanA().rewrite(tree);

    expect(result).not.toBe(tree);
    expect(result.type).toBe(PlanNodeType.LIMIT);

    const scanA = result.children[0].children[0].children[0].children[0].children[0].children[0];
    const scanB = result.children[0].children[0].children[0].children[0].children[0].children[1];
    expect(scanA.table).toBe('X');
    expect(scanB.table).toBe('B');
    expect(scanB).toBe(tree.children[0].children[0].children[0].children[0].children[0].children[1]);
  });

  it('unchanged sibling preserves reference equality', () => {
    class RenameScanA extends PlanRewriter {
      rewriteScan(node) {
        return node.table === 'A' ? { ...node, table: 'X' } : node;
      }
    }

    const tree = deepTree();
    const origScanB = tree.children[0].children[0].children[0].children[0].children[0].children[1];
    const result = new RenameScanA().rewrite(tree);
    const newScanB = result.children[0].children[0].children[0].children[0].children[0].children[1];
    expect(newScanB).toBe(origScanB);
  });

  it('removes all Filter nodes from tree', () => {
    class FilterRemover extends PlanRewriter {
      rewriteFilter(node) {
        return this.rewrite(node.children[0]);
      }
    }

    const tree = deepTree();
    const result = new FilterRemover().rewrite(tree);
    const allNodes = [];
    const stack = [result];
    while (stack.length) {
      const n = stack.pop();
      allNodes.push(n);
      if (n.children) stack.push(...n.children);
    }
    expect(allNodes.every(n => n.type !== PlanNodeType.FILTER)).toBe(true);
    expect(allNodes.some(n => n.type === PlanNodeType.JOIN)).toBe(true);
  });

  it('doubles limit count via named rewrite method', () => {
    class DoubleLimit extends PlanRewriter {
      rewriteLimit(node) {
        const rewritten = this.rewriteChildren(node);
        return { ...rewritten, count: rewritten.count * 2 };
      }
    }

    const tree = deepTree();
    const result = new DoubleLimit().rewrite(tree);
    expect(result.count).toBe(20);
    expect(result.type).toBe(PlanNodeType.LIMIT);
  });

  it('replaces Scan with Filter → Scan (injection)', () => {
    class AddFilterToScan extends PlanRewriter {
      rewriteScan(node) {
        if (node.table === 'A') {
          return LogicalFilter(lit('injected'), node);
        }
        return node;
      }
    }

    const tree = deepTree();
    const result = new AddFilterToScan().rewrite(tree);

    const allNodes = [];
    const stack = [result];
    while (stack.length) {
      const n = stack.pop();
      allNodes.push(n);
      if (n.children) stack.push(...n.children);
    }
    const filters = allNodes.filter(n => n.type === PlanNodeType.FILTER);
    expect(filters).toHaveLength(2);
    const injected = filters.find(f => f.condition.value === 'injected');
    expect(injected).toBeDefined();
    expect(injected.children[0].table).toBe('A');
  });

  it('rewrites Union children independently', () => {
    const union = LogicalUnion(
      LogicalProject([], LogicalScan('A', [])),
      LogicalProject([], LogicalScan('B', [])),
      true,
    );

    class RenameScanA extends PlanRewriter {
      rewriteScan(node) {
        return node.table === 'A' ? { ...node, table: 'X' } : node;
      }
    }

    const result = new RenameScanA().rewrite(union);
    expect(result.children[0].children[0].table).toBe('X');
    expect(result.children[1].children[0].table).toBe('B');
    expect(result.children[1]).toBe(union.children[1]);
  });

  it('conditional rewrite: only modify joins with CROSS type', () => {
    const tree = LogicalProject([],
      LogicalJoin(JoinType.INNER, lit('c1'),
        LogicalScan('A', []),
        LogicalJoin(JoinType.CROSS, null, LogicalScan('B', []), LogicalScan('C', []))));

    class RemoveCrossJoin extends PlanRewriter {
      rewriteJoin(node) {
        const rewritten = this.rewriteChildren(node);
        if (rewritten.joinType === JoinType.CROSS) {
          return rewritten.children[0];
        }
        return rewritten;
      }
    }

    const result = new RemoveCrossJoin().rewrite(tree);
    const innerJoin = result.children[0];
    expect(innerJoin.type).toBe(PlanNodeType.JOIN);
    expect(innerJoin.joinType).toBe(JoinType.INNER);
    expect(innerJoin.children[1].type).toBe(PlanNodeType.SCAN);
    expect(innerJoin.children[1].table).toBe('B');
  });
});
