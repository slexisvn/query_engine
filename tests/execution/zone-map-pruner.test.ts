import { describe, it, expect } from 'vitest';
import { compileChunkPruner, schemaColumnResolver } from '../../src/execution/zone-map-pruner.js';
import {
  BoundBetween,
  BoundBinary,
  BoundColumnRef,
  BoundInList,
  BoundIsNull,
  BoundLike,
  BoundLiteral,
  BoundUnary,
} from '../../src/binder/expression-binder.js';
import { DataType } from '../../src/storage/data-type.js';

const SCHEMA = [
  { name: 'ID', dataType: DataType.INT32 },
  { name: 'NAME', dataType: DataType.VARCHAR },
  { name: 'FLAG', dataType: DataType.BOOLEAN },
];

const resolver = schemaColumnResolver(SCHEMA, 'T');

function zone(range, hasNulls) {
  return { range, hasNulls };
}

function zoneMap(columns, rowCount = 100) {
  return { rowCount, columns };
}

function idZoneMap(min, max, hasNulls = false) {
  return zoneMap([zone({ min, max }, hasNulls), zone({ min: 'a', max: 'z' }, false), zone(null, false)]);
}

function nameZoneMap(min, max, hasNulls = false) {
  return zoneMap([zone({ min: 0, max: 0 }, false), zone({ min, max }, hasNulls), zone(null, false)]);
}

const id = BoundColumnRef('T', 'ID', 0, DataType.INT32);
const name = BoundColumnRef('T', 'NAME', 1, DataType.VARCHAR);
const flag = BoundColumnRef('T', 'FLAG', 2, DataType.BOOLEAN);

function num(value) {
  return BoundLiteral(value, DataType.INT32);
}

function text(value) {
  return BoundLiteral(value, DataType.VARCHAR);
}

function compare(op, left, right) {
  return BoundBinary(op, left, right, DataType.BOOLEAN);
}

function prunerFor(predicate) {
  return compileChunkPruner(predicate, resolver);
}

function skips(predicate, map) {
  const pruner = prunerFor(predicate);
  expect(pruner).not.toBeNull();
  return pruner.canSkip(map);
}

describe('compileChunkPruner comparison leaves', () => {
  it('skips a chunk whose range excludes an equality literal', () => {
    expect(skips(compare('=', id, num(42)), idZoneMap(100, 200))).toBe(true);
  });

  it('keeps a chunk whose range brackets an equality literal', () => {
    expect(skips(compare('=', id, num(150)), idZoneMap(100, 200))).toBe(false);
  });

  it('skips on the boundaries of the ordering predicates', () => {
    expect(skips(compare('<', id, num(100)), idZoneMap(100, 200))).toBe(true);
    expect(skips(compare('<=', id, num(100)), idZoneMap(100, 200))).toBe(false);
    expect(skips(compare('>', id, num(200)), idZoneMap(100, 200))).toBe(true);
    expect(skips(compare('>=', id, num(200)), idZoneMap(100, 200))).toBe(false);
  });

  it('flips the operator when the literal is on the left', () => {
    expect(skips(compare('>', num(100), id), idZoneMap(100, 200))).toBe(true);
    expect(skips(compare('<', num(200), id), idZoneMap(100, 200))).toBe(true);
  });

  it('skips a BETWEEN range that misses the chunk entirely', () => {
    expect(skips(BoundBetween(id, num(0), num(50), false), idZoneMap(100, 200))).toBe(true);
    expect(skips(BoundBetween(id, num(150), num(400), false), idZoneMap(100, 200))).toBe(false);
  });

  it('skips NOT BETWEEN only when the chunk sits wholly inside the range', () => {
    expect(skips(BoundBetween(id, num(0), num(500), true), idZoneMap(100, 200))).toBe(true);
    expect(skips(BoundBetween(id, num(150), num(500), true), idZoneMap(100, 200))).toBe(false);
  });

  it('declines to prune when the literal and the range are different value domains', () => {
    expect(skips(compare('=', id, text('apple')), idZoneMap(100, 200))).toBe(false);
    expect(skips(compare('>', name, num(5)), nameZoneMap('a', 'b'))).toBe(false);
  });

  it('declines to prune a comparison against NULL', () => {
    expect(prunerFor(compare('=', id, BoundLiteral(null, DataType.INT32)))).toBeNull();
  });
});

