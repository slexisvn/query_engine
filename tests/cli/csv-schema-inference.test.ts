import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { CSVLoader } from '../../src/cli/loaders/csv-loader.js';
import '../../src/index.js';
import { createEngine } from '../../src/engine-entry.js';

const NL = String.fromCharCode(10);

describe('CSV loader schema inference', () => {
  const written: string[] = [];

  afterEach(() => {
    for (const file of written.splice(0)) {
      try { fs.unlinkSync(file); } catch { /* already removed */ }
    }
  });

  async function loadCsv(name: string, lines: string[]) {
    const file = path.join(os.tmpdir(), `${name}_${process.pid}.csv`);
    fs.writeFileSync(file, lines.join(NL) + NL);
    written.push(file);
    const engine = createEngine();
    const table = await new CSVLoader().load(engine, file);
    return { engine, table };
  }

  async function query(name: string, lines: string[], sql: (table: string) => string) {
    const { engine, table } = await loadCsv(name, lines);
    const rows = (await engine.run(sql(table))).rows;
    engine.close();
    return rows;
  }

  it('reads a decimal that only appears after the first row', async () => {
    const rows = await query('decimals', ['id,amount', '1,10', '2,2.5'],
      t => `SELECT AMOUNT FROM ${t} ORDER BY ID`);
    expect(rows).toEqual([{ AMOUNT: 10 }, { AMOUNT: 2.5 }]);
  });

  it('widens a column whose later values exceed the 32-bit range', async () => {
    const rows = await query('wide', ['id,n', '1,1', '2,1000000000000'],
      t => `SELECT SUM(N) AS S FROM ${t}`);
    expect(rows).toEqual([{ S: 1000000000001 }]);
  });

  it('treats a column with mixed text and numbers as text', async () => {
    const rows = await query('mixed', ['id,v', '1,10', '2,abc'],
      t => `SELECT V FROM ${t} ORDER BY ID`);
    expect(rows).toEqual([{ V: '10' }, { V: 'abc' }]);
  });

  it('keeps blank cells null rather than zero', async () => {
    const rows = await query('blanks', ['id,n', '1,5', '2,'],
      t => `SELECT N FROM ${t} ORDER BY ID`);
    expect(rows).toEqual([{ N: 5 }, { N: null }]);
  });

  it('still types a uniformly integral column as an integer', async () => {
    const rows = await query('ints', ['id,n', '1,5', '2,7'], t => `SELECT SUM(N) AS S FROM ${t}`);
    expect(rows).toEqual([{ S: 12 }]);
  });

  it('reads booleans', async () => {
    const rows = await query('bools', ['id,ok', '1,true', '2,false'],
      t => `SELECT COUNT(*) AS C FROM ${t} WHERE OK`);
    expect(rows).toEqual([{ C: 1 }]);
  });

  it('nulls a junk value that appears after the inference sample', async () => {
    const lines = ['id,n'];
    for (let i = 1; i <= 1200; i++) lines.push(`${i},${i}`);
    lines.push('1201,abc');
    const rows = await query('late_junk', lines,
      t => `SELECT COUNT(*) AS C, COUNT(N) AS NN, SUM(N) AS S FROM ${t}`);
    expect(rows).toEqual([{ C: 1201, NN: 1200, S: (1200 * 1201) / 2 }]);
  });

  it('keeps every row when the file is larger than the inference sample', async () => {
    const lines = ['id,n'];
    for (let i = 1; i <= 2500; i++) lines.push(`${i},${i}`);
    const rows = await query('large', lines, t => `SELECT COUNT(*) AS C, SUM(N) AS S FROM ${t}`);
    expect(rows).toEqual([{ C: 2500, S: (2500 * 2501) / 2 }]);
  });
});
