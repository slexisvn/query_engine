import { describe, it, expect } from 'vitest';
import { createKeyedHashTable, keyIdentityOf, keyIdentityText, hashKeyValues, NO_ENTRY } from '../../src/execution/hash-table.js';

describe('createKeyedHashTable', () => {
  for (const arity of [1, 2]) {
    describe(`arity ${arity}`, () => {
      const pad = (first) => (arity === 1 ? [first] : [first, 'tail']);

      it('returns the same entry for a repeated key and a fresh one otherwise', () => {
        const table = createKeyedHashTable(arity);
        expect(table.findOrInsert(pad(7))).toBe(table.findOrInsert(pad(7)));
        expect(table.findOrInsert(pad(8))).not.toBe(table.findOrInsert(pad(7)));
        expect(table.size).toBe(2);
      });

      it('reports a miss rather than inserting', () => {
        const table = createKeyedHashTable(arity);
        expect(table.find(pad('absent'))).toBe(NO_ENTRY);
        expect(table.size).toBe(0);
      });

      it('treats a bigint and its exact numeric value as one key', () => {
        const table = createKeyedHashTable(arity);
        expect(table.findOrInsert(pad(5n))).toBe(table.findOrInsert(pad(5)));
      });

      it('keeps a number apart from its string form', () => {
        const table = createKeyedHashTable(arity);
        expect(table.findOrInsert(pad(5))).not.toBe(table.findOrInsert(pad('5')));
      });

      it('keeps a boolean apart from a number and a string', () => {
        const table = createKeyedHashTable(arity);
        const entries = [table.findOrInsert(pad(true)), table.findOrInsert(pad(1)), table.findOrInsert(pad('true'))];
        expect(new Set(entries).size).toBe(3);
      });

      it('groups nulls together and apart from the string "null"', () => {
        const table = createKeyedHashTable(arity);
        expect(table.findOrInsert(pad(null))).toBe(table.findOrInsert(pad(null)));
        expect(table.findOrInsert(pad(null))).not.toBe(table.findOrInsert(pad('null')));
      });

      it('groups NaN with itself the way a Map would', () => {
        const table = createKeyedHashTable(arity);
        expect(table.findOrInsert(pad(NaN))).toBe(table.findOrInsert(pad(NaN)));
      });

      it('keeps a bigint too large for a double apart from that same digit string', () => {
        const huge = 90071992547409910n;
        const table = createKeyedHashTable(arity);
        expect(table.findOrInsert(pad(huge))).not.toBe(table.findOrInsert(pad(huge.toString())));
        expect(table.findOrInsert(pad(huge))).toBe(table.findOrInsert(pad(huge)));
      });

      it('hands back the original value that was inserted', () => {
        const table = createKeyedHashTable(arity);
        const entry = table.findOrInsert(pad('kept'));
        expect(table.keyAt(entry, 0)).toBe('kept');
      });

      it('forgets everything after clear', () => {
        const table = createKeyedHashTable(arity);
        table.findOrInsert(pad(1));
        table.clear();
        expect(table.size).toBe(0);
        expect(table.find(pad(1))).toBe(NO_ENTRY);
      });

      it('keeps every distinct key separate well past its initial capacity', () => {
        const table = createKeyedHashTable(arity);
        const entries = new Set();
        for (let i = 0; i < 5000; i++) entries.add(table.findOrInsert(pad(i)));
        expect(entries.size).toBe(5000);
        expect(table.size).toBe(5000);
        for (let i = 0; i < 5000; i++) expect(table.keyAt(table.find(pad(i)), 0)).toBe(i);
      });
    });
  }

  it('separates tuples that differ only in which column holds the value', () => {
    const table = createKeyedHashTable(2);
    expect(table.findOrInsert(['a', 'b'])).not.toBe(table.findOrInsert(['b', 'a']));
  });

  it('does not let concatenation-style collisions merge distinct tuples', () => {
    const table = createKeyedHashTable(2);
    expect(table.findOrInsert(['ab', 'c'])).not.toBe(table.findOrInsert(['a', 'bc']));
  });

  it('collapses a zero-column key into a single entry', () => {
    const table = createKeyedHashTable(0);
    expect(table.findOrInsert([])).toBe(table.findOrInsert([]));
    expect(table.size).toBe(1);
  });

  it('reports a stable hash per entry for radix partitioning', () => {
    const table = createKeyedHashTable(2);
    const entry = table.findOrInsert([3, 'x']);
    expect(table.hashOf(entry)).toBe(hashKeyValues([3, 'x'], 2));
  });
});

describe('keyIdentityOf', () => {
  it('maps a bigint and its exact number to one identity', () => {
    expect(keyIdentityOf(5n)).toBe(keyIdentityOf(5));
  });

  it('keeps values of different types on different identities', () => {
    const identities = [keyIdentityOf(5), keyIdentityOf('5'), keyIdentityOf(true), keyIdentityOf(null)];
    expect(new Set(identities).size).toBe(4);
  });

  it('gives every NaN the same identity', () => {
    expect(keyIdentityOf(NaN)).toBe(keyIdentityOf(0 / 0));
  });

  it('treats an integer beyond double precision as its exact bigint', () => {
    expect(keyIdentityOf(2 ** 70)).toBe(keyIdentityOf(BigInt(2 ** 70)));
  });
});

describe('keyIdentityText', () => {
  const text = (values) => keyIdentityText(values, values.length);

  it('is stable for the same tuple', () => {
    expect(text(['a', 1, true])).toBe(text(['a', 1, true]));
  });

  it('does not let neighbouring parts run together', () => {
    expect(text(['a|b', 'c'])).not.toBe(text(['a', 'b|c']));
    expect(text(['ab', 'c'])).not.toBe(text(['a', 'bc']));
    expect(text(['', 'ab'])).not.toBe(text(['a', 'b']));
  });

  it('keeps a null apart from the string "null" and from an empty string', () => {
    expect(text([null, 'x'])).not.toBe(text(['null', 'x']));
    expect(text([null, 'x'])).not.toBe(text(['', 'x']));
  });

  it('treats undefined as null', () => {
    expect(text([undefined, 'x'])).toBe(text([null, 'x']));
  });

  it('keeps values of different types apart', () => {
    expect(text([1])).not.toBe(text(['1']));
    expect(text([true])).not.toBe(text(['true']));
    expect(text([1n])).not.toBe(text(['1']));
    expect(text([true])).not.toBe(text([1]));
    expect(text([false])).not.toBe(text([0]));
  });

  it('folds a bigint onto its exact numeric value', () => {
    expect(text([1n])).toBe(text([1]));
    expect(text([0n])).toBe(text([0]));
    expect(text([-7n, 'a'])).toBe(text([-7, 'a']));
  });

  it('keeps bigints apart beyond double precision', () => {
    expect(text([2n ** 53n + 1n])).not.toBe(text([2n ** 53n]));
  });

  it('keeps a shorter tuple apart from a longer one', () => {
    expect(text(['a'])).not.toBe(text(['a', 'b']));
    expect(text(['a'])).not.toBe(text(['a', null]));
  });

  it('agrees with the in-memory identity on which tuples are equal', () => {
    const tuples = [['a', 1], ['a', '1'], [1, 'a'], [null, 1], [1, null], ['a', 1n]];
    const table = createKeyedHashTable(2);
    for (const left of tuples) {
      for (const right of tuples) {
        const sameEntry = table.findOrInsert(left) === table.findOrInsert(right);
        expect(text(left) === text(right)).toBe(sameEntry);
      }
    }
  });

  it('encodes an empty tuple as an empty string', () => {
    expect(text([])).toBe('');
  });
});
