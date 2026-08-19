import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writePartialSpill, readPartialSpill } from '../../src/parallel/partial-spill.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe-partial-spill-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const fileIn = (name) => path.join(dir, name);

describe('partial spill file format', () => {
  it('round-trips partition partials with mixed key and state types', () => {
    const partitions = [
      [{ key: 'a', groupValues: ['a'], states: [3, { sum: 6, count: 2 }, null] }],
      [],
      [
        { key: 5, groupValues: [5], states: [1, { sum: -1.5, count: 1 }, -1.5] },
        { key: null, groupValues: [null], states: [0, { sum: 0, count: 0 }, null] },
      ],
      [{ key: 9n, groupValues: [9n], states: [2, { sum: 4, count: 2 }, 2] }],
    ];
    const file = fileIn('mixed.partials');
    writePartialSpill(file, partitions);

    expect(readPartialSpill(file, 0)).toEqual(partitions[0]);
    expect(readPartialSpill(file, 1)).toEqual([]);
    expect(readPartialSpill(file, 2)).toEqual(partitions[2]);
    expect(readPartialSpill(file, 3)).toEqual(partitions[3]);
  });

  it('reads a single partition without dragging in neighbours', () => {
    const big = Array.from({ length: 500 }, (_, i) => ({ key: `k${i}`, groupValues: [`k${i}`], states: [i] }));
    const partitions = [big, [{ key: 'lone', groupValues: ['lone'], states: [42] }]];
    const file = fileIn('seek.partials');
    writePartialSpill(file, partitions);
    expect(readPartialSpill(file, 1)).toEqual(partitions[1]);
    expect(readPartialSpill(file, 0).length).toBe(500);
  });

  it('returns empty for out-of-range partition indexes', () => {
    const file = fileIn('range.partials');
    writePartialSpill(file, [[{ key: 1, groupValues: [1], states: [1] }]]);
    expect(readPartialSpill(file, 5)).toEqual([]);
  });

  it('supports several files coexisting per flush', () => {
    const a = fileIn('flush0.partials');
    const b = fileIn('flush1.partials');
    writePartialSpill(a, [[{ key: 'x', groupValues: ['x'], states: [1] }]]);
    writePartialSpill(b, [[{ key: 'x', groupValues: ['x'], states: [2] }]]);
    expect(readPartialSpill(a, 0)[0].states[0]).toBe(1);
    expect(readPartialSpill(b, 0)[0].states[0]).toBe(2);
  });
});
