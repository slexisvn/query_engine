import { describePhysicalNode } from './physical-plan.js';
import type { DataChunk } from '../storage/chunk.js';
import type { PhysicalPlanNode } from './physical-plan.js';
import type { CompiledPipeline, Sink } from './execution-types.js';

const Q_ERROR_DECIMALS = 1;

export interface OperatorProfile {
  node: PhysicalPlanNode;
  estimatedRows: number;
  actualRows: number;
  chunks: number;
  invocations: number;
  firstOutputMs: number | null;
  lastOutputMs: number | null;
}

export interface ProfileTreeNode {
  profile: OperatorProfile;
  children: ProfileTreeNode[];
}

export interface ExecutionProfile {
  totalMs: number;
  roots: ProfileTreeNode[];
}

export type EstimateBias = 'under' | 'over' | 'exact';

export function biasOf(profile: OperatorProfile): EstimateBias {
  if (profile.actualRows === profile.estimatedRows) return 'exact';
  return profile.actualRows > profile.estimatedRows ? 'under' : 'over';
}

export function qErrorOf(profile: OperatorProfile): number {
  const estimated = Math.max(1, profile.estimatedRows);
  const actual = Math.max(1, profile.actualRows);
  return actual >= estimated ? actual / estimated : estimated / actual;
}

export function estimateLabel(profile: OperatorProfile): string {
  const bias = biasOf(profile);
  if (bias === 'exact') return 'on target';
  return `${qErrorOf(profile).toFixed(Q_ERROR_DECIMALS)}x ${bias}`;
}

export function flattenProfile(roots: readonly ProfileTreeNode[], into: OperatorProfile[] = []): OperatorProfile[] {
  for (const root of roots) {
    into.push(root.profile);
    flattenProfile(root.children, into);
  }
  return into;
}

function countingSink(inner: Sink, record: (rows: number) => void): Sink {
  const { init, finalize, error } = inner;

  const wrapper: Sink = {
    get cancelToken() { return inner.cancelToken; },
    async consume(chunk: DataChunk): Promise<void> {
      if (chunk && chunk.size > 0) record(chunk.size);
      await inner.consume(chunk);
    },
  };

  if (init) wrapper.init = () => init.call(inner);
  if (finalize) wrapper.finalize = () => finalize.call(inner);
  if (error) wrapper.error = (caught: Error) => error.call(inner, caught);
  return wrapper;
}

export class ExecutionProfiler {
  private readonly profiles = new Map<PhysicalPlanNode, OperatorProfile>();
  private readonly startedAt = performance.now();
  private root: PhysicalPlanNode | null = null;

  setRoot(node: PhysicalPlanNode): void {
    if (this.root === null) this.root = node;
  }

  instrument(node: PhysicalPlanNode, compiled: CompiledPipeline): CompiledPipeline {
    const profile = this.profileOf(node);
    return {
      schema: compiled.schema,
      columnMapping: compiled.columnMapping,
      register: (graph, pipelineId, sink) => {
        profile.invocations++;
        compiled.register(graph, pipelineId, countingSink(sink, rows => this.record(profile, rows)));
      },
    };
  }

  snapshot(): ExecutionProfile {
    return { totalMs: performance.now() - this.startedAt, roots: this.forest() };
  }

  private profileOf(node: PhysicalPlanNode): OperatorProfile {
    const existing = this.profiles.get(node);
    if (existing) return existing;

    const created: OperatorProfile = {
      node,
      estimatedRows: node.cardinality,
      actualRows: 0,
      chunks: 0,
      invocations: 0,
      firstOutputMs: null,
      lastOutputMs: null,
    };
    this.profiles.set(node, created);
    return created;
  }

  private record(profile: OperatorProfile, rows: number): void {
    const at = performance.now() - this.startedAt;
    profile.actualRows += rows;
    profile.chunks++;
    if (profile.firstOutputMs === null) profile.firstOutputMs = at;
    profile.lastOutputMs = at;
  }

  private forest(): ProfileTreeNode[] {
    const claimed = new Set<PhysicalPlanNode>();
    for (const node of this.profiles.keys()) {
      for (const child of node.children) {
        if (this.profiles.has(child)) claimed.add(child);
      }
    }

    const roots: ProfileTreeNode[] = [];
    if (this.root !== null && this.profiles.has(this.root)) roots.push(this.treeOf(this.root));
    for (const node of this.profiles.keys()) {
      if (node !== this.root && !claimed.has(node)) roots.push(this.treeOf(node));
    }
    return roots;
  }

  private treeOf(node: PhysicalPlanNode): ProfileTreeNode {
    return {
      profile: this.profileOf(node),
      children: node.children.filter(child => this.profiles.has(child)).map(child => this.treeOf(child)),
    };
  }
}

export function profileToString(profile: ExecutionProfile): string {
  const render = (tree: ProfileTreeNode, indent: number): string => {
    const { profile: entry } = tree;
    const measures = `est=${entry.estimatedRows} actual=${entry.actualRows} (${estimateLabel(entry)})`;
    let text = `${'  '.repeat(indent)}${describePhysicalNode(entry.node)} ${measures}\n`;
    for (const child of tree.children) text += render(child, indent + 1);
    return text;
  };

  return profile.roots.map(root => render(root, 0)).join('');
}
