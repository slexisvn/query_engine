import { formatNode } from '@engine/planner/plan-formatter.js';
import { describePhysicalNode, totalPhysicalCost } from '@engine/execution/physical-plan.js';
import { biasOf, qErrorOf } from '@engine/execution/execution-profile.js';
import { operatorChoice } from './candidates.js';
import { costBreakdown } from './cost-breakdown.js';
import type { PhysicalPlanner } from '@engine/execution/physical-planner.js';
import type { PhysicalPlanNode } from '@engine/execution/physical-plan.js';
import type { EstimateBias, ExecutionProfile, OperatorProfile, ProfileTreeNode } from '@engine/execution/execution-profile.js';
import type { OperatorChoice } from './candidates.js';
import type { CostBreakdown } from './cost-breakdown.js';

export const ROOT_PATH = 'p';

export const WARN_Q_ERROR = 2;
export const BAD_Q_ERROR = 10;

export type EstimateTone = 'idle' | 'good' | 'warn' | 'bad';

export interface MeasuredRows {
  ran: boolean;
  actualRows: number;
  chunks: number;
  invocations: number;
  outputMs: number | null;
  bias: EstimateBias;
  qError: number;
  tone: EstimateTone;
}

export interface OperatorRow {
  path: string;
  depth: number;
  title: string;
  detail: string;
  node: PhysicalPlanNode;
  estimatedRows: number;
  cost: number;
  subtreeCost: number;
  measured: MeasuredRows | null;
  choice: OperatorChoice | null;
  breakdown: CostBreakdown | null;
}

export function toneOf(qError: number): EstimateTone {
  if (qError < WARN_Q_ERROR) return 'good';
  return qError < BAD_Q_ERROR ? 'warn' : 'bad';
}

function measuredOf(profile: OperatorProfile): MeasuredRows {
  const ran = profile.invocations > 0;
  const qError = qErrorOf(profile);
  return {
    ran,
    actualRows: profile.actualRows,
    chunks: profile.chunks,
    invocations: profile.invocations,
    outputMs: profile.firstOutputMs === null || profile.lastOutputMs === null
      ? null
      : profile.lastOutputMs - profile.firstOutputMs,
    bias: biasOf(profile),
    qError,
    tone: ran ? toneOf(qError) : 'idle',
  };
}

function rowOf(
  node: PhysicalPlanNode,
  profile: OperatorProfile | null,
  path: string,
  depth: number,
  planner: PhysicalPlanner,
): OperatorRow {
  return {
    path,
    depth,
    title: describePhysicalNode(node),
    detail: formatNode(node.logical),
    node,
    estimatedRows: node.cardinality,
    cost: node.cost,
    subtreeCost: totalPhysicalCost(node),
    measured: profile === null ? null : measuredOf(profile),
    choice: operatorChoice(planner, node),
    breakdown: costBreakdown(planner, node),
  };
}

function walkPlan(node: PhysicalPlanNode, path: string, depth: number, planner: PhysicalPlanner, into: OperatorRow[]): void {
  into.push(rowOf(node, null, path, depth, planner));
  node.children.forEach((child, index) => walkPlan(child, `${path}.${index}`, depth + 1, planner, into));
}

function walkProfile(tree: ProfileTreeNode, path: string, depth: number, planner: PhysicalPlanner, into: OperatorRow[]): void {
  into.push(rowOf(tree.profile.node, tree.profile, path, depth, planner));
  tree.children.forEach((child, index) => walkProfile(child, `${path}.${index}`, depth + 1, planner, into));
}

export function planRows(root: PhysicalPlanNode, planner: PhysicalPlanner): OperatorRow[] {
  const rows: OperatorRow[] = [];
  walkPlan(root, ROOT_PATH, 0, planner, rows);
  return rows;
}

export function profileRows(profile: ExecutionProfile, planner: PhysicalPlanner): OperatorRow[] {
  const rows: OperatorRow[] = [];
  profile.roots.forEach((root, index) => walkProfile(root, `${ROOT_PATH}${index}`, 0, planner, rows));
  return rows;
}

export function planTotalCost(rows: readonly OperatorRow[]): number {
  return rows.reduce((total, row) => (row.depth === 0 ? total + row.subtreeCost : total), 0);
}

export function costShareOf(rows: readonly OperatorRow[], row: OperatorRow): number {
  const planTotal = planTotalCost(rows);
  return planTotal === 0 ? 0 : row.cost / planTotal;
}

export function topCostContributors(rows: readonly OperatorRow[], limit: number): OperatorRow[] {
  return [...rows].sort((a, b) => b.cost - a.cost).slice(0, limit).filter(row => row.cost > 0);
}

export function worstEstimates(rows: readonly OperatorRow[], limit: number): OperatorRow[] {
  return rows
    .filter(row => row.measured !== null && row.measured.ran && row.measured.tone !== 'good')
    .sort((a, b) => (b.measured as MeasuredRows).qError - (a.measured as MeasuredRows).qError)
    .slice(0, limit);
}
