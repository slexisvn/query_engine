import { describe, it, expect } from 'vitest';
import { PhysicalNodeType } from '@engine/execution/physical-plan.js';
import { buildRepro, decodeState, encodeState, REPRO_VERSION, serializeRepro } from '../../src/engine/repro.js';
import { Workspace } from '../../src/engine/workspace.js';
import type { ReproBundle, ReproState } from '../../src/engine/repro.js';

const SALES_CSV = ['region,amount', 'north,120', 'south,80', 'north,45'].join('\n');

const SQL = 'SELECT REGION, SUM(AMOUNT) AS TOTAL FROM SALES GROUP BY REGION';

async function reproFor(disabled: string[] = [], run = false): Promise<ReproBundle> {
  const workspace = new Workspace();
  const imported = await workspace.importCsv('sales.csv', SALES_CSV);
  if (!imported.ok) throw new Error(imported.message);

  const outcome = run ? await workspace.run(SQL) : null;
  return buildRepro({
    sql: SQL,
    rowCounts: workspace.sampleRowCounts(),
    disabled: new Set(disabled),
    tables: workspace.tables(),
    statistics: workspace.statistics(),
    profile: outcome !== null && outcome.ok ? outcome.profile : null,
  });
}

describe('building a repro bundle', () => {
  it('carries the query and the pipeline it was planned with', async () => {
    const bundle = await reproFor(['PredicatePushdown']);

    expect(bundle.version).toBe(REPRO_VERSION);
    expect(bundle.sql).toBe(SQL);
    expect(bundle.disabled).toEqual(['PredicatePushdown']);
  });

  it('describes every table the catalog holds', async () => {
    const bundle = await reproFor();
    const sales = bundle.tables.find(table => table.name === 'SALES');

    expect(sales?.kind).toBe('imported');
    expect(sales?.loadedRows).toBe(3);
    expect(sales?.columns.map(column => column.name)).toEqual(['REGION', 'AMOUNT']);
  });

  it('carries the statistics the estimates came from', async () => {
    const bundle = await reproFor();
    const sales = bundle.statistics.find(entry => entry.table === 'SALES');

    expect(sales?.rowCount).toBe(3);
    expect(sales?.columns.find(column => column.column === 'REGION')?.ndv).toBe(2);
  });

  it('leaves the measurements out until the query has run', async () => {
    expect((await reproFor()).measured).toBeNull();
  });

  it('records estimated against actual once the query has run', async () => {
    const bundle = await reproFor([], true);
    const scan = bundle.measured?.find(entry => entry.operator === PhysicalNodeType.TABLE_SCAN);

    expect(bundle.measured?.length).toBeGreaterThan(0);
    expect(scan?.actualRows).toBe(3);
  });

  it('serializes to JSON a bug report can carry', async () => {
    const text = serializeRepro(await reproFor([], true));
    const parsed: unknown = JSON.parse(text);

    expect((parsed as ReproBundle).sql).toBe(SQL);
    expect(text).toContain('"statistics"');
  });
});

describe('sharing state through a link', () => {
  const state: ReproState = {
    sql: "SELECT * FROM ORDERS WHERE O_ORDERSTATUS = 'F'",
    rowCounts: { ORDERS: 1_500_000, CUSTOMER: 150_000 },
    disabled: ['TopNFusion'],
  };

  it('round-trips everything needed to reproduce a plan', () => {
    expect(decodeState(encodeState(state))).toEqual(state);
  });

  it('encodes to a string that survives a URL fragment', () => {
    expect(encodeState(state)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('round-trips SQL with characters that need escaping', () => {
    const awkward: ReproState = { sql: "SELECT '→ ü' AS X FROM T WHERE A = '%+/='", rowCounts: {}, disabled: [] };

    expect(decodeState(encodeState(awkward))?.sql).toBe(awkward.sql);
  });

  it('treats a missing disabled list as no passes disabled', () => {
    const encoded = encodeState({ sql: 'SELECT 1', rowCounts: {}, disabled: [] });

    expect(decodeState(encoded)?.disabled).toEqual([]);
  });

  it('refuses text that is not a state bundle', () => {
    expect(decodeState('not-base64!!')).toBeNull();
    expect(decodeState(encodeState({ sql: 'x', rowCounts: {}, disabled: [] }).slice(0, 4))).toBeNull();
  });

  it('refuses a bundle with the wrong shape', () => {
    const encoded = btoa(JSON.stringify({ sql: 42, rowCounts: {} })).replace(/=+$/, '');

    expect(decodeState(encoded)).toBeNull();
  });

  it('refuses row counts that are not numbers', () => {
    const encoded = btoa(JSON.stringify({ sql: 'x', rowCounts: { ORDERS: 'many' } })).replace(/=+$/, '');

    expect(decodeState(encoded)).toBeNull();
  });
});
