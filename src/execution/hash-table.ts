import { hashValue } from '../utils/hash.js';
import type { ColumnValue } from '../storage/data-type.js';
import type { EvalValue } from './execution-types.js';

export const NO_ENTRY = -1;

const EMPTY_SLOT = -1;
const INITIAL_SLOT_COUNT = 64;
const MAX_LOAD_NUMERATOR = 7;
const MAX_LOAD_DENOMINATOR = 10;
const HASH_SEED = 0x811c9dc5;
const HASH_PRIME = 0x01000193;

const NAN_IDENTITY = Symbol('NaN');

type KeyIdentity = ColumnValue | symbol;

export function keyIdentityOf(value: EvalValue): KeyIdentity {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'number') {
    const numeric = value as number;
    if (Number.isSafeInteger(numeric)) return numeric;
    if (numeric !== numeric) return NAN_IDENTITY;
    return Number.isInteger(numeric) ? BigInt(numeric) : numeric;
  }
  if (type === 'bigint') {
    const asNumber = Number(value as bigint);
    return Number.isSafeInteger(asNumber) ? asNumber : (value as bigint);
  }
  return type === 'string' || type === 'boolean' ? (value as ColumnValue) : String(value);
}

function identityHash(identity: KeyIdentity): number {
  if (typeof identity === 'number' && (identity | 0) === identity) {
    const mixed = Math.imul(identity ^ (identity >>> 15), 0x85ebca6b);
    return (mixed ^ (mixed >>> 13)) >>> 0;
  }
  return hashValue(typeof identity === 'symbol' ? null : identity);
}

function mixIdentity(hash: number, identity: KeyIdentity): number {
  return Math.imul(hash ^ identityHash(identity), HASH_PRIME);
}

const NULL_TEXT = 'n';
const LENGTH_TERMINATOR = ':';

const IDENTITY_TEXT_TAGS: Record<string, string> = {
  number: 'd',
  bigint: 'd',
  string: 's',
  boolean: 'b',
  symbol: 'f',
};

export function keyIdentityText(values: readonly EvalValue[], arity: number): string {
  let text = '';
  for (let col = 0; col < arity; col++) {
    const identity = keyIdentityOf(values[col]);
    if (identity === null) {
      text += NULL_TEXT;
      continue;
    }
    const body = typeof identity === 'symbol' ? 'NaN' : String(identity);
    text += IDENTITY_TEXT_TAGS[typeof identity] + body.length + LENGTH_TERMINATOR + body;
  }
  return text;
}

export function hashKeyValues(values: readonly EvalValue[], arity: number): number {
  let hash = HASH_SEED;
  for (let col = 0; col < arity; col++) hash = mixIdentity(hash, keyIdentityOf(values[col]));
  return hash >>> 0;
}

export interface KeyedHashTable {
  readonly arity: number;
  readonly size: number;
  hashOf(entry: number): number;
  keyAt(entry: number, col: number): ColumnValue;
  findOrInsert(values: readonly EvalValue[]): number;
  find(values: readonly EvalValue[]): number;
  clear(): void;
}

export function createKeyedHashTable(arity: number): KeyedHashTable {
  return arity === 1 ? new SingleKeyHashTable() : new OpenAddressingHashTable(arity);
}

class SingleKeyHashTable implements KeyedHashTable {
  readonly arity = 1;
  _entries: Map<KeyIdentity, number>;
  _hashes: number[];
  _originals: ColumnValue[];

  constructor() {
    this._entries = new Map();
    this._hashes = [];
    this._originals = [];
  }

  get size(): number {
    return this._entries.size;
  }

  hashOf(entry: number): number {
    return this._hashes[entry];
  }

  keyAt(entry: number): ColumnValue {
    return this._originals[entry];
  }

  findOrInsert(values: readonly EvalValue[]): number {
    const identity = keyIdentityOf(values[0]);
    const existing = this._entries.get(identity);
    if (existing !== undefined) return existing;
    const entry = this._entries.size;
    this._entries.set(identity, entry);
    this._hashes[entry] = identityHash(identity);
    this._originals[entry] = (values[0] ?? null) as ColumnValue;
    return entry;
  }

  find(values: readonly EvalValue[]): number {
    const entry = this._entries.get(keyIdentityOf(values[0]));
    return entry === undefined ? NO_ENTRY : entry;
  }

