export const FunctionType = {
  SCALAR: 'SCALAR',
  AGGREGATE: 'AGGREGATE',
};

export class FunctionRegistry {
  constructor() {
    this.functions = new Map();
    this._registerBuiltins();
  }

  register(name, definition) {
    this.functions.set(name.toUpperCase(), definition);
  }

  lookup(name) {
    return this.functions.get(name.toUpperCase()) || null;
  }

  has(name) {
    return this.functions.has(name.toUpperCase());
  }

  isAggregate(name) {
    const fn = this.lookup(name);
    return fn?.type === FunctionType.AGGREGATE;
  }

  isScalar(name) {
    const fn = this.lookup(name);
    return fn?.type === FunctionType.SCALAR;
  }

  _registerBuiltins() {
    const agg = (name, minArgs = 1, maxArgs = 1) => ({
      name: name.toUpperCase(),
      type: FunctionType.AGGREGATE,
      minArgs,
      maxArgs,
    });

    const scalar = (name, minArgs, maxArgs) => ({
      name: name.toUpperCase(),
      type: FunctionType.SCALAR,
      minArgs,
      maxArgs: maxArgs ?? minArgs,
    });

    this.register('SUM', agg('SUM'));
    this.register('AVG', agg('AVG'));
    this.register('COUNT', agg('COUNT', 0, 1));
    this.register('MIN', agg('MIN'));
    this.register('MAX', agg('MAX'));
    this.register('COUNT_STAR', agg('COUNT_STAR', 0, 0));

    this.register('SUBSTRING', scalar('SUBSTRING', 2, 3));
    this.register('EXTRACT', scalar('EXTRACT', 2, 2));
    this.register('TRIM', scalar('TRIM', 1, 1));
    this.register('UPPER', scalar('UPPER', 1, 1));
    this.register('LOWER', scalar('LOWER', 1, 1));
    this.register('CAST', scalar('CAST', 2, 2));
    this.register('COALESCE', scalar('COALESCE', 1, Infinity));
    this.register('NULLIF', scalar('NULLIF', 2, 2));
    this.register('ABS', scalar('ABS', 1, 1));
    this.register('ROUND', scalar('ROUND', 1, 2));
    this.register('SQRT', scalar('SQRT', 1, 1));
    this.register('LENGTH', scalar('LENGTH', 1, 1));
    this.register('REPLACE', scalar('REPLACE', 3, 3));
  }
}

export const defaultFunctionRegistry = new FunctionRegistry();
