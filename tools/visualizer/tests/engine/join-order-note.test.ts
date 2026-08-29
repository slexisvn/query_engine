import { describe, it, expect } from 'vitest';
import { Config } from '@engine/config.js';
import { joinOrderNote } from '../../src/engine/join-order-note.js';
import { mainTrace, trace } from './helpers.js';
import { PlanNodeType } from '@engine/planner/logical-plan.js';
import type { LogicalPlanNode } from '@engine/planner/logical-plan.js';

function leaf(): LogicalPlanNode {
  return { type: PlanNodeType.SCAN, table: 'T', children: [] } as unknown as LogicalPlanNode;
}

function chainOfJoins(joins: number): LogicalPlanNode {
  let node = leaf();
  for (let index = 0; index < joins; index++) {
    node = { type: PlanNodeType.JOIN, children: [node, leaf()] } as unknown as LogicalPlanNode;
  }
  return node;
}

function unoptimized(sql: string): LogicalPlanNode {
  return mainTrace(trace(sql)).snapshots[0].plan;
}

const TWO_WAY = `
  SELECT c.C_NAME FROM CUSTOMER c JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
`;

const FOUR_WAY = `
  SELECT c.C_NAME
  FROM CUSTOMER c
    JOIN ORDERS o ON c.C_CUSTKEY = o.O_CUSTKEY
    JOIN LINEITEM l ON o.O_ORDERKEY = l.L_ORDERKEY
    JOIN NATION n ON c.C_NATIONKEY = n.N_NATIONKEY
`;

const SEPARATE_CLUSTERS = `
  SELECT total.N
  FROM (
    SELECT o.O_CUSTKEY AS K, COUNT(*) AS N
    FROM ORDERS o JOIN LINEITEM l ON o.O_ORDERKEY = l.L_ORDERKEY
    GROUP BY o.O_CUSTKEY
  ) total
  JOIN CUSTOMER c ON c.C_CUSTKEY = total.K
`;

describe('reporting how the join order was searched', () => {
  it('counts the relations a two-way join connects', () => {
    const note = joinOrderNote(unoptimized(TWO_WAY));

    expect(note.clusters).toHaveLength(1);
    expect(note.clusters[0].relations).toBe(2);
  });

  it('counts every relation in one join cluster', () => {
    const note = joinOrderNote(unoptimized(FOUR_WAY));

    expect(note.clusters).toHaveLength(1);
    expect(note.clusters[0].relations).toBe(4);
  });

  it('picks exhaustive search while the cluster stays small', () => {
    expect(joinOrderNote(unoptimized(FOUR_WAY)).clusters[0].enumerator).toBe('DPhyp');
  });

  it('reports the limit exhaustive search is held to', () => {
    expect(joinOrderNote(unoptimized(TWO_WAY)).dpLimit).toBe(Config.joinOrderDpMaxRelations);
  });

  it('keeps clusters separated by an aggregate apart', () => {
    const note = joinOrderNote(unoptimized(SEPARATE_CLUSTERS));

    expect(note.clusters).toHaveLength(2);
    expect(note.clusters.every(cluster => cluster.relations === 2)).toBe(true);
  });

  it('finds no cluster in a query without a join', () => {
    expect(joinOrderNote(unoptimized('SELECT C_NAME FROM CUSTOMER')).clusters).toEqual([]);
  });

  it('falls back to a heuristic once the cluster passes the limit', () => {
    const chain = chainOfJoins(Config.joinOrderDpMaxRelations);
    const note = joinOrderNote(chain);

    expect(note.clusters[0].relations).toBe(Config.joinOrderDpMaxRelations + 1);
    expect(note.clusters[0].enumerator).toBe('greedy');
  });

  it('still searches exhaustively at exactly the limit', () => {
    const chain = chainOfJoins(Config.joinOrderDpMaxRelations - 1);

    expect(joinOrderNote(chain).clusters[0].relations).toBe(Config.joinOrderDpMaxRelations);
    expect(joinOrderNote(chain).clusters[0].enumerator).toBe('DPhyp');
  });
});
