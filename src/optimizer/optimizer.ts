import { planSignature } from './plan-signature.js';
import { Config } from '../config.js';
import type { LogicalPlanNode } from '../planner/logical-plan.js';
import type { OptimizationContext, OptimizationPass } from './pass.js';

export interface OptimizerStage {
  name: string;
  passes: OptimizationPass[];
  maxIterations: number;
}

export interface PassTraceEvent {
  stage: string;
  pass: string;
  iteration: number;
  before: LogicalPlanNode;
  after: LogicalPlanNode;
}

export type OptimizerObserver = (event: PassTraceEvent) => void;

export class Optimizer {
  stages: OptimizerStage[];

  constructor() {
    this.stages = [];
  }

  registerPass(pass: OptimizationPass): this {
    this.stages.push({ name: pass.name, passes: [pass], maxIterations: 1 });
    return this;
  }

  registerFixpoint(name: string, passes: OptimizationPass[], maxIterations: number = Config.optimizerFixpointIterations): this {
    this.stages.push({ name, passes, maxIterations });
    return this;
  }

  removePass(name: string): this {
    for (const stage of this.stages) {
      stage.passes = stage.passes.filter(p => p.name !== name);
    }
    this.stages = this.stages.filter(stage => stage.passes.length > 0);
    return this;
  }

  insertPassBefore(name: string, pass: OptimizationPass): this {
    return this.insertStageAt(this.stageIndexOf(name), pass);
  }

  insertPassAfter(name: string, pass: OptimizationPass): this {
    const index = this.stageIndexOf(name);
    return this.insertStageAt(index === -1 ? -1 : index + 1, pass);
  }

  stageIndexOf(passName: string): number {
    return this.stages.findIndex(stage => stage.passes.some(p => p.name === passName));
  }

  insertStageAt(index: number, pass: OptimizationPass): this {
    const stage: OptimizerStage = { name: pass.name, passes: [pass], maxIterations: 1 };
    if (index === -1) this.stages.push(stage);
    else this.stages.splice(index, 0, stage);
    return this;
  }

  optimize(plan: LogicalPlanNode, context: OptimizationContext = {} as OptimizationContext, observer?: OptimizerObserver): LogicalPlanNode {
    let current = plan;
    for (const stage of this.stages) {
      current = stage.maxIterations <= 1
        ? this.runOnce(stage, current, context, 0, observer)
        : this.runToFixpoint(stage, current, context, observer);
    }
    return current;
  }

  runOnce(stage: OptimizerStage, plan: LogicalPlanNode, context: OptimizationContext, iteration: number = 0, observer?: OptimizerObserver): LogicalPlanNode {
    let current = plan;
    for (const pass of stage.passes) {
      const before = current;
      current = pass.apply(before, context);
      observer?.({ stage: stage.name, pass: pass.name, iteration, before, after: current });
    }
    return current;
  }

  runToFixpoint(stage: OptimizerStage, plan: LogicalPlanNode, context: OptimizationContext, observer?: OptimizerObserver): LogicalPlanNode {
    let current = plan;
    let signature = planSignature(current);

    for (let iteration = 0; iteration < stage.maxIterations; iteration++) {
      current = this.runOnce(stage, current, context, iteration, observer);
      const nextSignature = planSignature(current);
      if (nextSignature === signature) break;
      signature = nextSignature;
    }

    return current;
  }

  listPasses(): string[] {
    return this.stages.flatMap(stage => stage.passes.map(p => p.name));
  }

  listStages(): string[] {
    return this.stages.map(stage => stage.name);
  }
}
