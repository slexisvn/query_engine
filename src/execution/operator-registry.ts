export type OperatorArg = string | number | boolean | object | null;
export type OperatorFactory = (...args: OperatorArg[]) => object;

export class OperatorRegistry {
  factories: Map<string, OperatorFactory>;

  constructor() {
    this.factories = new Map();
  }

  register(logicalType: string, factory: OperatorFactory): this {
    this.factories.set(logicalType, factory);
    return this;
  }

  create(logicalType: string, ...args: OperatorArg[]): object {
    const factory = this.factories.get(logicalType);
    if (!factory) {
      throw new Error(`No operator registered for logical type: ${logicalType}`);
    }
    return factory(...args);
  }

  has(logicalType: string): boolean {
    return this.factories.has(logicalType);
  }
}
