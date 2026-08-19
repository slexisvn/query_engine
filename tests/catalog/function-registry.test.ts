import { FunctionRegistry, FunctionType, defaultFunctionRegistry } from '../../src/catalog/function-registry.js';

describe('FunctionRegistry', () => {
  describe('builtin registration', () => {
    it('registers all aggregate functions', () => {
      const reg = new FunctionRegistry();
      for (const name of ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX', 'COUNT_STAR']) {
        expect(reg.has(name)).toBe(true);
        expect(reg.lookup(name).type).toBe(FunctionType.AGGREGATE);
      }
    });

    it('registers all scalar functions', () => {
      const reg = new FunctionRegistry();
      for (const name of ['SUBSTRING', 'EXTRACT', 'TRIM', 'UPPER', 'LOWER', 'CAST', 'COALESCE', 'NULLIF', 'ABS', 'ROUND']) {
        expect(reg.has(name)).toBe(true);
        expect(reg.lookup(name).type).toBe(FunctionType.SCALAR);
      }
    });

    it('stores correct arg counts for aggregates', () => {
      const reg = new FunctionRegistry();
      const count = reg.lookup('COUNT');
      expect(count.minArgs).toBe(0);
      expect(count.maxArgs).toBe(1);

      const sum = reg.lookup('SUM');
      expect(sum.minArgs).toBe(1);
      expect(sum.maxArgs).toBe(1);

      const countStar = reg.lookup('COUNT_STAR');
      expect(countStar.minArgs).toBe(0);
      expect(countStar.maxArgs).toBe(0);
    });

    it('stores correct arg counts for scalars', () => {
      const reg = new FunctionRegistry();
      expect(reg.lookup('SUBSTRING').minArgs).toBe(2);
      expect(reg.lookup('SUBSTRING').maxArgs).toBe(3);

      expect(reg.lookup('COALESCE').minArgs).toBe(1);
      expect(reg.lookup('COALESCE').maxArgs).toBe(Infinity);

      expect(reg.lookup('ROUND').minArgs).toBe(1);
      expect(reg.lookup('ROUND').maxArgs).toBe(2);

      expect(reg.lookup('ABS').minArgs).toBe(1);
      expect(reg.lookup('ABS').maxArgs).toBe(1);
    });
  });

  describe('lookup', () => {
    it('is case-insensitive', () => {
      const reg = new FunctionRegistry();
      expect(reg.lookup('sum')).not.toBeNull();
      expect(reg.lookup('Sum')).not.toBeNull();
      expect(reg.lookup('SUM')).not.toBeNull();
    });

    it('returns null for unknown function', () => {
      expect(new FunctionRegistry().lookup('FOOBAR')).toBeNull();
    });
  });

  describe('has', () => {
    it('returns true for registered functions', () => {
      const reg = new FunctionRegistry();
      expect(reg.has('SUM')).toBe(true);
      expect(reg.has('upper')).toBe(true);
    });

    it('returns false for unknown functions', () => {
      expect(new FunctionRegistry().has('NOPE')).toBe(false);
    });
  });

  describe('isAggregate / isScalar', () => {
    it('correctly identifies aggregate functions', () => {
      const reg = new FunctionRegistry();
      expect(reg.isAggregate('SUM')).toBe(true);
      expect(reg.isAggregate('AVG')).toBe(true);
      expect(reg.isAggregate('UPPER')).toBe(false);
    });

    it('correctly identifies scalar functions', () => {
      const reg = new FunctionRegistry();
      expect(reg.isScalar('UPPER')).toBe(true);
      expect(reg.isScalar('ABS')).toBe(true);
      expect(reg.isScalar('COUNT')).toBe(false);
    });

    it('returns false for unknown functions', () => {
      const reg = new FunctionRegistry();
      expect(reg.isAggregate('NOPE')).toBe(false);
      expect(reg.isScalar('NOPE')).toBe(false);
    });
  });

  describe('register (custom)', () => {
    it('allows registering custom functions', () => {
      const reg = new FunctionRegistry();
      reg.register('MY_FUNC', { name: 'MY_FUNC', type: FunctionType.SCALAR, minArgs: 2, maxArgs: 2 });
      expect(reg.has('MY_FUNC')).toBe(true);
      expect(reg.isScalar('my_func')).toBe(true);
    });

    it('can override builtins', () => {
      const reg = new FunctionRegistry();
      reg.register('SUM', { name: 'SUM', type: FunctionType.SCALAR, minArgs: 1, maxArgs: 1 });
      expect(reg.isScalar('SUM')).toBe(true);
      expect(reg.isAggregate('SUM')).toBe(false);
    });
  });

  describe('defaultFunctionRegistry', () => {
    it('is a pre-instantiated registry with all builtins', () => {
      expect(defaultFunctionRegistry).toBeInstanceOf(FunctionRegistry);
      expect(defaultFunctionRegistry.has('SUM')).toBe(true);
      expect(defaultFunctionRegistry.has('UPPER')).toBe(true);
    });
  });
});
