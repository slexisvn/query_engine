import { describe, it, expect, vi } from 'vitest';
import { MorselSource, Morsel } from '../../src/parallel/morsel-source.js';

function mockTable(pageCount, rowCount = 1000) {
  return {
    pageIds: Array.from({ length: pageCount }, (_, i) => i),
    rowCount: () => rowCount,
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Morsel', () => {
  it('tracks page range metadata', () => {
    const m = new Morsel([0, 1, 2], 0, 3, 10);
    expect(m.pageCount()).toBe(3);
    expect(m.isLast()).toBe(false);
  });

  it('isLast returns true when at end', () => {
    const m = new Morsel([8, 9], 8, 10, 10);
    expect(m.isLast()).toBe(true);
  });

  it('stores pageIds slice', () => {
    const m = new Morsel([3, 4, 5], 3, 6, 12);
    expect(m.pageIds).toEqual([3, 4, 5]);
    expect(m.startPageIndex).toBe(3);
    expect(m.endPageIndex).toBe(6);
    expect(m.totalPages).toBe(12);
  });
});

describe('MorselSource', () => {
  it('partitions table into morsels', () => {
    const table = mockTable(10);
    const source = new MorselSource(table, 3);

    const morsels = [...source.partition()];
    expect(morsels.length).toBe(4);
    expect(morsels[0].pageIds).toEqual([0, 1, 2]);
    expect(morsels[1].pageIds).toEqual([3, 4, 5]);
    expect(morsels[2].pageIds).toEqual([6, 7, 8]);
    expect(morsels[3].pageIds).toEqual([9]);
  });

  it('last morsel is marked correctly', () => {
    const table = mockTable(6);
    const source = new MorselSource(table, 3);

    const morsels = [...source.partition()];
    expect(morsels[morsels.length - 1].isLast()).toBe(true);
    expect(morsels[0].isLast()).toBe(false);
  });

  it('morselCount returns correct count', () => {
    const table = mockTable(10);
    const source = new MorselSource(table, 3);
    expect(source.morselCount()).toBe(4);
  });

  it('morselCount is 1 when morselPageCount >= totalPages', () => {
    const table = mockTable(5);
    const source = new MorselSource(table, 10);
    expect(source.morselCount()).toBe(1);
  });

  it('estimatedRows delegates to table rowCount', () => {
    const table = mockTable(10, 5000);
    const source = new MorselSource(table);
    expect(source.estimatedRows()).toBe(5000);
  });

  it('prepare calls table.flush', async () => {
    const table = mockTable(4);
    const source = new MorselSource(table, 2);

    await source.prepare();
    expect(table.flush).toHaveBeenCalledOnce();
  });

  it('handles single page table', () => {
    const table = mockTable(1);
    const source = new MorselSource(table, 5);

    const morsels = [...source.partition()];
    expect(morsels.length).toBe(1);
    expect(morsels[0].pageIds).toEqual([0]);
    expect(morsels[0].isLast()).toBe(true);
  });

  it('handles empty table with zero pages', () => {
    const table = mockTable(0, 0);
    const source = new MorselSource(table, 5);

    const morsels = [...source.partition()];
    expect(morsels.length).toBe(0);
    expect(source.morselCount()).toBe(0);
  });

  it('each morsel covers disjoint page ranges', () => {
    const table = mockTable(20);
    const source = new MorselSource(table, 4);

    const morsels = [...source.partition()];
    const allPageIds = morsels.flatMap(m => m.pageIds);
    const uniqueIds = new Set(allPageIds);

    expect(allPageIds.length).toBe(20);
    expect(uniqueIds.size).toBe(20);
  });

  it('morsels cover all pages without gaps', () => {
    const table = mockTable(15);
    const source = new MorselSource(table, 4);

    const morsels = [...source.partition()];
    const allPageIds = morsels.flatMap(m => m.pageIds);
    const sorted = [...allPageIds].sort((a, b) => a - b);

    expect(sorted).toEqual(Array.from({ length: 15 }, (_, i) => i));
  });

  it('morselPageCount of 1 produces one morsel per page', () => {
    const table = mockTable(5);
    const source = new MorselSource(table, 1);

    const morsels = [...source.partition()];
    expect(morsels.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(morsels[i].pageIds).toEqual([i]);
    }
  });

  it('morselPageCount of Infinity produces single morsel', () => {
    const table = mockTable(10);
    const source = new MorselSource(table, Infinity);

    const morsels = [...source.partition()];
    expect(morsels.length).toBe(1);
    expect(morsels[0].pageIds.length).toBe(10);
  });
});
