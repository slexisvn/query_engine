import { describe, it, expect } from 'vitest';
import { PhysicalNodeType } from '@engine/execution/physical-plan.js';
import { Workspace } from '../../src/engine/workspace.js';
import {
  BAD_Q_ERROR,
  WARN_Q_ERROR,
  planRows,
  profileRows,
  toneOf,
  worstEstimates,
} from '../../src/engine/profile-view.js';
import { trace } from './helpers.js';
import type { ExecutionProfile, OperatorProfile, ProfileTreeNode } from '@engine/execution/execution-profile.js';
import type { PhysicalPlanNode } from '@engine/execution/physical-plan.js';
import type { OperatorRow } from '../../src/engine/profile-view.js';
import type { PipelineTrace } from '../../src/engine/trace.js';

const SALES_CSV = [
  'region,amount',
  'north,120',
  'south,80',
  'north,45',
  'east,10',
].join('\n');

const JOIN_QUERY = `
  SELECT c.C_NAME, o.O_TOTALPRICE
  FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
`;

function physicalOf(pipeline: PipelineTrace): PhysicalPlanNode {
  const physical = pipeline.subjects[0].physical;
  if (!physical) throw new Error('no physical plan');
  return physical;
}

function countNodes(node: PhysicalPlanNode): number {
  return 1 + node.children.reduce((total, child) => total + countNodes(child), 0);
}

function fakeProfile(
  node: PhysicalPlanNode,
  actualBy: (node: PhysicalPlanNode) => number,
  invocations: number = 1,
): ProfileTreeNode {
  const profile: OperatorProfile = {
    node,
    estimatedRows: node.cardinality,
    actualRows: actualBy(node),
    chunks: 2,
    invocations,
    firstOutputMs: 1,
    lastOutputMs: 4,
  };
  return { profile, children: node.children.map(child => fakeProfile(child, actualBy, invocations)) };
}

function profileOf(
  node: PhysicalPlanNode,
  actualBy: (node: PhysicalPlanNode) => number,
  invocations: number = 1,
): ExecutionProfile {
  return { totalMs: 7, roots: [fakeProfile(node, actualBy, invocations)] };
}

async function salesWorkspace(): Promise<Workspace> {
  const workspace = new Workspace();
  const imported = await workspace.importCsv('sales.csv', SALES_CSV);
  if (!imported.ok) throw new Error(imported.message);
  return workspace;
}

describe('rows from a plan alone', () => {
  it('emits one row per operator', () => {
    const pipeline = trace(JOIN_QUERY);
    const physical = physicalOf(pipeline);

    expect(planRows(physical, pipeline.metrics.planner)).toHaveLength(countNodes(physical));
  });

  it('nests children one level deeper than their parent', () => {
    const pipeline = trace(JOIN_QUERY);
    const rows = planRows(physicalOf(pipeline), pipeline.metrics.planner);

    expect(rows[0].depth).toBe(0);
    for (const row of rows.slice(1)) {
      const parent = rows.find(candidate => candidate.path === row.path.slice(0, row.path.lastIndexOf('.')));
      expect(row.depth).toBe((parent as OperatorRow).depth + 1);
    }
  });

  it('leaves the measured columns empty until the query runs', () => {
    const pipeline = trace(JOIN_QUERY);
    const rows = planRows(physicalOf(pipeline), pipeline.metrics.planner);

    expect(rows.every(row => row.measured === null)).toBe(true);
    expect(rows.every(row => row.estimatedRows > 0)).toBe(true);
  });

  it('carries the operator choice onto the join row', () => {
    const pipeline = trace(JOIN_QUERY);
    const rows = planRows(physicalOf(pipeline), pipeline.metrics.planner);
    const join = rows.find(row => row.node.type === PhysicalNodeType.HASH_JOIN);

    expect(join?.choice).not.toBeNull();
    expect(rows.find(row => row.node.type === PhysicalNodeType.TABLE_SCAN)?.choice).toBeNull();
  });
});

describe('rows from a measured run', () => {
  it('pairs each estimate with the rows the operator produced', () => {
    const pipeline = trace(JOIN_QUERY);
    const physical = physicalOf(pipeline);
    const rows = profileRows(profileOf(physical, node => node.cardinality * 3), pipeline.metrics.planner);

    expect(rows).toHaveLength(countNodes(physical));
    for (const row of rows) {
      expect(row.measured?.actualRows).toBe(row.estimatedRows * 3);
      expect(row.measured?.bias).toBe('under');
      expect(row.measured?.qError).toBeCloseTo(3);
    }
  });

  it('reports the output window between the first and last chunk', () => {
    const pipeline = trace(JOIN_QUERY);
    const rows = profileRows(profileOf(physicalOf(pipeline), node => node.cardinality), pipeline.metrics.planner);

    expect(rows[0].measured?.outputMs).toBe(3);
  });

  it('calls an estimate that was too high an overestimate', () => {
    const pipeline = trace(JOIN_QUERY);
    const rows = profileRows(profileOf(physicalOf(pipeline), () => 1), pipeline.metrics.planner);
    const scan = rows.find(row => row.node.type === PhysicalNodeType.TABLE_SCAN);

    expect(scan?.measured?.bias).toBe('over');
    expect(scan?.measured?.tone).toBe('bad');
  });
});

