import type { LogicalPlanNode } from '../planner/logical-plan.js';
import type { OptimizationPass } from './pass.js';

export class Optimizer {
  passes: OptimizationPass[];

  constructor() {
    this.passes = [];
  }

  registerPass(pass: OptimizationPass): this {
    this.passes.push(pass);
    return this;
  }

  removePass(name: string): this {
    this.passes = this.passes.filter(p => p.name !== name);
    return this;
  }

  insertPassBefore(name: string, pass: OptimizationPass): this {
    const idx = this.passes.findIndex(p => p.name === name);
    if (idx === -1) {
      this.passes.push(pass);
    } else {
      this.passes.splice(idx, 0, pass);
    }
    return this;
  }

  insertPassAfter(name: string, pass: OptimizationPass): this {
    const idx = this.passes.findIndex(p => p.name === name);
    if (idx === -1) {
      this.passes.push(pass);
    } else {
      this.passes.splice(idx + 1, 0, pass);
    }
    return this;
  }

  optimize(plan: LogicalPlanNode, context: Record<string, unknown> = {}): LogicalPlanNode {
    let current = plan;
    for (const pass of this.passes) {
      current = pass.apply(current, context);
    }
    return current;
  }

  listPasses(): string[] {
    return this.passes.map(p => p.name);
  }
}
