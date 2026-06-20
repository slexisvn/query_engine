import type {
  WasmDispatchRegistry,
  WasmKernel,
  RegisterableKernel,
} from './wasm-types.js';

export class WasmDispatch implements WasmDispatchRegistry {
  readonly kernels: Map<string, WasmKernel>;
  wasmInstance: WebAssembly.Instance | null;
  memory: WebAssembly.Memory | null;

  constructor() {
    this.kernels = new Map();
    this.wasmInstance = null;
    this.memory = null;
  }

  register(operation: string, dataType: string, kernel: RegisterableKernel): void {
    const key = `${operation}:${dataType}`;
    this.kernels.set(key, kernel as WasmKernel);
  }

  lookup(operation: string, dataType: string): WasmKernel | null {
    const key = `${operation}:${dataType}`;
    return this.kernels.get(key) || null;
  }

  has(operation: string, dataType: string): boolean {
    return this.kernels.has(`${operation}:${dataType}`);
  }

  setInstance(instance: WebAssembly.Instance, memory: WebAssembly.Memory): void {
    this.wasmInstance = instance;
    this.memory = memory;
  }

  listKernels(): string[] {
    return [...this.kernels.keys()];
  }
}

export const globalDispatch = new WasmDispatch();