describe('an operator that was built but never ran', () => {
  it('is not scored as a misestimate', () => {
    const pipeline = trace(JOIN_QUERY);
    const rows = profileRows(profileOf(physicalOf(pipeline), () => 0, 0), pipeline.metrics.planner);

    expect(rows.every(row => row.measured?.ran === false)).toBe(true);
    expect(rows.every(row => row.measured?.tone === 'idle')).toBe(true);
  });

  it('is kept out of the worst-estimate ranking', () => {
    const pipeline = trace(JOIN_QUERY);
    const rows = profileRows(profileOf(physicalOf(pipeline), () => 0, 0), pipeline.metrics.planner);

    expect(worstEstimates(rows, 3)).toEqual([]);
  });

  it('still ranks an operator that ran and produced nothing', () => {
    const pipeline = trace(JOIN_QUERY);
    const rows = profileRows(profileOf(physicalOf(pipeline), () => 0, 1), pipeline.metrics.planner);

    expect(rows[0].measured?.ran).toBe(true);
    expect(worstEstimates(rows, 3).length).toBeGreaterThan(0);
  });
});

describe('estimate tone', () => {
  it('treats a near-miss as good', () => {
    expect(toneOf(1)).toBe('good');
    expect(toneOf(WARN_Q_ERROR - 0.01)).toBe('good');
  });

  it('warns from the warn threshold up to the bad one', () => {
    expect(toneOf(WARN_Q_ERROR)).toBe('warn');
    expect(toneOf(BAD_Q_ERROR - 0.01)).toBe('warn');
  });

  it('calls an order-of-magnitude miss bad', () => {
    expect(toneOf(BAD_Q_ERROR)).toBe('bad');
  });
});

describe('worst estimates', () => {
  it('ranks the biggest misses first and drops the accurate ones', () => {
    const pipeline = trace(JOIN_QUERY);
    const physical = physicalOf(pipeline);
    const rows = profileRows(
      profileOf(physical, node => (node.type === PhysicalNodeType.TABLE_SCAN ? node.cardinality * 50 : node.cardinality)),
      pipeline.metrics.planner,
    );
    const worst = worstEstimates(rows, 3);

    expect(worst.length).toBeGreaterThan(0);
    expect(worst.every(row => row.node.type === PhysicalNodeType.TABLE_SCAN)).toBe(true);
    expect(worst.map(row => row.measured?.qError)).toEqual([...worst.map(row => row.measured?.qError)].sort((a, b) => (b as number) - (a as number)));
  });

  it('keeps nothing when every estimate landed', () => {
    const pipeline = trace(JOIN_QUERY);
    const rows = profileRows(profileOf(physicalOf(pipeline), node => node.cardinality), pipeline.metrics.planner);

    expect(worstEstimates(rows, 3)).toEqual([]);
  });

  it('never returns more than the limit', () => {
    const pipeline = trace(JOIN_QUERY);
    const rows = profileRows(profileOf(physicalOf(pipeline), node => node.cardinality * 100), pipeline.metrics.planner);

    expect(worstEstimates(rows, 2)).toHaveLength(2);
  });
});

describe('a real run through the workspace', () => {
  it('brings back a profile whose leaf counted every imported row', async () => {
    const workspace = await salesWorkspace();
    const outcome = await workspace.run('SELECT REGION FROM SALES WHERE AMOUNT > 40');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.profile).not.toBeNull();
    const rows = profileRows(outcome.profile!, trace('SELECT 1').metrics.planner);
    const scan = rows.find(row => row.node.type === PhysicalNodeType.TABLE_SCAN);
    const filter = rows.find(row => row.node.type === PhysicalNodeType.FILTER);

    expect(scan?.measured?.actualRows).toBe(4);
    expect(filter?.measured?.actualRows).toBe(3);
  });

  it('matches the rows the query returned at the root', async () => {
    const workspace = await salesWorkspace();
    const outcome = await workspace.run('SELECT REGION, SUM(AMOUNT) AS TOTAL FROM SALES GROUP BY REGION');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const rows = profileRows(outcome.profile!, trace('SELECT 1').metrics.planner);
    expect(rows[0].measured?.actualRows).toBe(outcome.total);
  });
});
