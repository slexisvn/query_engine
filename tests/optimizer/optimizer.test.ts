import { describe, it, expect } from 'vitest';
import { Optimizer } from '../../src/optimizer/optimizer.js';
import { OptimizationPass } from '../../src/optimizer/pass.js';
import { LogicalScan, LogicalFilter, PlanNodeType } from '../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';

function scan(table = 'ORDERS') {
  return LogicalScan(table, [{ name: 'ID', dataType: 'INT32' }], table);
}

function predicate(value) {
  return {
    kind: BoundExprKind.BINARY,
    op: '>',
    left: { kind: BoundExprKind.COLUMN_REF, tableAlias: 'ORDERS', columnName: 'ID' },
    right: { kind: BoundExprKind.LITERAL, value },
  };
}

class RecordingPass extends OptimizationPass {
  constructor(passName, transform = plan => plan) {
    super();
    this.passName = passName;
    this.transform = transform;
    this.applyCount = 0;
  }

  get name() { return this.passName; }

  apply(plan) {
    this.applyCount++;
    return this.transform(plan);
  }
}

class WrapUntilPass extends OptimizationPass {
  constructor(passName, wrapCount) {
    super();
    this.passName = passName;
    this.remaining = wrapCount;
    this.applyCount = 0;
  }

  get name() { return this.passName; }

  apply(plan) {
    this.applyCount++;
    if (this.remaining <= 0) return plan;
    this.remaining--;
    return LogicalFilter(predicate(this.remaining), plan);
  }
}

function filterDepth(plan) {
  let depth = 0;
  let node = plan;
  while (node && node.type === PlanNodeType.FILTER) {
    depth++;
    node = node.children[0];
  }
  return depth;
}

describe('Optimizer registration', () => {
  it('runs a registered pass', () => {
    const pass = new RecordingPass('A');
    new Optimizer().registerPass(pass).optimize(scan());

    expect(pass.applyCount).toBe(1);
  });

  it('runs registered passes in registration order', () => {
    const order = [];
    const optimizer = new Optimizer()
      .registerPass(new RecordingPass('A', plan => { order.push('A'); return plan; }))
      .registerPass(new RecordingPass('B', plan => { order.push('B'); return plan; }));

    optimizer.optimize(scan());

    expect(order).toEqual(['A', 'B']);
  });

  it('threads each pass output into the next pass', () => {
    const optimizer = new Optimizer()
      .registerPass(new RecordingPass('Wrap', plan => LogicalFilter(predicate(1), plan)))
      .registerPass(new RecordingPass('WrapAgain', plan => LogicalFilter(predicate(2), plan)));

    expect(filterDepth(optimizer.optimize(scan()))).toBe(2);
  });

  it('returns the input plan untouched when nothing is registered', () => {
    const plan = scan();
    expect(new Optimizer().optimize(plan)).toBe(plan);
  });

  it('lists registered pass names', () => {
    const optimizer = new Optimizer()
      .registerPass(new RecordingPass('A'))
      .registerPass(new RecordingPass('B'));

    expect(optimizer.listPasses()).toEqual(['A', 'B']);
  });
});

