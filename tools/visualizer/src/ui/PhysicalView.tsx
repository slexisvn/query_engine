import { useMemo, useState } from 'react';
import { costShareOf, planRows, planTotalCost, profileRows, topCostContributors, worstEstimates } from '../engine/profile-view.js';
import { COST_HINT } from '../content/cost.js';
import { formatCount, formatPercent } from './format.js';
import type { PhysicalPlanner } from '@engine/execution/physical-planner.js';
import type { PhysicalPlanNode } from '@engine/execution/physical-plan.js';
import type { ExecutionProfile } from '@engine/execution/execution-profile.js';
import type { MeasuredRows, OperatorRow } from '../engine/profile-view.js';
import type { CostTermView } from '../engine/cost-breakdown.js';

const INDENT_PX = 14;
const TERM_INDENT_PX = 12;
const WORST_LIMIT = 3;
const COST_LIMIT = 3;
const PERCENT_DECIMALS = 0;
const MS_DECIMALS = 1;
const Q_ERROR_DECIMALS = 1;

const ESTIMATE_HINT =
  'How far the planner estimate was from the rows the operator really produced. '
  + 'A misestimate here is what makes every operator above it pick the wrong strategy.';

const BREAKDOWN_HINT =
  'The cost-model primitives this operator was priced with, and what each contributed. '
  + 'Calibrating the model means changing one of these coefficients.';

const CONTRIBUTOR_HINT =
  'Operators ranked by their own cost, excluding their children. '
  + 'This is where the plan spends its estimated work.';

const CANDIDATE_HINT =
  'Every operator the physical planner built for this node, cheapest first. '
  + 'The planner keeps the cheapest and throws the rest away.';

const SUBTITLES: Record<UnmeasuredReason, string> = {
  'other-subject':
    'Only the main query is measured. These are the operator choices the physical planner made for this one.',
  'not-run': 'Operator choices the physical planner made. Run the query to measure them.',
};

const MEASURED_SUBTITLE =
  'What actually ran, with the rows each operator produced against what the planner expected.';

export type UnmeasuredReason = 'other-subject' | 'not-run';

export interface PhysicalViewProps {
  physical: PhysicalPlanNode | null;
  planner: PhysicalPlanner | null;
  profile: ExecutionProfile | null;
  unmeasured: UnmeasuredReason | null;
}

function qErrorLabel(measured: MeasuredRows): string {
  if (!measured.ran) return 'never ran';
  if (measured.bias === 'exact') return 'on target';
  return `${measured.qError.toFixed(Q_ERROR_DECIMALS)}× ${measured.bias}`;
}

function RowMeasures({ row }: { row: OperatorRow }) {
  const { measured } = row;

  if (measured === null) {
    return <span className="op-rows">{formatCount(row.estimatedRows)} est</span>;
  }

  return (
    <span className="op-rows">
      <span className="op-estimate">{formatCount(row.estimatedRows)}</span>
      <span className="op-arrow">→</span>
      <span className="op-actual">{formatCount(measured.actualRows)}</span>
      <span className={`op-qerror tone-${measured.tone}`}>{qErrorLabel(measured)}</span>
    </span>
  );
}

function formatArgs(args: readonly unknown[]): string {
  return args
    .filter(arg => arg !== null && arg !== undefined)
    .map(arg => (typeof arg === 'number' ? formatCount(arg) : String(arg)))
    .join(', ');
}

function CostTerms({ terms, depth }: { terms: readonly CostTermView[]; depth: number }) {
  return (
    <>
      {terms.map((term, index) => (
        <li key={`${term.method}-${depth}-${index}`} style={{ paddingLeft: depth * TERM_INDENT_PX }}>
          <span className="term-call">{term.method}({formatArgs(term.args)})</span>
          <span className="term-share">{(term.share * 100).toFixed(PERCENT_DECIMALS)}%</span>
          <span className="term-value">{formatCount(term.value)}</span>
          {term.children.length === 0 ? null : (
            <ul className="term-children"><CostTerms terms={term.children} depth={depth + 1} /></ul>
          )}
        </li>
      ))}
    </>
  );
}

function Breakdown({ row }: { row: OperatorRow }) {
  if (row.breakdown === null) return null;

  return (
    <div className="op-breakdown">
      <p title={BREAKDOWN_HINT}>priced as</p>
      <ul><CostTerms terms={row.breakdown.terms} depth={0} /></ul>
    </div>
  );
}

