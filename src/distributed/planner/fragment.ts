import type {
  LogicalPlanNode,
} from '../../planner/logical-plan.js';
import { ExchangeType, FragmentState } from '../distributed-types.js';
import type {
  NodeId,
  ChannelId,
  FragmentId,
  ExchangeInput,
  OutputPartitioning,
  FragmentDispatchJSON,
} from '../distributed-types.js';

export { ExchangeType, FragmentState };

export function fragmentOutputChannel(fragmentId: FragmentId): ChannelId {
  return `frag-${fragmentId}-output`;
}

let _nextFragmentId = 1;

export function resetFragmentIdCounter(): void {
  _nextFragmentId = 1;
}

export interface FragmentInit {
  planRoot: LogicalPlanNode;
  targetNodes?: NodeId[];
  exchangeInputs?: ExchangeInput[];
  outputPartitioning?: OutputPartitioning | null;
  estimatedCardinality?: number;
}

export class Fragment {
  fragmentId: FragmentId;
  planRoot: LogicalPlanNode;
  targetNodes: NodeId[];
  exchangeInputs: ExchangeInput[];
  outputPartitioning: OutputPartitioning | null;
  estimatedCardinality: number;
  state: FragmentState;
  retryCount: number;
  error: string | null;
  assignedNode: NodeId | null;

  constructor({ planRoot, targetNodes, exchangeInputs, outputPartitioning, estimatedCardinality }: FragmentInit) {
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

  isLeaf(): boolean {
    return this.exchangeInputs.length === 0;
  }

  isRoot(): boolean {
    return this.outputPartitioning === null;
  }

  markDispatched(nodeId: NodeId): void {
    this.state = FragmentState.DISPATCHED;
    this.assignedNode = nodeId;
  }

  markRunning(): void {
    this.state = FragmentState.RUNNING;
  }

  markCompleted(): void {
    this.state = FragmentState.COMPLETED;
  }

  markFailed(error: string | null): void {
    this.state = FragmentState.FAILED;
    this.error = error;
    this.retryCount++;
  }

  markCancelled(): void {
    this.state = FragmentState.CANCELLED;
  }

  canRetry(maxRetries: number): boolean {
    return this.retryCount < maxRetries;
  }

  toJSON(): FragmentDispatchJSON {
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
  fragments: Fragment[];
  rootFragmentId: FragmentId;
  _fragmentMap: Map<FragmentId, Fragment>;

  constructor(fragments: Fragment[], rootFragmentId: FragmentId) {
    this.fragments = fragments;
    this.rootFragmentId = rootFragmentId;
    this._fragmentMap = new Map();
    for (const f of fragments) {
      this._fragmentMap.set(f.fragmentId, f);
    }
  }

  getFragment(fragmentId: FragmentId): Fragment | null {
    return this._fragmentMap.get(fragmentId) || null;
  }

  getRootFragment(): Fragment | null {
    return this._fragmentMap.get(this.rootFragmentId) || null;
  }

  getLeafFragments(): Fragment[] {
    return this.fragments.filter(f => f.isLeaf());
  }

  topologicalOrder(): Fragment[] {
    const inDegree = new Map<FragmentId, number>();
    const adjacency = new Map<FragmentId, FragmentId[]>();

    for (const f of this.fragments) {
      inDegree.set(f.fragmentId, 0);
      adjacency.set(f.fragmentId, []);
    }

    for (const f of this.fragments) {
      for (const input of f.exchangeInputs) {
        adjacency.get(input.sourceFragmentId)!.push(f.fragmentId);
        inDegree.set(f.fragmentId, inDegree.get(f.fragmentId)! + 1);
      }
    }

    const queue: FragmentId[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const order: FragmentId[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);
      for (const next of adjacency.get(current)!) {
        const newDeg = inDegree.get(next)! - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }
    }

    return order.map(id => this._fragmentMap.get(id)!);
  }

  getReadyFragments(): Fragment[] {
    return this.fragments.filter(f => {
      if (f.state !== FragmentState.PENDING) return false;
      return f.exchangeInputs.every(input => {
        const source = this._fragmentMap.get(input.sourceFragmentId);
        return source && source.state === FragmentState.COMPLETED;
      });
    });
  }

  allCompleted(): boolean {
    return this.fragments.every(f => f.state === FragmentState.COMPLETED);
  }

  hasFailed(): boolean {
    return this.fragments.some(f => f.state === FragmentState.FAILED);
  }
}
