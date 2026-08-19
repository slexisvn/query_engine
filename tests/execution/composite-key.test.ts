import { describe, it, expect } from 'vitest';
import { encodeCompositeKey } from '../../src/execution/composite-key.js';

describe('encodeCompositeKey', () => {
  it('gives equal tuples the same key', () => {
    expect(encodeCompositeKey(['a', 1, true])).toBe(encodeCompositeKey(['a', 1, true]));
  });

  it('separates tuples that differ only in where a value boundary falls', () => {
    expect(encodeCompositeKey(['a|b', 'c'])).not.toBe(encodeCompositeKey(['a', 'b|c']));
    expect(encodeCompositeKey(['ab', 'c'])).not.toBe(encodeCompositeKey(['a', 'bc']));
    expect(encodeCompositeKey(['', 'ab'])).not.toBe(encodeCompositeKey(['a', 'b']));
  });

  it('separates a null from the text that spells it', () => {
    expect(encodeCompositeKey([null, 'x'])).not.toBe(encodeCompositeKey(['null', 'x']));
    expect(encodeCompositeKey([null, 'x'])).not.toBe(encodeCompositeKey(['', 'x']));
  });

  it('treats undefined as null', () => {
    expect(encodeCompositeKey([undefined, 'x'])).toBe(encodeCompositeKey([null, 'x']));
  });

  it('separates values that share a text form but not a type', () => {
    expect(encodeCompositeKey([1])).not.toBe(encodeCompositeKey(['1']));
    expect(encodeCompositeKey([true])).not.toBe(encodeCompositeKey(['true']));
    expect(encodeCompositeKey([1n])).not.toBe(encodeCompositeKey(['1']));
  });

  it('separates tuples of different arity that share a prefix', () => {
    expect(encodeCompositeKey(['a'])).not.toBe(encodeCompositeKey(['a', 'b']));
    expect(encodeCompositeKey(['a'])).not.toBe(encodeCompositeKey(['a', null]));
  });

  it('assigns a distinct key to every distinct tuple in a colliding corpus', () => {
    const parts = ['', '|', 'a', 'a|', '|a', 'null', 'n', '1', '2:', ':'];
    const tuples: unknown[][] = [];
    for (const left of parts) {
      for (const right of parts) tuples.push([left, right]);
    }
    const keys = new Set(tuples.map(tuple => encodeCompositeKey(tuple as never)));
    expect(keys.size).toBe(tuples.length);
  });

  it('encodes the empty tuple', () => {
    expect(encodeCompositeKey([])).toBe('');
  });
});