function Candidates({ row }: { row: OperatorRow }) {
  const choice = row.choice;
  if (choice === null) return null;

  return (
    <div className="op-candidates">
      <p title={CANDIDATE_HINT}>
        {choice.candidates.length === 1
          ? 'only candidate the planner could build'
          : `${choice.candidates.length} candidates${choice.runnerUpMargin === null || choice.runnerUpMargin <= 0
            ? ''
            : ` · won by ${formatPercent(choice.runnerUpMargin * 100, false)}`}`}
      </p>
      <ul>
        {choice.candidates.map(candidate => (
          <li key={candidate.type} className={candidate.chosen ? 'chosen' : 'rejected'}>
            <span className="candidate-name">{candidate.label}</span>
            <span className="candidate-cost">{formatCount(candidate.cost)}</span>
          </li>
        ))}
      </ul>
      {choice.agreesWithPlan ? null : (
        <p className="op-disagree">
          The cheapest candidate here is not the operator that ran — the statistics behind this panel
          differ from the ones the run used.
        </p>
      )}
    </div>
  );
}

function OperatorRowItem({ row, expanded, costShare, onToggle }: {
  row: OperatorRow;
  expanded: boolean;
  costShare: number;
  onToggle: () => void;
}) {
  const measured = row.measured;

  return (
    <li className="op-row" style={{ paddingLeft: row.depth * INDENT_PX }}>
      <button type="button" className={expanded ? 'op-head open' : 'op-head'} onClick={onToggle}>
        <span className="op-title">{row.title}</span>
        <RowMeasures row={row} />
      </button>
      {expanded ? (
        <div className="op-detail">
          <code>{row.detail}</code>
          <p>
            <span title={COST_HINT}>
              est. cost {formatCount(row.cost)} self ({(costShare * 100).toFixed(PERCENT_DECIMALS)}% of the plan)
              {' · '}{formatCount(row.subtreeCost)} with its inputs
            </span>
            {measured === null ? null : (
              <>
                <span>{formatCount(measured.chunks)} {measured.chunks === 1 ? 'chunk' : 'chunks'}</span>
                {measured.invocations > 1 ? <span>{formatCount(measured.invocations)} runs</span> : null}
                {measured.outputMs === null || measured.chunks < 2
                  ? null
                  : <span>{measured.outputMs.toFixed(MS_DECIMALS)} ms output window</span>}
              </>
            )}
          </p>
          <Breakdown row={row} />
          <Candidates row={row} />
        </div>
      ) : null}
    </li>
  );
}

export function PhysicalView({ physical, planner, profile, unmeasured }: PhysicalViewProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (planner === null) return [];
    if (profile !== null) return profileRows(profile, planner);
    return physical === null ? [] : planRows(physical, planner);
  }, [physical, planner, profile]);

  const worst = useMemo(() => worstEstimates(rows, WORST_LIMIT), [rows]);
  const dearest = useMemo(() => topCostContributors(rows, COST_LIMIT), [rows]);

  if (rows.length === 0) {
    return (
      <div className="json-view">
        <header>
          <h4>Physical plan</h4>
          <p>The physical planner could not build a plan for this tree.</p>
        </header>
      </div>
    );
  }

  return (
    <div className="json-view physical-view">
      <header>
        <div>
          <h4>Physical plan</h4>
          <p>{unmeasured === null ? MEASURED_SUBTITLE : SUBTITLES[unmeasured]}</p>
        </div>
        <span className="physical-cost" title={COST_HINT}>
          est. cost {formatCount(planTotalCost(rows))}
        </span>
      </header>

      {worst.length === 0 ? null : (
        <section className="worst-estimates" title={ESTIMATE_HINT}>
          <h5>worst estimates</h5>
          <ul>
            {worst.map(row => (
              <li key={row.path}>
                <span className="op-title">{row.title}</span>
                <span className={`op-qerror tone-${(row.measured as MeasuredRows).tone}`}>
                  {qErrorLabel(row.measured as MeasuredRows)}
                </span>
                <span className="op-rows">
                  {formatCount(row.estimatedRows)} → {formatCount((row.measured as MeasuredRows).actualRows)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dearest.length === 0 ? null : (
        <section className="worst-estimates cost-contributors" title={CONTRIBUTOR_HINT}>
          <h5>where the cost is</h5>
          <ul>
            {dearest.map(row => (
              <li key={row.path}>
                <span className="op-title">{row.title}</span>
                <span className="contributor-share">{(costShareOf(rows, row) * 100).toFixed(PERCENT_DECIMALS)}%</span>
                <span className="op-rows">{formatCount(row.cost)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ul className="op-tree">
        {rows.map(row => (
          <OperatorRowItem
            key={row.path}
            row={row}
            expanded={expanded === row.path}
            costShare={costShareOf(rows, row)}
            onToggle={() => setExpanded(current => (current === row.path ? null : row.path))}
          />
        ))}
      </ul>
    </div>
  );
}
