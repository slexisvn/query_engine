import { describe, it, expect, beforeEach } from 'vitest';
import { FragmentPlan, Fragment, FragmentState, resetFragmentIdCounter } from '../../../src/distributed/planner/fragment.js';

describe('FragmentPlan', () => {
  beforeEach(() => {
    resetFragmentIdCounter();
  });

  function makeFragments() {
    const leaf1 = new Fragment({
      planRoot: { type: 'Scan', table: 'A' },
      targetNodes: ['w1'],
      exchangeInputs: [],
    });
    const leaf2 = new Fragment({
      planRoot: { type: 'Scan', table: 'B' },
      targetNodes: ['w2'],
      exchangeInputs: [],
    });
    const mid = new Fragment({
      planRoot: { type: 'Join' },
      targetNodes: ['w1'],
      exchangeInputs: [
        { sourceFragmentId: leaf1.fragmentId, exchangeType: 'gather' },
        { sourceFragmentId: leaf2.fragmentId, exchangeType: 'gather' },
      ],
    });
    const root = new Fragment({
      planRoot: { type: 'Project' },
      targetNodes: ['coord'],
      exchangeInputs: [
        { sourceFragmentId: mid.fragmentId, exchangeType: 'gather' },
      ],
    });

    return new FragmentPlan([leaf1, leaf2, mid, root], root.fragmentId);
  }

  it('topological order respects dependencies', () => {
    const plan = makeFragments();
    const order = plan.topologicalOrder();

    expect(order.length).toBe(4);

    const idxMap = new Map();
    order.forEach((f, i) => idxMap.set(f.fragmentId, i));

    for (const frag of order) {
      for (const input of frag.exchangeInputs) {
        expect(idxMap.get(input.sourceFragmentId)).toBeLessThan(idxMap.get(frag.fragmentId));
      }
    }
  });

  it('getLeafFragments returns fragments with no inputs', () => {
    const plan = makeFragments();
    const leaves = plan.getLeafFragments();
    expect(leaves.length).toBe(2);
    for (const l of leaves) {
      expect(l.exchangeInputs.length).toBe(0);
    }
  });

  it('getReadyFragments returns only pending fragments with satisfied deps', () => {
    const plan = makeFragments();
    const ready1 = plan.getReadyFragments();
    expect(ready1.length).toBe(2);

    ready1.forEach(f => f.markCompleted());

    const ready2 = plan.getReadyFragments();
    expect(ready2.length).toBe(1);
    expect(ready2[0].planRoot.type).toBe('Join');
  });

  it('allCompleted returns true when all fragments are done', () => {
    const plan = makeFragments();
    expect(plan.allCompleted()).toBe(false);

    for (const f of plan.fragments) {
      f.markCompleted();
    }
    expect(plan.allCompleted()).toBe(true);
  });

  it('hasFailed detects failed fragments', () => {
    const plan = makeFragments();
    expect(plan.hasFailed()).toBe(false);

    plan.fragments[0].markFailed(new Error('test'));
    expect(plan.hasFailed()).toBe(true);
  });

  it('getRootFragment returns the root', () => {
    const plan = makeFragments();
    const root = plan.getRootFragment();
    expect(root).not.toBeNull();
    expect(root.isRoot()).toBe(true);
  });
});

describe('Fragment', () => {
  beforeEach(() => {
    resetFragmentIdCounter();
  });

  it('auto-increments fragment IDs', () => {
    const f1 = new Fragment({ planRoot: {} });
    const f2 = new Fragment({ planRoot: {} });
    expect(f2.fragmentId).toBe(f1.fragmentId + 1);
  });

  it('tracks state transitions', () => {
    const f = new Fragment({ planRoot: {} });
    expect(f.state).toBe(FragmentState.PENDING);

    f.markDispatched('node-1');
    expect(f.state).toBe(FragmentState.DISPATCHED);
    expect(f.assignedNode).toBe('node-1');

    f.markRunning();
    expect(f.state).toBe(FragmentState.RUNNING);

    f.markCompleted();
    expect(f.state).toBe(FragmentState.COMPLETED);
  });

  it('tracks retries on failure', () => {
    const f = new Fragment({ planRoot: {} });
    f.markFailed(new Error('err1'));
    expect(f.retryCount).toBe(1);
    expect(f.canRetry(3)).toBe(true);

    f.markFailed(new Error('err2'));
    f.markFailed(new Error('err3'));
    expect(f.retryCount).toBe(3);
    expect(f.canRetry(3)).toBe(false);
  });

  it('isLeaf returns true when no exchange inputs', () => {
    const f = new Fragment({ planRoot: {}, exchangeInputs: [] });
    expect(f.isLeaf()).toBe(true);
  });

  it('isRoot returns true when no output partitioning', () => {
    const f = new Fragment({ planRoot: {}, outputPartitioning: null });
    expect(f.isRoot()).toBe(true);
  });

  it('serializes to JSON', () => {
    const f = new Fragment({
      planRoot: { type: 'Scan' },
      targetNodes: ['w1'],
      exchangeInputs: [{ sourceFragmentId: 1, exchangeType: 'gather' }],
    });
    const json = f.toJSON();
    expect(json.fragmentId).toBeDefined();
    expect(json.targetNodes).toEqual(['w1']);
  });
});
