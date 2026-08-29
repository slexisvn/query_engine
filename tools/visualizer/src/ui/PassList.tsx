import { useMemo } from 'react';
import { COST_CAPTION, COST_HINT } from '../content/cost.js';
import { formatCount, formatMs, formatPercent, percentChange } from './format.js';
import type { OptimizeTrace, PassStep } from '../engine/trace.js';

const MAX_BAR_SHARE = 46;
const MIN_BAR_SHARE = 1.6;
const SLOW_PASS_SHARE = 0.2;
const SLOW_PASS_FLOOR_MS = 1;
const TIMED_PIPELINE_FLOOR_MS = 1;

const OSCILLATION_HINT =
  'This pass rewrote the plan back into a shape the same stage already produced. '
  + 'A fixpoint stage that cycles will keep burning iterations without settling.';

const DISABLE_HINT = 'Drop this pass from the pipeline and re-plan, to see what it was buying you.';

function PassMs({ ms, slow }: { ms: number; slow: boolean }) {
  return <span className={slow ? 'pass-ms slow' : 'pass-ms'}>{formatMs(ms)}</span>;
}

export interface PassListProps {
  optimize: OptimizeTrace;
  selectedStep: number;
  onSelect: (index: number) => void;
  hideNoops: boolean;
  onHideNoopsChange: (hide: boolean) => void;
  disabled: ReadonlySet<string>;
  onToggleDisabled: (pass: string) => void;
  baselineCost: number | null;
  onCompareBaseline: (() => void) | null;
}

interface IterationGroup {
  iteration: number;
  steps: PassStep[];
}

interface StageGroup {
  stage: string;
  iterations: IterationGroup[];
}

function repeatsStageName(group: StageGroup): boolean {
  const steps = group.iterations.flatMap(iteration => iteration.steps);
  return steps.length === 1 && steps[0].pass === group.stage;
}

function groupSteps(steps: readonly PassStep[]): StageGroup[] {
  const groups: StageGroup[] = [];

  for (const step of steps) {
    let stage = groups[groups.length - 1];
    if (!stage || stage.stage !== step.stage) {
      stage = { stage: step.stage, iterations: [] };
      groups.push(stage);
    }
    let iteration = stage.iterations[stage.iterations.length - 1];
    if (!iteration || iteration.iteration !== step.iteration) {
      iteration = { iteration: step.iteration, steps: [] };
      stage.iterations.push(iteration);
    }
    iteration.steps.push(step);
  }

  return groups;
}

function costDelta(optimize: OptimizeTrace, step: PassStep): number {
  const before = optimize.snapshots[step.from].cost;
  const after = optimize.snapshots[step.to].cost;
  return before === null || after === null ? 0 : after - before;
}

function barStyle(delta: number, widest: number): { tone: string; style: React.CSSProperties } {
  const share = Math.max(MIN_BAR_SHARE, (Math.abs(delta) / widest) * MAX_BAR_SHARE);
  if (delta === 0) return { tone: 'flat', style: { left: `${50 - MIN_BAR_SHARE}%`, width: `${MIN_BAR_SHARE * 2}%` } };
  if (delta < 0) return { tone: 'cheaper', style: { right: '50%', width: `${share}%` } };
  return { tone: 'dearer', style: { left: '50%', width: `${share}%` } };
}

