import { describe, it, expect } from 'vitest';
import { DataChunk } from '../../src/storage/chunk.js';
import { Column } from '../../src/storage/column.js';
import { DataType } from '../../src/storage/data-type.js';

function makeChunk(colDefs) {
  const size = colDefs[0].values.length;
  const cols = colDefs.map(({ type, values }) => {
    const col = new Column(type, values.length);
    for (let i = 0; i < values.length; i++) col.set(i, values[i]);
    col.length = values.length;
    return col;
  });
  return new DataChunk(cols, size);
}

describe('DataChunk', () => {
  describe('selectionVector', () => {
    it('getValue reads through selection vector indirection', () => {
      const chunk = makeChunk([
        { type: DataType.INT32, values: [10, 20, 30, 40, 50] },
        { type: DataType.FLOAT64, values: [1.1, 2.2, 3.3, 4.4, 5.5] },
      ]);
      chunk.setSelectionVector([4, 1, 3], 3);
      expect(chunk.getValue(0, 0)).toBe(50);
      expect(chunk.getValue(1, 0)).toBe(20);
      expect(chunk.getValue(2, 0)).toBe(40);
      expect(chunk.getValue(0, 1)).toBeCloseTo(5.5);
      expect(chunk.size).toBe(3);
    });

    it('toRows respects selection vector ordering', () => {
      const chunk = makeChunk([
        { type: DataType.INT32, values: [100, 200, 300] },
      ]);
      chunk.setSelectionVector([2, 0], 2);
      expect(chunk.toRows()).toEqual([[300], [100]]);
    });

    it('activeRowIndex returns physical index via SV', () => {
      const chunk = makeChunk([
        { type: DataType.INT32, values: [1, 2, 3, 4] },
      ]);
      chunk.setSelectionVector([3, 1, 0], 3);
      expect(chunk.activeRowIndex(0)).toBe(3);
      expect(chunk.activeRowIndex(1)).toBe(1);
      expect(chunk.activeRowIndex(2)).toBe(0);
    });

    it('activeRowIndex returns identity without SV', () => {
      const chunk = makeChunk([
        { type: DataType.INT32, values: [1, 2] },
      ]);
      expect(chunk.activeRowIndex(0)).toBe(0);
      expect(chunk.activeRowIndex(1)).toBe(1);
    });
  });

  describe('appendRow', () => {
    it('builds multi-column chunk row by row', () => {
      const schema = [
        { name: 'id', dataType: DataType.INT32 },
        { name: 'score', dataType: DataType.FLOAT64 },
      ];
      const chunk = DataChunk.fromSchema(schema, 16);
      chunk.appendRow([1, 9.5]);
      chunk.appendRow([2, 8.3]);
      chunk.appendRow([3, 7.1]);
      expect(chunk.size).toBe(3);
      const rows = chunk.toRows();
      expect(rows[0][0]).toBe(1);
      expect(rows[0][1]).toBeCloseTo(9.5);
      expect(rows[2][0]).toBe(3);
    });

    it('handles null values in appended rows', () => {
      const schema = [
        { name: 'a', dataType: DataType.INT32 },
        { name: 'b', dataType: DataType.INT32 },
      ];
      const chunk = DataChunk.fromSchema(schema, 16);
      chunk.appendRow([1, null]);
      chunk.appendRow([null, 2]);
      expect(chunk.getValue(0, 0)).toBe(1);
      expect(chunk.getValue(0, 1)).toBeNull();
      expect(chunk.getValue(1, 0)).toBeNull();
      expect(chunk.getValue(1, 1)).toBe(2);
    });
  });

  describe('project', () => {
    it('projects subset of columns preserving data', () => {
      const chunk = makeChunk([
        { type: DataType.INT32, values: [1, 2, 3] },
        { type: DataType.FLOAT64, values: [10.0, 20.0, 30.0] },
        { type: DataType.INT32, values: [100, 200, 300] },
      ]);
      const projected = chunk.project([2, 0]);
      expect(projected.columnCount()).toBe(2);
      expect(projected.getValue(0, 0)).toBe(100);
      expect(projected.getValue(0, 1)).toBe(1);
      expect(projected.getValue(2, 0)).toBe(300);
    });

    it('project + selectionVector compose correctly', () => {
      const chunk = makeChunk([
        { type: DataType.INT32, values: [10, 20, 30, 40] },
        { type: DataType.INT32, values: [100, 200, 300, 400] },
      ]);
      chunk.setSelectionVector([3, 1], 2);
      const projected = chunk.project([1]);
      expect(projected.size).toBe(2);
      expect(projected.getValue(0, 0)).toBe(400);
      expect(projected.getValue(1, 0)).toBe(200);
    });
  });

  describe('flatten', () => {
    it('materializes SV into new physical layout', () => {
      const chunk = makeChunk([
        { type: DataType.INT32, values: [10, 20, 30, 40, 50] },
        { type: DataType.INT32, values: [100, 200, 300, 400, 500] },
      ]);
      chunk.setSelectionVector([4, 0, 2], 3);
      const flat = chunk.flatten();
      expect(flat.selectionVector).toBeNull();
      expect(flat.size).toBe(3);
      expect(flat.getValue(0, 0)).toBe(50);
      expect(flat.getValue(0, 1)).toBe(500);
      expect(flat.getValue(1, 0)).toBe(10);
      expect(flat.getValue(2, 0)).toBe(30);
    });

    it('no-ops when no selection vector', () => {
      const chunk = makeChunk([{ type: DataType.INT32, values: [1, 2] }]);
      expect(chunk.flatten()).toBe(chunk);
    });
  });

  describe('toRows with nulls', () => {
    it('includes null values in output rows', () => {
      const chunk = makeChunk([
        { type: DataType.INT32, values: [1, null, 3] },
        { type: DataType.INT32, values: [null, 20, 30] },
      ]);
      const rows = chunk.toRows();
      expect(rows).toEqual([
        [1, null],
        [null, 20],
        [3, 30],
      ]);
    });
  });

  describe('reset and reuse', () => {
    it('chunk can be reset and reused for new data', () => {
      const schema = [
        { name: 'x', dataType: DataType.INT32 },
        { name: 'y', dataType: DataType.INT32 },
      ];
      const chunk = DataChunk.fromSchema(schema, 16);
      chunk.appendRow([1, 2]);
      chunk.appendRow([3, 4]);
      chunk.setSelectionVector([0], 1);
      expect(chunk.size).toBe(1);

      chunk.reset();
      expect(chunk.size).toBe(0);
      expect(chunk.selectionVector).toBeNull();

      chunk.appendRow([10, 20]);
      expect(chunk.size).toBe(1);
      expect(chunk.getValue(0, 0)).toBe(10);
      expect(chunk.getValue(0, 1)).toBe(20);
    });
  });
});
