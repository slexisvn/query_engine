import { describe, it, expect } from 'vitest';
import { combinedMappingOf } from '../../../src/execution/builders/builder-utils.js';
import { AMBIGUOUS_COLUMN, resolveColumnIndex, optionalColumnIndex, UNRESOLVED_COLUMN } from '../../../src/execution/column-resolve.js';
import { BoundColumnRef } from '../../../src/binder/expression-binder.js';

function input(alias, names) {
  return {
    schema: names.map(name => ({ name, tableAlias: alias })),
    columnMapping: new Map(),
  };
}

describe('combinedMappingOf', () => {
  it('maps qualified and bare names for a single input', () => {
    const mapping = combinedMappingOf(input('T', ['ID', 'NAME']));

    expect(mapping.get('T.ID')).toBe(0);
    expect(mapping.get('T.NAME')).toBe(1);
    expect(mapping.get('ID')).toBe(0);
    expect(mapping.get('NAME')).toBe(1);
  });

  it('offsets the second input by the width of the first', () => {
    const mapping = combinedMappingOf(input('A', ['X']), input('B', ['Y', 'Z']));

    expect(mapping.get('A.X')).toBe(0);
    expect(mapping.get('B.Y')).toBe(1);
    expect(mapping.get('B.Z')).toBe(2);
  });

  it('marks a bare name carried by both inputs as ambiguous', () => {
    const mapping = combinedMappingOf(input('A', ['ID']), input('B', ['ID']));

    expect(mapping.get('A.ID')).toBe(0);
    expect(mapping.get('B.ID')).toBe(1);
    expect(mapping.get('ID')).toBe(AMBIGUOUS_COLUMN);
  });

  it('keeps first-wins for a name repeated inside one input', () => {
    const mapping = combinedMappingOf(input('A', ['ID', 'ID']));

    expect(mapping.get('ID')).toBe(0);
  });
});

describe('resolving against an ambiguous mapping', () => {
  const mapping = combinedMappingOf(input('A', ['ID']), input('B', ['ID']));

  it('still resolves a qualified reference', () => {
    expect(resolveColumnIndex(BoundColumnRef('B', 'ID', 0, null), mapping)).toBe(1);
  });

  it('rejects an unqualified reference instead of guessing', () => {
    expect(() => resolveColumnIndex(BoundColumnRef('', 'ID', 0, null), mapping))
      .toThrow(/Ambiguous reference column ID/);
  });

  it('declines the optional lookup rather than returning a wrong column', () => {
    expect(optionalColumnIndex(BoundColumnRef('', 'ID', 0, null), mapping)).toBe(UNRESOLVED_COLUMN);
  });
});
