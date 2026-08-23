import { describe, it, expect } from 'vitest';
import { PREVIEW_ROW_CAP, RESULT_ROW_CAP, Workspace } from '../../src/engine/workspace.js';

const SALES_CSV = [
  'region,amount,sold_on,note',
  'north,120.5,2024-01-05,"Hanoi, VN"',
  'south,80,2024-02-11,ok',
  'north,45.25,2024-03-02,',
  'east,,2024-03-02,missing amount',
].join('\n');

async function withSales(): Promise<Workspace> {
  const workspace = new Workspace();
  const outcome = await workspace.importCsv('sales.csv', SALES_CSV);
  if (!outcome.ok) throw new Error(outcome.message);
  return workspace;
}

describe('importing a CSV', () => {
  it('names the table after the file', async () => {
    const workspace = new Workspace();
    const outcome = await workspace.importCsv('q1 sales.csv', SALES_CSV);
    expect(outcome.ok && outcome.table.name).toBe('Q1_SALES');
  });

  it('infers a column type per column', async () => {
    const workspace = await withSales();
    const table = workspace.tables().find(entry => entry.name === 'SALES');
    expect(table?.columns.map(column => `${column.name}:${column.dataType}`))
      .toEqual(['REGION:VARCHAR', 'AMOUNT:FLOAT64', 'SOLD_ON:VARCHAR', 'NOTE:VARCHAR']);
  });

  it('counts the rows it loaded', async () => {
    const workspace = await withSales();
    expect(workspace.tables().find(entry => entry.name === 'SALES')?.rowCount).toBe(4);
  });

  it('reports the table as having data', async () => {
    const workspace = await withSales();
    expect(workspace.hasData('SALES')).toBe(true);
  });

  it('refuses a file named after a sample table', async () => {
    const workspace = new Workspace();
    const outcome = await workspace.importCsv('orders.csv', SALES_CSV);
    expect(outcome.ok ? '' : outcome.message).toContain('sample table');
  });

  it('refuses a file with no rows', async () => {
    const workspace = new Workspace();
    const outcome = await workspace.importCsv('empty.csv', 'a,b');
    expect(outcome.ok ? '' : outcome.message).toContain('no rows');
  });

  it('bumps the version so a trace reruns', async () => {
    const workspace = new Workspace();
    const before = workspace.version;
    await workspace.importCsv('sales.csv', SALES_CSV);
    expect(workspace.version).toBeGreaterThan(before);
  });
});

describe('the sample catalog', () => {
  it('lists every table of the sample schema, indexed or not', () => {
    const names = new Workspace().tables().filter(entry => entry.kind === 'sample').map(entry => entry.name);
    expect(names).toEqual(['REGION', 'NATION', 'SUPPLIER', 'PART', 'PARTSUPP', 'CUSTOMER', 'ORDERS', 'LINEITEM']);
  });

  it('carries the column list for a table with no index', () => {
    const partsupp = new Workspace().tables().find(entry => entry.name === 'PARTSUPP');
    expect(partsupp?.columns.map(column => column.name)).toContain('PS_SUPPLYCOST');
    expect(partsupp?.indexed).toEqual([]);
  });
});

describe('statistics from imported data', () => {
  it('takes the row count from the data rather than an estimate', async () => {
    const workspace = await withSales();
    expect(workspace.statistics().get('SALES')?.rowCount).toBe(4);
  });

  it('counts distinct values of a real column', async () => {
    const workspace = await withSales();
    expect(workspace.statistics().get('SALES')?.getColumnStats?.('REGION')?.ndv).toBe(3);
  });

  it('drops the sample estimates once real data replaces them', async () => {
    const workspace = await withSales();
    const stats = workspace.statistics();
    expect(stats.get('ORDERS')).toBe(undefined);
    expect(stats.get('SALES')?.rowCount).toBe(4);
  });

  it('re-estimates a sample table when its row count is edited', () => {
    const workspace = new Workspace();
    workspace.setRowCount('ORDERS', 40);
    expect(workspace.statistics().get('ORDERS')?.rowCount).toBe(40);
  });

  it('ignores a row count edit aimed at imported data', async () => {
    const workspace = await withSales();
    workspace.setRowCount('SALES', 9999);
    expect(workspace.statistics().get('SALES')?.rowCount).toBe(4);
  });
});

