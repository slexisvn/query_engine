import { describe, it, expect } from 'vitest';
import { TPCH_TABLES } from '@engine/catalog/tpch-schema.js';
import { buildSampleRows } from '../../src/engine/sample-data.js';
import { EXAMPLES } from '../../src/content/examples.js';
import { Workspace } from '../../src/engine/workspace.js';

const EMPTY_BY_DESIGN = new Set(['Empty propagation']);

describe('sample rows', () => {
  const rows = buildSampleRows();

  it('covers every table in the sample schema', () => {
    expect(Object.keys(rows).sort()).toEqual(Object.keys(TPCH_TABLES).sort());
  });

  it('emits only columns the schema declares', () => {
    for (const [name, table] of Object.entries(TPCH_TABLES)) {
      const declared = new Set(table.columns.map(column => column.name));
      const produced = new Set(Object.keys(rows[name][0]));
      expect([...produced].filter(column => !declared.has(column))).toEqual([]);
      expect([...declared].filter(column => !produced.has(column))).toEqual([]);
    }
  });

  it('is deterministic', () => {
    expect(buildSampleRows().ORDERS[42]).toEqual(rows.ORDERS[42]);
  });

  it('keeps foreign keys inside the tables they reference', () => {
    const orderKeys = new Set(rows.ORDERS.map(row => row.O_ORDERKEY));
    const customerKeys = new Set(rows.CUSTOMER.map(row => row.C_CUSTKEY));

    expect(rows.ORDERS.every(row => customerKeys.has(row.O_CUSTKEY))).toBe(true);
    expect(rows.LINEITEM.every(row => orderKeys.has(row.L_ORDERKEY))).toBe(true);
  });

  it('ships the nations the examples query by name', () => {
    expect(rows.NATION.map(row => row.N_NAME)).toContain('VIETNAM');
  });
});

describe('bundled examples against the sample rows', () => {
  it.each(EXAMPLES.map(example => [example.name, example.sql] as const))(
    '%s returns rows',
    async (name, sql) => {
      const workspace = new Workspace();
      const outcome = await workspace.run(sql);

      expect(outcome.ok ? null : outcome).toBe(null);
      if (!outcome.ok) return;
      if (EMPTY_BY_DESIGN.has(name)) expect(outcome.total).toBe(0);
      else expect(outcome.total).toBeGreaterThan(0);
    },
  );
});