  clear(): void {
    this._entries.clear();
    this._hashes.length = 0;
    this._originals.length = 0;
  }
}

class OpenAddressingHashTable implements KeyedHashTable {
  readonly arity: number;
  _slots: Int32Array;
  _slotMask: number;
  _growAt: number;
  _hashes: Uint32Array;
  _identities: KeyIdentity[];
  _originals: ColumnValue[];
  _scratch: KeyIdentity[];
  _scratchHash: number;
  _size: number;

  constructor(arity: number) {
    this.arity = arity;
    this._slots = new Int32Array(INITIAL_SLOT_COUNT).fill(EMPTY_SLOT);
    this._slotMask = INITIAL_SLOT_COUNT - 1;
    this._growAt = loadLimit(INITIAL_SLOT_COUNT);
    this._hashes = new Uint32Array(INITIAL_SLOT_COUNT);
    this._identities = [];
    this._originals = [];
    this._scratch = new Array(arity);
    this._scratchHash = 0;
    this._size = 0;
  }

  get size(): number {
    return this._size;
  }

  hashOf(entry: number): number {
    return this._hashes[entry];
  }

  keyAt(entry: number, col: number): ColumnValue {
    return this._originals[entry * this.arity + col];
  }

  findOrInsert(values: readonly EvalValue[]): number {
    this._prepare(values);
    const hash = this._scratchHash;
    let slot = hash & this._slotMask;
    for (;;) {
      const entry = this._slots[slot];
      if (entry === EMPTY_SLOT) {
        const inserted = this._append(values, hash);
        this._slots[slot] = inserted;
        if (this._size >= this._growAt) this._growSlots();
        return inserted;
      }
      if (this._hashes[entry] === hash && this._matches(entry)) return entry;
      slot = (slot + 1) & this._slotMask;
    }
  }

  find(values: readonly EvalValue[]): number {
    this._prepare(values);
    const hash = this._scratchHash;
    let slot = hash & this._slotMask;
    for (;;) {
      const entry = this._slots[slot];
      if (entry === EMPTY_SLOT) return NO_ENTRY;
      if (this._hashes[entry] === hash && this._matches(entry)) return entry;
      slot = (slot + 1) & this._slotMask;
    }
  }

  clear(): void {
    this._slots.fill(EMPTY_SLOT);
    this._identities.length = 0;
    this._originals.length = 0;
    this._size = 0;
  }

  _prepare(values: readonly EvalValue[]): void {
    const arity = this.arity;
    const scratch = this._scratch;
    let hash = HASH_SEED;
    for (let col = 0; col < arity; col++) {
      const identity = keyIdentityOf(values[col]);
      scratch[col] = identity;
      hash = mixIdentity(hash, identity);
    }
    this._scratchHash = hash >>> 0;
  }

  _matches(entry: number): boolean {
    const arity = this.arity;
    const base = entry * arity;
    const identities = this._identities;
    const scratch = this._scratch;
    for (let col = 0; col < arity; col++) {
      if (identities[base + col] !== scratch[col]) return false;
    }
    return true;
  }

  _append(values: readonly EvalValue[], hash: number): number {
    const entry = this._size++;
    if (entry >= this._hashes.length) this._growEntries();
    this._hashes[entry] = hash;
    const arity = this.arity;
    const base = entry * arity;
    for (let col = 0; col < arity; col++) {
      this._identities[base + col] = this._scratch[col];
      this._originals[base + col] = (values[col] ?? null) as ColumnValue;
    }
    return entry;
  }

  _growEntries(): void {
    const grown = new Uint32Array(this._hashes.length * 2);
    grown.set(this._hashes);
    this._hashes = grown;
  }

  _growSlots(): void {
    const slotCount = this._slots.length * 2;
    this._slots = new Int32Array(slotCount).fill(EMPTY_SLOT);
    this._slotMask = slotCount - 1;
    this._growAt = loadLimit(slotCount);
    for (let entry = 0; entry < this._size; entry++) {
      let slot = this._hashes[entry] & this._slotMask;
      while (this._slots[slot] !== EMPTY_SLOT) slot = (slot + 1) & this._slotMask;
      this._slots[slot] = entry;
    }
  }
}

function loadLimit(slotCount: number): number {
  return Math.floor((slotCount * MAX_LOAD_NUMERATOR) / MAX_LOAD_DENOMINATOR);
}