describe('compileChunkPruner NULL handling', () => {
  it('skips a chunk with no NULLs for IS NULL', () => {
    expect(skips(BoundIsNull(id, false), idZoneMap(100, 200, false))).toBe(true);
  });

  it('keeps a chunk containing NULLs for IS NULL', () => {
    expect(skips(BoundIsNull(id, false), idZoneMap(100, 200, true))).toBe(false);
  });

  it('skips an all-NULL column for IS NOT NULL and keeps it for IS NULL', () => {
    const allNull = zoneMap([zone(null, true), zone({ min: 'a', max: 'z' }, false), zone(null, false)]);
    expect(skips(BoundIsNull(id, true), allNull)).toBe(true);
    expect(skips(BoundIsNull(id, false), allNull)).toBe(false);
  });

  it('skips every predicate shape on a chunk whose column holds only NULLs', () => {
    const allNull = zoneMap([zone(null, true), zone({ min: 'a', max: 'z' }, false), zone(null, false)]);
    expect(skips(compare('=', id, num(1)), allNull)).toBe(true);
    expect(skips(compare('>', id, num(1)), allNull)).toBe(true);
    expect(skips(BoundBetween(id, num(0), num(9), false), allNull)).toBe(true);
    expect(skips(BoundInList(id, [num(1), num(2)], false), allNull)).toBe(true);
  });

  it('skips a chunk with no rows at all', () => {
    const empty = zoneMap([zone(null, false), zone(null, false), zone(null, false)], 0);
    expect(skips(compare('=', id, num(1)), empty)).toBe(true);
    expect(skips(BoundIsNull(id, false), empty)).toBe(true);
    expect(skips(BoundIsNull(id, true), empty)).toBe(true);
  });

  it('skips a chunk with no rows even when a branch of the predicate is opaque', () => {
    const empty = zoneMap([zone(null, false), zone(null, false), zone(null, false)], 0);
    const opaque = compare('=', id, BoundColumnRef('OTHER', 'X', 0, DataType.INT32));
    const either = compare('OR', compare('=', id, num(1)), opaque);
    expect(skips(either, empty)).toBe(true);
    expect(skips(either, idZoneMap(100, 200))).toBe(false);
  });

  it('keeps a NULL-bearing chunk under NOT even though its range excludes the literal', () => {
    const withNulls = idZoneMap(100, 200, true);
    expect(skips(compare('>', id, num(500)), withNulls)).toBe(true);
    expect(skips(BoundUnary('NOT', compare('>', id, num(500)), DataType.BOOLEAN), withNulls)).toBe(false);
  });

  it('skips under NOT when the chunk has no NULLs to keep the result unknown', () => {
    const noNulls = idZoneMap(100, 200, false);
    expect(skips(BoundUnary('NOT', compare('>=', id, num(100)), DataType.BOOLEAN), noNulls)).toBe(true);
  });

  it('keeps a NULL-bearing chunk when an OR branch turns those NULLs into matches', () => {
    const orExpr = compare('OR', compare('>', id, num(500)), BoundIsNull(id, false));
    expect(skips(orExpr, idZoneMap(100, 200, true))).toBe(false);
    expect(skips(orExpr, idZoneMap(100, 200, false))).toBe(true);
  });

  it('skips an OR whose branches can only be FALSE or UNKNOWN, since WHERE drops both', () => {
    const orExpr = compare('OR', compare('>', id, num(500)), compare('<', id, num(0)));
    expect(skips(orExpr, idZoneMap(100, 200, true))).toBe(true);
  });
});

describe('compileChunkPruner logical composition', () => {
  it('skips an AND when either side is impossible', () => {
    const both = compare('AND', compare('>', id, num(150)), compare('<', id, num(50)));
    expect(skips(both, idZoneMap(100, 200))).toBe(true);
  });

  it('keeps an AND when both sides are possible', () => {
    const both = compare('AND', compare('>', id, num(150)), compare('<', id, num(190)));
    expect(skips(both, idZoneMap(100, 200))).toBe(false);
  });

  it('skips an OR only when both branches are impossible', () => {
    const either = compare('OR', compare('>', id, num(500)), compare('<', id, num(10)));
    expect(skips(either, idZoneMap(100, 200))).toBe(true);
    expect(skips(compare('OR', compare('>', id, num(500)), compare('<', id, num(150))), idZoneMap(100, 200))).toBe(false);
  });

  it('still prunes on the analysable half of an AND with an opaque half', () => {
    const opaque = compare('=', id, BoundColumnRef('OTHER', 'X', 0, DataType.INT32));
    const mixed = compare('AND', opaque, compare('>', id, num(500)));
    expect(skips(mixed, idZoneMap(100, 200))).toBe(true);
  });

  it('never prunes an OR with an opaque branch', () => {
    const opaque = compare('=', id, BoundColumnRef('OTHER', 'X', 0, DataType.INT32));
    const mixed = compare('OR', opaque, compare('>', id, num(500)));
    expect(skips(mixed, idZoneMap(100, 200))).toBe(false);
  });
});