export function PassList({
  optimize,
  selectedStep,
  onSelect,
  hideNoops,
  onHideNoopsChange,
  disabled,
  onToggleDisabled,
  baselineCost,
  onCompareBaseline,
}: PassListProps) {
  const visible = useMemo(
    () => (hideNoops ? optimize.steps.filter(step => step.changed) : optimize.steps),
    [optimize.steps, hideNoops],
  );
  const groups = useMemo(() => groupSteps(visible), [visible]);
  const changed = useMemo(() => optimize.steps.filter(step => step.changed), [optimize.steps]);
  const widestDelta = useMemo(
    () => Math.max(...changed.map(step => Math.abs(costDelta(optimize, step))), 1),
    [changed, optimize],
  );
  const cycling = useMemo(() => optimize.steps.filter(step => step.repeats !== null), [optimize.steps]);

  const first = optimize.snapshots[0].cost;
  const last = optimize.snapshots[optimize.snapshots.length - 1].cost;
  const overall = percentChange(first, last);
  const ablationCost = baselineCost === null ? null : percentChange(baselineCost, last);
  const timed = optimize.totalMs >= TIMED_PIPELINE_FLOOR_MS;
  const slowThreshold = Math.max(optimize.totalMs * SLOW_PASS_SHARE, SLOW_PASS_FLOOR_MS);

  return (
    <div className="pass-list">
      <header className="pass-list-header">
        <div className="pass-list-counts">
          <span>{changed.length} of {optimize.steps.length} pass runs rewrote the plan</span>
          <label>
            <input type="checkbox" checked={hideNoops} onChange={event => onHideNoopsChange(event.target.checked)} />
            only changes
          </label>
        </div>
        <div className="pass-list-cost" title={COST_HINT}>
          <span className="cost-caption">{COST_CAPTION}</span>
          <span className="cost-endpoints">{formatCount(first)} → {formatCount(last)}</span>
          {overall === null ? null : (
            <span className={overall < 0 ? 'better' : 'worse'}>{formatPercent(overall)}</span>
          )}
          {timed ? <span className="pass-list-time">· planned in {formatMs(optimize.totalMs)}</span> : null}
        </div>
      </header>

      {disabled.size === 0 ? null : (
        <div className="ablation-banner">
          <div className="ablation-chips">
            <span>pipeline without</span>
            {[...disabled].map(pass => (
              <button key={pass} type="button" onClick={() => onToggleDisabled(pass)} title="Put this pass back">
                {pass} <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
          {ablationCost === null ? null : (
            <p className={ablationCost > 0 ? 'worse' : 'better'}>
              final plan costs {formatPercent(ablationCost)} against the full pipeline
              {' '}({formatCount(baselineCost)} → {formatCount(last)})
            </p>
          )}
          {onCompareBaseline === null ? null : (
            <button
              type="button"
              className="ablation-compare"
              onClick={onCompareBaseline}
              title="Morph the full pipeline's plan into this one"
            >
              show me the difference
            </button>
          )}
        </div>
      )}

      {cycling.length === 0 ? null : (
        <p className="pass-cycling" title={OSCILLATION_HINT}>
          {cycling.length} {cycling.length === 1 ? 'run' : 'runs'} landed back on a plan the same stage already had
        </p>
      )}

      {optimize.error ? (
        <p className="pass-error">
          Optimizer threw after step {optimize.error.afterStep}: {optimize.error.message}
          {optimize.error.afterStep === 0 ? null : (
            <button
              type="button"
              onClick={() => onSelect(optimize.error!.afterStep - 1)}
              title="Show the plan as it stood when the optimizer threw"
            >
              show that plan
            </button>
          )}
        </p>
      ) : null}

      <ol className="pass-groups">
        {groups.map((group, groupIndex) => (
          <li key={`${group.stage}-${groupIndex}`} className="pass-stage">
            {repeatsStageName(group) ? null : <h4>{group.stage}</h4>}
            {group.iterations.map(iteration => (
              <div key={iteration.iteration} className="pass-iteration">
                {group.iterations.length > 1 || iteration.iteration > 0 ? (
                  <span className="iteration-label">iteration {iteration.iteration + 1}</span>
                ) : null}
                {iteration.steps.map(step => {
                  const from = optimize.snapshots[step.from];
                  const to = optimize.snapshots[step.to];
                  const costShift = percentChange(from.cost, to.cost);
                  const bar = barStyle(costDelta(optimize, step), widestDelta);
                  return (
                    <div key={step.index} className="pass-row-shell">
                      <button
                        type="button"
                        className={`pass-row${step.index === selectedStep ? ' selected' : ''}${step.changed ? '' : ' noop'}`}
                        onClick={() => onSelect(step.index)}
                        title={step.changed ? `${COST_CAPTION} ${formatCount(from.cost)} → ${formatCount(to.cost)}` : undefined}
                      >
                        <span className="pass-name">
                          {step.pass}
                          {step.repeats === null ? null : (
                            <span className="pass-cycle-flag" title={OSCILLATION_HINT}>
                              cycles back to step {step.repeats + 1}
                            </span>
                          )}
                        </span>
                        {step.changed ? (
                          <>
                            <span className="pass-metrics">
                              <span className="delta-nodes">{from.nodes} → {to.nodes} nodes</span>
                              {costShift === null ? null : (
                                <span className={`delta-cost ${bar.tone}`}>{formatPercent(costShift)} cost</span>
                              )}
                              {timed ? <PassMs ms={step.ms} slow={step.ms >= slowThreshold} /> : null}
                            </span>
                            <span className="cost-track">
                              <span className={`cost-fill ${bar.tone}`} style={bar.style} />
                            </span>
                          </>
                        ) : (
                          <span className="pass-metrics muted">
                            <span>no change</span>
                            {timed ? <PassMs ms={step.ms} slow={step.ms >= slowThreshold} /> : null}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="pass-disable"
                        title={DISABLE_HINT}
                        aria-label={`Re-plan without ${step.pass}`}
                        onClick={() => onToggleDisabled(step.pass)}
                      >
                        off
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </li>
        ))}
      </ol>
    </div>
  );
}