describe('running a query', () => {
  it('returns the rows the query computed', async () => {
    const workspace = await withSales();
    const outcome = await workspace.run('SELECT REGION, COUNT(*) AS n FROM SALES GROUP BY REGION ORDER BY REGION');

    expect(outcome.ok && outcome.rows).toEqual([
      { REGION: 'east', n: 1 },
      { REGION: 'north', n: 2 },
      { REGION: 'south', n: 1 },
    ]);
  });

  it('names the output columns', async () => {
    const workspace = await withSales();
    const outcome = await workspace.run('SELECT REGION, SUM(AMOUNT) AS total FROM SALES GROUP BY REGION');
    expect(outcome.ok && outcome.columns).toEqual(['REGION', 'total']);
  });

  it('filters on a value the CSV stored as a number', async () => {
    const workspace = await withSales();
    const outcome = await workspace.run('SELECT REGION FROM SALES WHERE AMOUNT > 100');
    expect(outcome.ok && outcome.rows).toEqual([{ REGION: 'north' }]);
  });

  it('keeps a comma that was quoted inside one field', async () => {
    const workspace = await withSales();
    const outcome = await workspace.run("SELECT NOTE FROM SALES WHERE NOTE = 'Hanoi, VN'");
    expect(outcome.ok && outcome.rows.length).toBe(1);
  });

  it('orders a date column stored as text by calendar order', async () => {
    const workspace = await withSales();
    const outcome = await workspace.run('SELECT SOLD_ON FROM SALES ORDER BY SOLD_ON');
    expect(outcome.ok && outcome.rows.map(row => row.SOLD_ON))
      .toEqual(['2024-01-05', '2024-02-11', '2024-03-02', '2024-03-02']);
  });

  it('compares a date column against a plain string literal', async () => {
    const workspace = await withSales();
    const outcome = await workspace.run("SELECT REGION FROM SALES WHERE SOLD_ON > '2024-02-01' ORDER BY REGION");
    expect(outcome.ok && outcome.rows).toEqual([{ REGION: 'east' }, { REGION: 'north' }, { REGION: 'south' }]);
  });

  it('measures how long the run took', async () => {
    const workspace = await withSales();
    const outcome = await workspace.run('SELECT * FROM SALES');
    expect(outcome.ok && Number.isFinite(outcome.ms)).toBe(true);
  });

  it('reports a sample table as having no data instead of returning nothing', async () => {
    const workspace = new Workspace();
    const outcome = await workspace.run('SELECT C_NAME FROM CUSTOMER');
    expect(outcome.ok ? null : outcome).toMatchObject({ reason: 'no-data', tables: ['CUSTOMER'] });
  });

  it('reports a runtime failure as an error', async () => {
    const workspace = await withSales();
    const outcome = await workspace.run('SELECT nope FROM SALES');
    expect(outcome.ok ? '' : outcome.reason).toBe('error');
  });

  it('caps how many rows it hands back but still reports the true total', async () => {
    const workspace = new Workspace();
    const rows = Array.from({ length: RESULT_ROW_CAP + 40 }, (_, index) => `${index},${index % 7}`);
    await workspace.importCsv('big.csv', ['id,bucket', ...rows].join('\n'));
    const outcome = await workspace.run('SELECT * FROM BIG');

    expect(outcome.ok && outcome.total).toBe(RESULT_ROW_CAP + 40);
    expect(outcome.ok && outcome.rows.length).toBe(RESULT_ROW_CAP);
    expect(outcome.ok && outcome.truncated).toBe(true);
  });

  it('leaves a result under the cap whole', async () => {
    const workspace = await withSales();
    const outcome = await workspace.run('SELECT * FROM SALES');

    expect(outcome.ok && outcome.rows.length).toBe(4);
    expect(outcome.ok && outcome.truncated).toBe(false);
  });
});

