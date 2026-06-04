import { describe, it, expect, beforeAll } from 'vitest';
import {
  wasmFilterEqI32,
  wasmFilterLtI32,
  wasmFilterGtI32,
  wasmFilterBetweenI32,
  wasmSumF64,
} from '../../src/wasm/kernels/wasm-filter.js';

describe('WASM SIMD Filter', () => {
  it('filters equality on i32', async () => {
    const data = new Int32Array([1, 2, 3, 2, 5, 2, 7, 8]);
    const result = await wasmFilterEqI32(data, 2);
    expect(result.length).toBe(3);
    expect([...result]).toEqual([1, 3, 5]);
  });

  it('filters less-than on i32', async () => {
    const data = new Int32Array([10, 5, 3, 8, 1, 15]);
    const result = await wasmFilterLtI32(data, 6);
    expect(result.length).toBe(3);
    expect([...result]).toEqual([1, 2, 4]);
  });

  it('filters greater-than on i32', async () => {
    const data = new Int32Array([10, 5, 3, 8, 1, 15]);
    const result = await wasmFilterGtI32(data, 7);
    expect(result.length).toBe(3);
    expect([...result]).toEqual([0, 3, 5]);
  });

  it('filters between on i32', async () => {
    const data = new Int32Array([1, 5, 10, 3, 7, 15, 2, 8]);
    const result = await wasmFilterBetweenI32(data, 3, 8);
    expect(result.length).toBe(4);
    expect([...result]).toEqual([1, 3, 4, 7]);
  });

  it('handles empty result', async () => {
    const data = new Int32Array([1, 2, 3]);
    const result = await wasmFilterEqI32(data, 99);
    expect(result.length).toBe(0);
  });

  it('handles all matching', async () => {
    const data = new Int32Array([5, 5, 5, 5]);
    const result = await wasmFilterEqI32(data, 5);
    expect(result.length).toBe(4);
  });

  it('handles non-SIMD-aligned counts', async () => {
    const data = new Int32Array([1, 2, 3, 4, 5]);
    const result = await wasmFilterLtI32(data, 4);
    expect(result.length).toBe(3);
    expect([...result]).toEqual([0, 1, 2]);
  });

  it('handles large arrays', async () => {
    const size = 10000;
    const data = new Int32Array(size);
    for (let i = 0; i < size; i++) data[i] = i;
    const result = await wasmFilterLtI32(data, 100);
    expect(result.length).toBe(100);
  });
});

describe('WASM SIMD Aggregate', () => {
  it('computes sum of f64 array', async () => {
    const data = new Float64Array([1.0, 2.0, 3.0, 4.0, 5.0]);
    const sum = await wasmSumF64(data);
    expect(sum).toBeCloseTo(15.0);
  });

  it('computes sum of large f64 array', async () => {
    const size = 10000;
    const data = new Float64Array(size);
    let expected = 0;
    for (let i = 0; i < size; i++) {
      data[i] = i * 0.01;
      expected += data[i];
    }
    const sum = await wasmSumF64(data);
    expect(sum).toBeCloseTo(expected, 0);
  });

  it('handles odd-length arrays', async () => {
    const data = new Float64Array([10.5, 20.3, 30.7]);
    const sum = await wasmSumF64(data);
    expect(sum).toBeCloseTo(61.5);
  });
});
