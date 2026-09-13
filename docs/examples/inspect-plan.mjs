import { formatPlan } from '../../dist/planner/plan-formatter.js';
import { physicalPlanToString } from '../../dist/execution/physical-plan.js';
import { createBookEngine, runningQuery } from './fixture.mjs';

const engine = await createBookEngine();
try {
  // Statistics collection can rebuild the optimizer. Warm it before observing.
  await engine.run(runningQuery);
  const raw = engine.plan(engine.bind(engine.parseSQL(runningQuery)));
  console.log('Logical plan before optimization:\n' + formatPlan(raw));
  const optimized = engine.optimizer.optimize(raw, {}, (event) => {
    const before = formatPlan(event.before);
    const after = formatPlan(event.after);
    if (before !== after) console.log(`\n${event.pass}:\n${after}`);
  });
  console.log('\nOptimized logical plan:\n' + formatPlan(optimized));
  const physical = engine.executor.resources.physicalPlanner.plan(optimized);
  console.log('\nPhysical plan:\n' + physicalPlanToString(physical));
} finally {
  await engine.close();
}