describe('compileChunkPruner IN and <>', () => {
  it('skips when no IN literal falls inside the range', () => {
    expect(skips(BoundInList(id, [num(1), num(2), num(3)], false), idZoneMap(100, 200))).toBe(true);
  });

  it('keeps when one IN literal falls inside the range', () => {
    expect(skips(BoundInList(id, [num(1), num(150)], false), idZoneMap(100, 200))).toBe(false);
  });

  it('skips NOT IN only when the chunk is a constant the list covers', () => {
    expect(skips(BoundInList(id, [num(5)], true), idZoneMap(5, 5))).toBe(true);
    expect(skips(BoundInList(id, [num(5)], true), idZoneMap(5, 5, true))).toBe(true);
    expect(skips(BoundInList(id, [num(5)], true), idZoneMap(5, 6))).toBe(false);
    expect(skips(BoundInList(id, [num(5)], true), idZoneMap(5, 6, true))).toBe(false);
  });

  it('declines to prune an IN list holding a non-literal', () => {
    expect(prunerFor(BoundInList(id, [num(1), BoundColumnRef('T', 'ID', 0, DataType.INT32)], false))).toBeNull();
  });

  it('skips NOT IN over a list holding NULL, which can never be TRUE', () => {
    const notIn = BoundInList(id, [num(5), BoundLiteral(null, DataType.INT32)], true);
    expect(skips(notIn, idZoneMap(100, 200))).toBe(true);
    expect(skips(notIn, idZoneMap(1, 10))).toBe(true);
  });

  it('keeps IN over a list holding NULL when a real literal falls in the range', () => {
    const inList = BoundInList(id, [num(150), BoundLiteral(null, DataType.INT32)], false);
    expect(skips(inList, idZoneMap(100, 200))).toBe(false);
    expect(skips(BoundInList(id, [num(5), BoundLiteral(null, DataType.INT32)], false), idZoneMap(100, 200))).toBe(true);
  });

  it('skips <> only when the chunk is the constant being excluded', () => {
    expect(skips(compare('<>', id, num(5)), idZoneMap(5, 5))).toBe(true);
    expect(skips(compare('<>', id, num(5)), idZoneMap(5, 5, true))).toBe(true);
    expect(skips(compare('<>', id, num(5)), idZoneMap(5, 6))).toBe(false);
    expect(skips(compare('<>', id, num(5)), idZoneMap(4, 5))).toBe(false);
  });
});

describe('compileChunkPruner LIKE', () => {
  it('skips a chunk whose string range cannot hold the pattern prefix', () => {
    expect(skips(BoundLike(name, text('zebra%'), false), nameZoneMap('apple', 'banana'))).toBe(true);
    expect(skips(BoundLike(name, text('ba%'), false), nameZoneMap('apple', 'banana'))).toBe(false);
  });

  it('keeps a chunk whose range straddles the prefix bound', () => {
    expect(skips(BoundLike(name, text('b%'), false), nameZoneMap('apple', 'car'))).toBe(false);
  });

  it('declines to prune a pattern that starts with a wildcard', () => {
    expect(prunerFor(BoundLike(name, text('%zebra'), false))).toBeNull();
    expect(prunerFor(BoundLike(name, text('_ebra'), false))).toBeNull();
  });

  it('never prunes NOT LIKE, since a non-matching value is always possible', () => {
    expect(skips(BoundLike(name, text('zebra%'), true), nameZoneMap('apple', 'banana'))).toBe(false);
  });

  it('declines to prune LIKE against a non-string range', () => {
    expect(skips(BoundLike(id, text('1%'), false), idZoneMap(100, 200))).toBe(false);
  });
});

describe('compileChunkPruner opaque predicates', () => {
  it('returns no pruner when nothing in the predicate is analysable', () => {
    expect(prunerFor(compare('=', BoundColumnRef('T', 'MISSING', 0, DataType.INT32), num(1)))).toBeNull();
    expect(prunerFor(compare('=', BoundColumnRef('OTHER', 'ID', 0, DataType.INT32), num(1)))).toBeNull();
    expect(prunerFor(compare('+', id, num(1)))).toBeNull();
    expect(prunerFor(id)).toBeNull();
    expect(prunerFor(null)).toBeNull();
  });

  it('returns no pruner for a correlated column reference', () => {
    const correlated = BoundColumnRef('T', 'ID', 0, DataType.INT32, 1);
    expect(prunerFor(compare('=', correlated, num(1)))).toBeNull();
  });

  it('keeps a chunk when the summary has no entry for the column', () => {
    const short = zoneMap([zone({ min: 100, max: 200 }, false)]);
    expect(skips(compare('=', flag, BoundLiteral(true, DataType.BOOLEAN)), short)).toBe(false);
  });

  it('resolves an unqualified column reference against the scan schema', () => {
    const unqualified = BoundColumnRef('', 'ID', 0, DataType.INT32);
    expect(skips(compare('>', unqualified, num(500)), idZoneMap(100, 200))).toBe(true);
  });
});