describe('Optimizer stage editing', () => {
  it('inserts a pass before a named pass', () => {
    const optimizer = new Optimizer()
      .registerPass(new RecordingPass('A'))
      .registerPass(new RecordingPass('C'));

    optimizer.insertPassBefore('C', new RecordingPass('B'));

    expect(optimizer.listPasses()).toEqual(['A', 'B', 'C']);
  });

  it('inserts a pass after a named pass', () => {
    const optimizer = new Optimizer()
      .registerPass(new RecordingPass('A'))
      .registerPass(new RecordingPass('C'));

    optimizer.insertPassAfter('A', new RecordingPass('B'));

    expect(optimizer.listPasses()).toEqual(['A', 'B', 'C']);
  });

  it('appends when inserting before an unknown pass', () => {
    const optimizer = new Optimizer().registerPass(new RecordingPass('A'));

    optimizer.insertPassBefore('Missing', new RecordingPass('Z'));

    expect(optimizer.listPasses()).toEqual(['A', 'Z']);
  });

  it('appends when inserting after an unknown pass', () => {
    const optimizer = new Optimizer().registerPass(new RecordingPass('A'));

    optimizer.insertPassAfter('Missing', new RecordingPass('Z'));

    expect(optimizer.listPasses()).toEqual(['A', 'Z']);
  });

  it('inserts relative to a pass that lives inside a fixpoint stage', () => {
    const optimizer = new Optimizer()
      .registerFixpoint('Group', [new RecordingPass('A'), new RecordingPass('B')])
      .registerPass(new RecordingPass('C'));

    optimizer.insertPassAfter('B', new RecordingPass('X'));

    expect(optimizer.listPasses()).toEqual(['A', 'B', 'X', 'C']);
  });

  it('removes a named pass', () => {
    const optimizer = new Optimizer()
      .registerPass(new RecordingPass('A'))
      .registerPass(new RecordingPass('B'));

    optimizer.removePass('A');

    expect(optimizer.listPasses()).toEqual(['B']);
  });

  it('removes a pass from inside a fixpoint stage and keeps the stage', () => {
    const optimizer = new Optimizer().registerFixpoint('Group', [new RecordingPass('A'), new RecordingPass('B')]);

    optimizer.removePass('A');

    expect(optimizer.listPasses()).toEqual(['B']);
    expect(optimizer.listStages()).toEqual(['Group']);
  });

  it('drops a stage that loses its last pass', () => {
    const optimizer = new Optimizer().registerFixpoint('Group', [new RecordingPass('A')]);

    optimizer.removePass('A');

    expect(optimizer.listStages()).toEqual([]);
  });

  it('names single-pass stages after the pass', () => {
    const optimizer = new Optimizer().registerPass(new RecordingPass('A'));
    expect(optimizer.listStages()).toEqual(['A']);
  });
});

describe('Optimizer fixpoint stages', () => {
  it('applies a plan-preserving pass exactly once', () => {
    const stable = new RecordingPass('Stable');
    new Optimizer().registerFixpoint('Group', [stable]).optimize(scan());

    expect(stable.applyCount).toBe(1);
  });

  it('stops iterating as soon as the plan stops changing', () => {
    const wrapping = new WrapUntilPass('Wrap', 2);
    new Optimizer().registerFixpoint('Group', [wrapping], 10).optimize(scan());

    expect(wrapping.applyCount).toBe(3);
  });

  it('repeats while the plan keeps changing', () => {
    const wrapping = new WrapUntilPass('Wrap', 3);
    const result = new Optimizer().registerFixpoint('Group', [wrapping]).optimize(scan());

    expect(filterDepth(result)).toBe(3);
  });

  it('reaches a deeper result than a single pass application would', () => {
    const single = new Optimizer().registerPass(new WrapUntilPass('Wrap', 3)).optimize(scan());
    const looped = new Optimizer().registerFixpoint('Group', [new WrapUntilPass('Wrap', 3)]).optimize(scan());

    expect(filterDepth(looped)).toBeGreaterThan(filterDepth(single));
  });

  it('honours the iteration ceiling on a pass that never converges', () => {
    const endless = new WrapUntilPass('Endless', Number.MAX_SAFE_INTEGER);

    new Optimizer().registerFixpoint('Group', [endless], 4).optimize(scan());

    expect(endless.applyCount).toBe(4);
  });

  it('applies every pass of the stage on each iteration', () => {
    const wrapping = new WrapUntilPass('Wrap', 2);
    const observer = new RecordingPass('Observer');

    new Optimizer().registerFixpoint('Group', [wrapping, observer]).optimize(scan());

    expect(observer.applyCount).toBe(wrapping.applyCount);
  });

  it('treats a single-iteration fixpoint as a plain stage', () => {
    const wrapping = new WrapUntilPass('Wrap', 5);

    new Optimizer().registerFixpoint('Group', [wrapping], 1).optimize(scan());

    expect(wrapping.applyCount).toBe(1);
  });

  it('keeps the fixpoint result when a later stage follows', () => {
    const result = new Optimizer()
      .registerFixpoint('Group', [new WrapUntilPass('Wrap', 2)])
      .registerPass(new RecordingPass('After', plan => LogicalFilter(predicate(99), plan)))
      .optimize(scan());

    expect(filterDepth(result)).toBe(3);
  });
});
