import type { ColumnValue, DataType } from '../storage/data-type.js';

export enum FunctionType {
  SCALAR = 'SCALAR',
  AGGREGATE = 'AGGREGATE',
}

export type FunctionImpl = (args: ColumnValue[]) => ColumnValue;

export interface FunctionDef {
  name: string;
  type: FunctionType;
  minArgs: number;
  maxArgs: number;
  argTypes?: DataType[];
  returnType?: DataType;
  impl?: FunctionImpl;
}

export class FunctionRegistry {
  functions: Map<string, FunctionDef>;

  constructor() {
    this.functions = new Map();
    this._registerBuiltins();
  }

  register(name: string, definition: FunctionDef): void {
    this.functions.set(name.toUpperCase(), definition);
  }

  lookup(name: string): FunctionDef | null {
    return this.functions.get(name.toUpperCase()) || null;
  }

  has(name: string): boolean {
    return this.functions.has(name.toUpperCase());
  }

  isAggregate(name: string): boolean {
    const fn = this.lookup(name);
    return fn?.type === FunctionType.AGGREGATE;
  }

  isScalar(name: string): boolean {
    const fn = this.lookup(name);
    return fn?.type === FunctionType.SCALAR;
  }

  _registerBuiltins(): void {
    const agg = (name: string, minArgs: number = 1, maxArgs: number = 1): FunctionDef => ({
      name: name.toUpperCase(),
      type: FunctionType.AGGREGATE,
      minArgs,
      maxArgs,
    });

    const scalar = (name: string, minArgs: number, maxArgs?: number): FunctionDef => ({
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
    this.register('IS_TRUE', scalar('IS_TRUE', 1, 1));
    this.register('IS_FALSE', scalar('IS_FALSE', 1, 1));
  }
}

export const defaultFunctionRegistry = new FunctionRegistry();
