import { useMemo } from 'react';
import { formatCount, formatPercent, formatSigned, percentChange } from './format.js';
import type { OptimizeTrace, PassStep } from '../engine/trace.js';

const MAX_BAR_SHARE = 46;
const MIN_BAR_SHARE = 1.6;

export interface PassListProps {
  optimize: OptimizeTrace;
  selectedStep: number;
  onSelect: (index: number) => void;
  hideNoops: boolean;
  onHideNoopsChange: (hide: boolean) => void;
}

interface IterationGroup {
  iteration: number;
  steps: PassStep[];
}

interface StageGroup {
  stage: string;
  iterations: IterationGroup[];
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

export function PassList({ optimize, selectedStep, onSelect, hideNoops, onHideNoopsChange }: PassListProps) {
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

  const first = optimize.snapshots[0].cost;
  const last = optimize.snapshots[optimize.snapshots.length - 1].cost;
  const overall = percentChange(first, last);

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
        <div className="pass-list-cost">
          {formatCount(first)} → {formatCount(last)}
          {overall === null ? '' : <span className={overall < 0 ? 'better' : 'worse'}> · {formatPercent(overall)}</span>}
        </div>
      </header>

      {optimize.error ? (
        <p className="pass-error">Optimizer threw after step {optimize.error.afterStep}: {optimize.error.message}</p>
      ) : null}

      <ol className="pass-groups">
        {groups.map((group, groupIndex) => (
          <li key={`${group.stage}-${groupIndex}`} className="pass-stage">
            <h4>{group.stage}</h4>
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
                    <button
                      key={step.index}
                      type="button"
                      className={`pass-row${step.index === selectedStep ? ' selected' : ''}${step.changed ? '' : ' noop'}`}
                      onClick={() => onSelect(step.index)}
                      title={step.changed ? `${formatCount(from.cost)} → ${formatCount(to.cost)}` : undefined}
                    >
                      <span className="pass-name">{step.pass}</span>
                      {step.changed ? (
                        <>
                          <span className="pass-metrics">
                            <span className="delta-nodes">{formatSigned(to.nodes - from.nodes)} nodes</span>
                            {costShift === null ? null : (
                              <span className={`delta-cost ${bar.tone}`}>{formatPercent(costShift)} cost</span>
                            )}
                          </span>
                          <span className="cost-track">
                            <span className={`cost-fill ${bar.tone}`} style={bar.style} />
                          </span>
                        </>
                      ) : (
                        <span className="pass-metrics muted">no change</span>
                      )}
                    </button>
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
