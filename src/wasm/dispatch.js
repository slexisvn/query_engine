export class WasmDispatch {
  constructor() {
    this.kernels = new Map();
    this.wasmInstance = null;
    this.memory = null;
  }

  register(operation, dataType, kernel) {
    const key = `${operation}:${dataType}`;
    this.kernels.set(key, kernel);
  }

  lookup(operation, dataType) {
    const key = `${operation}:${dataType}`;
    return this.kernels.get(key) || null;
  }

  has(operation, dataType) {
    return this.kernels.has(`${operation}:${dataType}`);
  }

  setInstance(instance, memory) {
    this.wasmInstance = instance;
    this.memory = memory;
  }

  listKernels() {
    return [...this.kernels.keys()];
  }
}

export const globalDispatch = new WasmDispatch();
