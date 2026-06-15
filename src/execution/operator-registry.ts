export class OperatorRegistry {
  factories: Map<any, (...args: any[]) => any>;

  constructor() {
    this.factories = new Map();
  }

  register(logicalType: any, factory: (...args: any[]) => any): this {
    this.factories.set(logicalType, factory);
    return this;
  }

  create(logicalType: any, ...args: any[]): any {
    const factory = this.factories.get(logicalType);
    if (!factory) {
      throw new Error(`No operator registered for logical type: ${logicalType}`);
    }
    return factory(...args);
  }

  has(logicalType: any): boolean {
    return this.factories.has(logicalType);
  }
}
