export const ExchangeType = {
  HASH_SHUFFLE: 'hash_shuffle',
  BROADCAST: 'broadcast',
  GATHER: 'gather',
  PASSTHROUGH: 'passthrough',
};

export const FragmentState = {
  PENDING: 'pending',
  DISPATCHED: 'dispatched',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

let _nextFragmentId = 1;

export function resetFragmentIdCounter() {
  _nextFragmentId = 1;
}

export class Fragment {
  constructor({ planRoot, targetNodes, exchangeInputs, outputPartitioning, estimatedCardinality }) {
    this.fragmentId = _nextFragmentId++;
    this.planRoot = planRoot;
    this.targetNodes = targetNodes || [];
    this.exchangeInputs = exchangeInputs || [];
    this.outputPartitioning = outputPartitioning || null;
    this.estimatedCardinality = estimatedCardinality || 0;
    this.state = FragmentState.PENDING;
    this.retryCount = 0;
    this.error = null;
    this.assignedNode = null;
  }

  isLeaf() {
    return this.exchangeInputs.length === 0;
  }

  isRoot() {
    return this.outputPartitioning === null;
  }

  markDispatched(nodeId) {
    this.state = FragmentState.DISPATCHED;
    this.assignedNode = nodeId;
  }

  markRunning() {
    this.state = FragmentState.RUNNING;
  }

  markCompleted() {
    this.state = FragmentState.COMPLETED;
  }

  markFailed(error) {
    this.state = FragmentState.FAILED;
    this.error = error;
    this.retryCount++;
  }

  markCancelled() {
    this.state = FragmentState.CANCELLED;
  }

  canRetry(maxRetries) {
    return this.retryCount < maxRetries;
  }

  toJSON() {
    return {
      fragmentId: this.fragmentId,
      planRoot: this.planRoot,
      targetNodes: this.targetNodes,
      exchangeInputs: this.exchangeInputs,
      outputPartitioning: this.outputPartitioning,
      estimatedCardinality: this.estimatedCardinality,
      state: this.state,
    };
  }
}

export class FragmentPlan {
  constructor(fragments, rootFragmentId) {
    this.fragments = fragments;
    this.rootFragmentId = rootFragmentId;
    this._fragmentMap = new Map();
    for (const f of fragments) {
      this._fragmentMap.set(f.fragmentId, f);
    }
  }

  getFragment(fragmentId) {
    return this._fragmentMap.get(fragmentId) || null;
  }

  getRootFragment() {
    return this._fragmentMap.get(this.rootFragmentId) || null;
  }

  getLeafFragments() {
    return this.fragments.filter(f => f.isLeaf());
  }

  topologicalOrder() {
    const inDegree = new Map();
    const adjacency = new Map();

    for (const f of this.fragments) {
      inDegree.set(f.fragmentId, 0);
      adjacency.set(f.fragmentId, []);
    }

    for (const f of this.fragments) {
      for (const input of f.exchangeInputs) {
        adjacency.get(input.sourceFragmentId).push(f.fragmentId);
        inDegree.set(f.fragmentId, inDegree.get(f.fragmentId) + 1);
      }
    }

    const queue = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const order = [];
    while (queue.length > 0) {
      const current = queue.shift();
      order.push(current);
      for (const next of adjacency.get(current)) {
        const newDeg = inDegree.get(next) - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }
    }

    return order.map(id => this._fragmentMap.get(id));
  }

  getReadyFragments() {
    return this.fragments.filter(f => {
      if (f.state !== FragmentState.PENDING) return false;
      return f.exchangeInputs.every(input => {
        const source = this._fragmentMap.get(input.sourceFragmentId);
        return source && source.state === FragmentState.COMPLETED;
      });
    });
  }

  allCompleted() {
    return this.fragments.every(f => f.state === FragmentState.COMPLETED);
  }

  hasFailed() {
    return this.fragments.some(f => f.state === FragmentState.FAILED);
  }
}
