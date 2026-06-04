export class OptimizationPass {
  get name() {
    throw new Error('Subclass must implement name');
  }

  apply(plan, context) {
    throw new Error('Subclass must implement apply()');
  }
}
