import { describe, it, expect } from 'vitest';
import { COLUMN_ENCODERS, encoderForId, encoderForKind } from '../../../src/storage/encoding/registry.js';
import { EncodingKind } from '../../../src/storage/encoding/encoding-types.js';

describe('column encoding registry', () => {
  it('registers every declared encoding kind', () => {
    expect([...COLUMN_ENCODERS.keys()].sort()).toEqual(Object.values(EncodingKind).sort());
  });

  it('keys each encoder by its own kind', () => {
    for (const [kind, encoder] of COLUMN_ENCODERS) {
      expect(encoder.kind).toBe(kind);
    }
  });

  it('gives every encoding a distinct wire id', () => {
    const ids = [...COLUMN_ENCODERS.values()].map(encoder => encoder.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves an encoder from its wire id back to the same object', () => {
    for (const encoder of COLUMN_ENCODERS.values()) {
      expect(encoderForId(encoder.id)).toBe(encoder);
      expect(encoderForKind(encoder.kind)).toBe(encoder);
    }
  });

  it('rejects an unknown kind', () => {
    expect(() => encoderForKind('NOT_AN_ENCODING')).toThrow(/Unknown column encoding/);
  });

  it('rejects an unknown wire id', () => {
    expect(() => encoderForId(200)).toThrow(/Unknown column encoding id/);
  });
});
