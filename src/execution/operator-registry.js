export class OperatorRegistry {
  constructor() {
    this.factories = new Map();
  }

  register(logicalType, factory) {
    this.factories.set(logicalType, factory);
    return this;
  }

  create(logicalType, ...args) {
    const factory = this.factories.get(logicalType);
    if (!factory) {
      throw new Error(`No operator registered for logical type: ${logicalType}`);
    }
    return factory(...args);
  }

  has(logicalType) {
    return this.factories.has(logicalType);
  }
}
