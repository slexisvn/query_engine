import { describe, it, expect } from 'vitest';
import { DFSchema, DFField, UnknownColumnError, AmbiguousColumnError } from '../../src/dataframe/schema.js';
import { DataType } from '../../src/storage/data-type.js';

function storage() {
  return [
    { name: 'id', dataType: DataType.INT32 },
    { name: 'name', dataType: DataType.VARCHAR },
  ];
}

describe('DFSchema', () => {
  it('builds from storage schema with an alias', () => {
    const schema = DFSchema.fromStorageSchema(storage(), 'T');
    expect(schema.names()).toEqual(['id', 'name']);
    expect(schema.field(0).tableAlias).toBe('T');
    expect(schema.field(1).index).toBe(1);
  });

  it('resolves by name and qualified name', () => {
    const schema = DFSchema.fromStorageSchema(storage(), 'T');
    expect(schema.resolve('id').index).toBe(0);
    expect(schema.resolve('NAME', 'T').dataType).toBe(DataType.VARCHAR);
  });

  it('throws on unknown and ambiguous columns', () => {
    const schema = DFSchema.fromStorageSchema(storage(), 'T');
    expect(() => schema.resolve('missing')).toThrow(UnknownColumnError);
    const ambiguous = new DFSchema([
      new DFField('x', DataType.INT32, 0, 'A'),
      new DFField('x', DataType.INT32, 1, 'B'),
    ]);
    expect(() => ambiguous.resolve('x')).toThrow(AmbiguousColumnError);
    expect(ambiguous.resolve('x', 'B').index).toBe(1);
  });

  it('projects with positional reindexing and empty alias', () => {
    const schema = DFSchema.fromStorageSchema(storage(), 'T');
    const projected = schema.project([
      { name: 'name', dataType: DataType.VARCHAR, tableAlias: '' },
    ]);
    expect(projected.field(0).index).toBe(0);
    expect(projected.field(0).tableAlias).toBe('');
  });

  it('drops columns and reindexes', () => {
    const schema = DFSchema.fromStorageSchema(storage(), 'T');
    const dropped = schema.drop(['id']);
    expect(dropped.names()).toEqual(['name']);
    expect(dropped.field(0).index).toBe(0);
  });

  it('appends two schemas preserving aliases', () => {
    const left = DFSchema.fromStorageSchema(storage(), 'L');
    const right = DFSchema.fromStorageSchema([{ name: 'score', dataType: DataType.INT32 }], 'R');
    const merged = left.append(right);
    expect(merged.length).toBe(3);
    expect(merged.field(2).tableAlias).toBe('R');
    expect(merged.field(2).index).toBe(2);
  });
});
