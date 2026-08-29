import type { ReactNode } from 'react';
import { EXAMPLES } from '../content/examples.js';
import { formatCount } from './format.js';

export interface TopBarProps {
  sql: string;
  sidebarOpen: boolean;
  running: boolean;
  stale: boolean;
  neverRun: boolean;
  usesSampleSchema: boolean;
  tableCount: number;
  loadedRows: number;
  onSql: (sql: string) => void;
  onToggleSidebar: () => void;
  onRun: () => void;
  children?: ReactNode;
}

export function TopBar(props: TopBarProps) {
  const current = EXAMPLES.find(example => example.sql === props.sql);

  return (
    <header className="top-bar">
      <button
        type="button"
        className="sidebar-toggle"
        onClick={props.onToggleSidebar}
        title={props.sidebarOpen ? 'Hide the query and catalog' : 'Show the query and catalog'}
      >
        {props.sidebarOpen ? '‹' : '›'}
      </button>

      <h1>Optimizer Visualizer</h1>

      {props.usesSampleSchema ? (
        <>
          <select
            className="example-select"
            value={current?.name ?? ''}
            onChange={event => {
              const picked = EXAMPLES.find(example => example.name === event.target.value);
              if (picked) props.onSql(picked.sql);
            }}
            aria-label="Example query"
          >
            <option value="">custom query</option>
            {EXAMPLES.map(example => (
              <option key={example.name} value={example.name}>{example.name}</option>
            ))}
          </select>
          <p className="top-bar-teaches" title={current?.teaches}>
            {current?.teaches ?? 'Edit the SQL, then press Run to plan and execute it.'}
          </p>
        </>
      ) : (
        <p className="top-bar-teaches">Querying your own data. Remove every import to get the sample schema and its examples back.</p>
      )}

      {props.children}

      <span className="catalog-summary">
        {props.stale && !props.neverRun
          ? 'out of date — press Run'
          : `${props.tableCount} tables · ${formatCount(props.loadedRows)} rows`}
      </span>

      <button
        type="button"
        className={`run-button${props.stale || props.neverRun ? ' stale' : ''}`}
        onClick={props.onRun}
        disabled={props.running}
        title={props.stale ? 'Everything on the right is from the last run' : 'Plan and run the query'}
      >
        {props.running ? 'Running…' : 'Run'}
        <span className="run-hint">Ctrl↵</span>
      </button>
    </header>
  );
}
