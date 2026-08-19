import { describe, it, expect } from 'vitest';
import { RowMemoryBudget, rowByteWidth } from '../../src/execution/memory-budget.js';
import { DataType } from '../../src/storage/data-type.js';
import { Config } from '../../src/config.js';

describe('rowByteWidth', () => {
  it('charges the per-row overhead for an empty schema', () => {
    expect(rowByteWidth([])).toBe(Config.materializedRowOverheadBytes);
  });

  it('charges the per-row overhead when no schema is known', () => {
    expect(rowByteWidth(null)).toBe(Config.materializedRowOverheadBytes);
  });

  it('charges a wider row for a wider fixed-width column', () => {
    expect(rowByteWidth([DataType.INT64])).toBeGreaterThan(rowByteWidth([DataType.INT32]));
  });

  it('grows with the number of columns', () => {
    expect(rowByteWidth([DataType.INT32, DataType.INT32])).toBeGreaterThan(rowByteWidth([DataType.INT32]));
  });

  it('charges more for a variable-width column than for a narrow fixed one', () => {
    expect(rowByteWidth([DataType.VARCHAR])).toBeGreaterThan(rowByteWidth([DataType.BOOLEAN]));
  });

  it('separates a wide string row from a narrow integer row', () => {
    const narrow = rowByteWidth([DataType.INT32, DataType.INT32, DataType.INT32]);
    const wide = rowByteWidth([DataType.VARCHAR, DataType.VARCHAR, DataType.VARCHAR]);

    expect(wide).toBeGreaterThan(narrow);
  });
});

describe('RowMemoryBudget', () => {
  describe('accounting', () => {
    it('starts with nothing resident', () => {
      expect(new RowMemoryBudget().residentBytes).toBe(0);
    });

    it('starts below its limit', () => {
      expect(new RowMemoryBudget().exceeded).toBe(false);
    });

    it('accumulates admitted rows', () => {
      const budget = new RowMemoryBudget(1 << 20);
      budget.adoptSchema([DataType.INT32]);
      budget.admit(10);
      budget.admit(5);

      expect(budget.residentRows).toBe(15);
    });

    it('converts resident rows into bytes using the schema width', () => {
      const budget = new RowMemoryBudget(1 << 20);
      budget.adoptSchema([DataType.INT64]);
      budget.admit(4);

      expect(budget.residentBytes).toBe(4 * rowByteWidth([DataType.INT64]));
    });

    it('releases rows back to the budget', () => {
      const budget = new RowMemoryBudget(1 << 20);
      budget.adoptSchema([DataType.INT32]);
      budget.admit(10);
      budget.release(4);

      expect(budget.residentRows).toBe(6);
    });

    it('never drops below zero resident rows', () => {
      const budget = new RowMemoryBudget(1 << 20);
      budget.admit(2);
      budget.release(10);

      expect(budget.residentRows).toBe(0);
    });

    it('clears everything on reset', () => {
      const budget = new RowMemoryBudget(1 << 20);
      budget.admit(100);
      budget.reset();

      expect(budget.residentBytes).toBe(0);
    });
  });

  describe('limit', () => {
    it('reports exceeded once the byte limit is reached', () => {
      const budget = new RowMemoryBudget(rowByteWidth([DataType.INT32]) * 3);
      budget.adoptSchema([DataType.INT32]);
      budget.admit(3);

      expect(budget.exceeded).toBe(true);
    });

    it('stays within the limit just below the threshold', () => {
      const budget = new RowMemoryBudget(rowByteWidth([DataType.INT32]) * 3);
      budget.adoptSchema([DataType.INT32]);
      budget.admit(2);

      expect(budget.exceeded).toBe(false);
    });

    it('spills a wide-row workload sooner than a narrow-row one', () => {
      const limit = 1 << 16;
      const narrow = new RowMemoryBudget(limit);
      const wide = new RowMemoryBudget(limit);
      narrow.adoptSchema([DataType.INT32]);
      wide.adoptSchema([DataType.VARCHAR, DataType.VARCHAR, DataType.VARCHAR, DataType.VARCHAR]);

      expect(wide.rowCapacity).toBeLessThan(narrow.rowCapacity);
    });

    it('admits at least one row even under an absurdly small limit', () => {
      const budget = new RowMemoryBudget(1);
      budget.adoptSchema([DataType.VARCHAR]);

      expect(budget.rowCapacity).toBe(1);
    });

    it('recomputes capacity when the schema changes', () => {
      const budget = new RowMemoryBudget(1 << 16);
      budget.adoptSchema([DataType.INT32]);
      const narrowCapacity = budget.rowCapacity;
      budget.adoptSchema([DataType.VARCHAR, DataType.VARCHAR]);

      expect(budget.rowCapacity).toBeLessThan(narrowCapacity);
    });

    it('clears the exceeded flag after a reset', () => {
      const budget = new RowMemoryBudget(rowByteWidth([DataType.INT32]));
      budget.adoptSchema([DataType.INT32]);
      budget.admit(5);
      budget.reset();

      expect(budget.exceeded).toBe(false);
    });
  });
});
