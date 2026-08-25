import { useEffect, useMemo, useState } from 'react';
import { DataGrid } from './DataGrid.js';
import { Pager, pageCountOf } from './Pager.js';
import { formatCount } from './format.js';
import { RESULT_ROW_CAP } from '../engine/workspace.js';
import type { RunOutcome, RunSuccess } from '../engine/workspace.js';

const PAGE_SIZE = 100;
const MS_DECIMALS = 1;

export interface ResultsViewProps {
  outcome: RunOutcome | null;
  estimated: number | null;
  running: boolean;
  onRun: () => void;
}

function ResultTable({ outcome, estimated }: { outcome: RunSuccess; estimated: number | null }) {
  const [page, setPage] = useState(0);
  const pageCount = pageCountOf(outcome.rows.length, PAGE_SIZE);

  useEffect(() => setPage(0), [outcome]);

  const from = page * PAGE_SIZE;
  const visible = useMemo(() => outcome.rows.slice(from, from + PAGE_SIZE), [outcome.rows, from]);

  return (
    <>
      <header>
        <span>
          {formatCount(outcome.total)} {outcome.total === 1 ? 'row' : 'rows'}
          {outcome.truncated ? ` · kept the first ${formatCount(RESULT_ROW_CAP)}` : ''}
        </span>
        <span>
          {estimated === null ? null : (
            <span className="results-estimate" title="What the planner expected before it ran">
              planner estimated {formatCount(estimated)} ·{' '}
            </span>
          )}
          <span className="results-timing">{outcome.ms.toFixed(MS_DECIMALS)} ms</span>
        </span>
      </header>
      <DataGrid columns={outcome.columns} keys={outcome.rowKeys} rows={visible} firstRowNumber={from + 1} />
      <Pager
        page={page}
        pageCount={pageCount}
        from={from + 1}
        to={from + visible.length}
        total={outcome.rows.length}
        unit="rows"
        onPage={setPage}
      />
    </>
  );
}

export function ResultsView({ outcome, estimated, running, onRun }: ResultsViewProps) {
  if (running) {
    return <div className="results-placeholder"><p>Running the query…</p></div>;
  }

  if (outcome === null) {
    return (
      <div className="results-placeholder">
        <h4>Nothing has run yet</h4>
        <p>
          Everything up to Physical is planning — it never touches a row. Run the query to see what it
          actually computes.
        </p>
        <button type="button" onClick={onRun}>Run the query</button>
      </div>
    );
  }

  if (!outcome.ok && outcome.reason === 'no-data') {
    const names = outcome.tables.join(', ');
    return (
      <div className="results-placeholder error">
        <h4>No rows to run against</h4>
        <p className="results-error">{names} {outcome.tables.length === 1 ? 'is' : 'are'} defined but empty</p>
        <p>
          The sample schema is a planning sandbox — column types and estimated statistics, and nothing
          else. Every stage up to Physical works on it; only running needs data. Import a CSV from the
          Catalog panel and it becomes the catalog you query.
        </p>
      </div>
    );
  }

  if (!outcome.ok) {
    return (
      <div className="results-placeholder error">
        <h4>The query could not run</h4>
        <p className="results-error">{outcome.message}</p>
      </div>
    );
  }

  if (outcome.rows.length === 0) {
    return (
      <div className="results-placeholder">
        <h4>No rows matched</h4>
        <p>The query ran in {outcome.ms.toFixed(MS_DECIMALS)} ms and returned nothing.</p>
      </div>
    );
  }

  return (
    <div className="results-view">
      <ResultTable outcome={outcome} estimated={estimated} />
    </div>
  );
}
