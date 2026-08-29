import { describe, it, expect, beforeEach } from 'vitest';
import { QueryEngine } from '../../src/index.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { registerTable } from '../../src/engine-entry.js';
import { PhysicalNodeType } from '../../src/execution/physical-plan.js';
import {
  biasOf,
  estimateLabel,
  flattenProfile,
  profileToString,
} from '../../src/execution/execution-profile.js';

const BUCKETS = 4;
const PRICE_THRESHOLD = 25;
const NARROW_THRESHOLD = 31;

const ITEMS = Array.from({ length: 40 }, (_, i) => ({ ID: i, PRICE: i, BUCKET: i % BUCKETS }));
const ROW_COUNT = ITEMS.length;

function countItems(predicate) {
  return ITEMS.filter(predicate).length;
}

function makeEngine() {
  const engine = new QueryEngine(new Catalog());
  registerTable(engine, 'ITEMS', ITEMS);
  return engine;
}

function profileFor(roots, type) {
  return flattenProfile(roots).find(entry => entry.node.type === type);
}

let engine;

beforeEach(() => {
  engine = makeEngine();
});

describe('execution profile', () => {
  it('counts the rows each operator actually produced', async () => {
    const result = await engine.runProfiled(`SELECT ID FROM ITEMS WHERE PRICE > ${PRICE_THRESHOLD}`);
    const surviving = countItems(item => item.PRICE > PRICE_THRESHOLD);

    expect(result.rows).toHaveLength(surviving);
    expect(profileFor(result.profile.roots, PhysicalNodeType.TABLE_SCAN).actualRows).toBe(ROW_COUNT);
    expect(profileFor(result.profile.roots, PhysicalNodeType.FILTER).actualRows).toBe(surviving);
  });

  it('measures rather than echoes the planner estimate', async () => {
    const wide = await engine.runProfiled('SELECT ID FROM ITEMS WHERE BUCKET = 0');
    const narrow = await engine.runProfiled(`SELECT ID FROM ITEMS WHERE BUCKET = 0 AND PRICE > ${NARROW_THRESHOLD}`);

    const wideFilter = profileFor(wide.profile.roots, PhysicalNodeType.FILTER);
    const narrowFilter = profileFor(narrow.profile.roots, PhysicalNodeType.FILTER);

    expect(wideFilter.actualRows).toBe(countItems(item => item.BUCKET === 0));
    expect(narrowFilter.actualRows).toBe(countItems(item => item.BUCKET === 0 && item.PRICE > NARROW_THRESHOLD));
    expect(narrowFilter.actualRows).toBeLessThan(wideFilter.actualRows);
  });

  it('accumulates rows across every chunk an operator emits', async () => {
    const result = await engine.runProfiled('SELECT ID FROM ITEMS');
    const scan = profileFor(result.profile.roots, PhysicalNodeType.TABLE_SCAN);

    expect(scan.chunks).toBeGreaterThan(0);
    expect(scan.invocations).toBe(1);
    expect(scan.actualRows).toBe(ROW_COUNT);
  });

  it('mirrors the executed physical tree', async () => {
    const result = await engine.runProfiled(`SELECT BUCKET, COUNT(*) AS N FROM ITEMS WHERE PRICE > ${PRICE_THRESHOLD} GROUP BY BUCKET`);

    expect(result.profile.roots).toHaveLength(1);

    const root = result.profile.roots[0];
    expect(root.profile.node.type).toBe(PhysicalNodeType.PROJECT);
    expect(root.profile.actualRows).toBe(result.rows.length);

    const types = flattenProfile(result.profile.roots).map(entry => entry.node.type);
    expect(types).toContain(PhysicalNodeType.FILTER);
    expect(types).toContain(PhysicalNodeType.TABLE_SCAN);
  });

  it('times the output window of each operator inside the run', async () => {
    const result = await engine.runProfiled('SELECT ID FROM ITEMS');
    const scan = profileFor(result.profile.roots, PhysicalNodeType.TABLE_SCAN);

    expect(scan.firstOutputMs).not.toBeNull();
    expect(scan.lastOutputMs).toBeGreaterThanOrEqual(scan.firstOutputMs);
    expect(result.profile.totalMs).toBeGreaterThanOrEqual(scan.lastOutputMs);
  });

  it('stays off unless a run asks for it', async () => {
    const plain = await engine.run('SELECT ID FROM ITEMS');

    expect(plain.rows).toHaveLength(ROW_COUNT);
    expect(engine.executor.profiler).toBeNull();
  });

  it('clears the profiler when the run throws', async () => {
    await expect(engine.runProfiled('SELECT ID FROM MISSING_TABLE')).rejects.toThrow();

    expect(engine.executor.profiler).toBeNull();
  });

  it('renders actual counts beside estimates', async () => {
    const result = await engine.runProfiled(`SELECT ID FROM ITEMS WHERE PRICE > ${PRICE_THRESHOLD}`);
    const text = profileToString(result.profile);

    expect(text).toContain(`${PhysicalNodeType.TABLE_SCAN} est=${ROW_COUNT} actual=${ROW_COUNT}`);
    expect(text).toContain(`actual=${countItems(item => item.PRICE > PRICE_THRESHOLD)}`);
  });

  it('reports EXPLAIN ANALYZE with per-operator actuals', async () => {
    const result = await engine.run(`EXPLAIN ANALYZE SELECT ID FROM ITEMS WHERE PRICE > ${PRICE_THRESHOLD}`);
    const text = result.rows[0].EXPLAIN_ANALYZE;

    expect(text).toContain('Execution Time');
    expect(text).toContain(`actual=${ROW_COUNT}`);
    expect(text).toContain(`Rows Returned: ${countItems(item => item.PRICE > PRICE_THRESHOLD)}`);
  });
});

describe('estimate error', () => {
  const entry = (estimatedRows, actualRows) => ({
    node: null,
    estimatedRows,
    actualRows,
    chunks: 0,
    invocations: 0,
    firstOutputMs: null,
    lastOutputMs: null,
  });

  it('names an estimate that was too low', () => {
    expect(biasOf(entry(100, 900))).toBe('under');
    expect(estimateLabel(entry(100, 900))).toBe('9.0x under');
  });

  it('names an estimate that was too high', () => {
    expect(biasOf(entry(900, 100))).toBe('over');
    expect(estimateLabel(entry(900, 100))).toBe('9.0x over');
  });

  it('treats a matching estimate as on target', () => {
    expect(biasOf(entry(42, 42))).toBe('exact');
    expect(estimateLabel(entry(42, 42))).toBe('on target');
  });

  it('floors both sides at one row so an empty operator stays comparable', () => {
    expect(estimateLabel(entry(0, 0))).toBe('on target');
    expect(estimateLabel(entry(50, 0))).toBe('50.0x over');
  });
});