describe('the preview an import keeps', () => {
  it('keeps the rows it parsed so the catalog can show them', async () => {
    const workspace = await withSales();
    const table = workspace.tables().find(entry => entry.name === 'SALES');

    expect(table?.preview.length).toBe(4);
    expect(table?.preview[0]).toEqual({ REGION: 'north', AMOUNT: 120.5, SOLD_ON: '2024-01-05', NOTE: 'Hanoi, VN' });
  });

  it('caps the preview without capping the row count', async () => {
    const workspace = new Workspace();
    const rows = Array.from({ length: PREVIEW_ROW_CAP + 25 }, (_, index) => `${index}`);
    await workspace.importCsv('wide.csv', ['id', ...rows].join('\n'));
    const table = workspace.tables().find(entry => entry.name === 'WIDE');

    expect(table?.rowCount).toBe(PREVIEW_ROW_CAP + 25);
    expect(table?.preview.length).toBe(PREVIEW_ROW_CAP);
  });

  it('gives a sample table no preview at all', () => {
    const orders = new Workspace().tables().find(entry => entry.name === 'ORDERS');
    expect(orders?.preview).toEqual([]);
  });
});

describe('user data replacing the sample schema', () => {
  it('starts on the sample schema', () => {
    const workspace = new Workspace();
    expect(workspace.usesSampleSchema).toBe(true);
    expect(workspace.tables().some(entry => entry.name === 'CUSTOMER')).toBe(true);
  });

  it('hands the catalog over to imported data', async () => {
    const workspace = await withSales();
    expect(workspace.usesSampleSchema).toBe(false);
    expect(workspace.tables().map(entry => entry.name)).toEqual(['SALES']);
  });

  it('makes a sample table unknown once real data is loaded', async () => {
    const workspace = await withSales();
    const outcome = await workspace.run('SELECT C_NAME FROM CUSTOMER');
    expect(outcome.ok ? '' : outcome.reason).toBe('error');
  });

  it('hands the catalog back when the last import goes', async () => {
    const workspace = await withSales();
    workspace.dropTable('SALES');

    expect(workspace.usesSampleSchema).toBe(true);
    expect(workspace.tables().some(entry => entry.name === 'CUSTOMER')).toBe(true);
    expect(workspace.statistics().get('ORDERS')?.rowCount).toBe(1_500_000);
  });

  it('keeps the sample schema away while any import remains', async () => {
    const workspace = await withSales();
    const second = await workspace.importCsv('extra.csv', 'a\nb');
    expect(second.ok).toBe(true);

    workspace.dropTable('SALES');
    expect(workspace.usesSampleSchema).toBe(false);
    expect(workspace.tables().map(entry => entry.name)).toEqual(['EXTRA']);
  });

  it('restores the indexes the sample schema carries', async () => {
    const workspace = await withSales();
    workspace.dropTable('SALES');

    const orders = workspace.tables().find(entry => entry.name === 'ORDERS');
    expect(orders?.indexed).toEqual(['O_ORDERKEY', 'O_ORDERDATE']);
  });
});

describe('dropping an imported table', () => {
  it('removes it from the catalog', async () => {
    const workspace = await withSales();
    workspace.dropTable('SALES');
    expect(workspace.tables().some(entry => entry.name === 'SALES')).toBe(false);
  });

  it('makes a query against it fail to bind', async () => {
    const workspace = await withSales();
    workspace.dropTable('SALES');
    const outcome = await workspace.run('SELECT * FROM SALES');
    expect(outcome.ok ? '' : outcome.reason).toBe('error');
  });

  it('refuses to drop a sample table', () => {
    const workspace = new Workspace();
    workspace.dropTable('ORDERS');
    expect(workspace.tables().some(entry => entry.name === 'ORDERS')).toBe(true);
  });
});
