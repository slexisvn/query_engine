import { useMemo, useRef, useState } from 'react';
import { DEFAULT_ROW_COUNTS } from '../engine/demo-catalog.js';
import { DataGrid } from './DataGrid.js';
import { Pager, pageCountOf } from './Pager.js';
import { columnFactOf } from '../engine/column-facts.js';
import { formatCount, formatValue } from './format.js';
import type { TableStats } from '@engine/catalog/statistics.js';
import type { RowCounts } from '../engine/demo-catalog.js';
import type { TableEntry } from '../engine/workspace.js';

const PREVIEW_PAGE_SIZE = 25;

export interface SchemaPanelProps {
  tables: readonly TableEntry[];
  usesSampleSchema: boolean;
  dataRows: number;
  rowCounts: RowCounts;
  statistics: Map<string, TableStats>;
  importError: string | null;
  importing: boolean;
  onImport: (files: readonly File[]) => void;
  onDrop: (table: string) => void;
  onRowCountChange: (table: string, rowCount: number) => void;
  onResetRowCounts: () => void;
}

const STATS_HINT =
  'What the estimator knows about each column. A column with no histogram gets a fixed guess '
  + 'for range predicates, which is where cardinality estimates start drifting.';

function ColumnList({ table, statistics }: { table: TableEntry; statistics: Map<string, TableStats> }) {
  return (
    <table className="schema-detail" title={STATS_HINT}>
      <thead>
        <tr>
          <th>column</th><th>type</th><th>distinct</th><th>nulls</th>
          <th>range</th><th>hist</th><th>index</th>
        </tr>
      </thead>
      <tbody>
        {table.columns.map(column => {
          const fact = columnFactOf(statistics, table.name, column.name, undefined, String(column.dataType));
          return (
            <tr key={column.name} className={fact.known ? '' : 'no-column-stats'}>
              <td>{column.name}</td>
              <td className="schema-type">{column.dataType}</td>
              <td>{formatCount(fact.ndv)}</td>
              <td>{fact.nullFraction === null ? '—' : `${(fact.nullFraction * 100).toFixed(0)}%`}</td>
              <td className="schema-range">
                {fact.min === null && fact.max === null
                  ? '—'
                  : `${formatValue(fact.min, column.dataType)}…${formatValue(fact.max, column.dataType)}`}
              </td>
              <td>{fact.histogramBuckets === null ? '—' : fact.histogramBuckets}</td>
              <td>{table.indexed.includes(column.name) ? 'yes' : ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DataPreview({ table }: { table: TableEntry }) {
  const [page, setPage] = useState(0);

  const columns = useMemo(() => table.columns.map(column => column.name), [table]);
  const types = useMemo(
    () => Object.fromEntries(table.columns.map(column => [column.name, column.dataType])),
    [table],
  );

  const from = page * PREVIEW_PAGE_SIZE;
  const visible = table.preview.slice(from, from + PREVIEW_PAGE_SIZE);
  const capped = table.rowCount > table.preview.length;

  return (
    <div className="schema-preview">
      <DataGrid columns={columns} rows={visible} types={types} firstRowNumber={from + 1} compact />
      <Pager
        page={page}
        pageCount={pageCountOf(table.preview.length, PREVIEW_PAGE_SIZE)}
        from={from + 1}
        to={from + visible.length}
        total={table.preview.length}
        unit={capped ? 'rows previewed' : 'rows'}
        note={capped ? `${formatCount(table.rowCount)} in the file` : undefined}
        onPage={setPage}
      />
    </div>
  );
}

export function SchemaPanel(props: SchemaPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const edited = props.tables.some(table => props.rowCounts[table.name] !== DEFAULT_ROW_COUNTS[table.name]);

  const renderTable = (table: TableEntry) => (
    <li key={table.name} className={expanded === table.name ? 'expanded' : ''}>
      <div className="schema-row">
        <button type="button" className="schema-name" onClick={() => setExpanded(expanded === table.name ? null : table.name)}>
          <span className="fold-arrow" aria-hidden="true">{expanded === table.name ? '▾' : '▸'}</span>
          {table.name}
          <span className="schema-columns">{table.columns.length} cols</span>
        </button>
        {table.kind === 'sample' ? (
          <input
            type="number"
            min={0}
            value={props.rowCounts[table.name] ?? 0}
            onChange={event => props.onRowCountChange(table.name, Math.max(0, Number(event.target.value)))}
            title="Estimated row count — the optimizer plans against this"
          />
        ) : (
          <>
            <span className="schema-rows">{formatCount(table.rowCount)} rows</span>
            <button type="button" className="schema-drop" onClick={() => props.onDrop(table.name)} title={`Remove ${table.name}`}>×</button>
          </>
        )}
      </div>
      {expanded !== table.name ? null : table.kind === 'imported'
        ? <DataPreview table={table} />
        : <ColumnList table={table} statistics={props.statistics} />}
    </li>
  );

  return (
    <section
      className={`schema-panel${dragging ? ' dragging' : ''}`}
      onDragOver={event => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => {
        event.preventDefault();
        setDragging(false);
        props.onImport([...event.dataTransfer.files]);
      }}
    >
      <header>
        <h3>Catalog</h3>
        <button type="button" onClick={() => picker.current?.click()} disabled={props.importing}>
          {props.importing ? 'reading…' : 'import CSV'}
        </button>
        <input
          ref={picker}
          type="file"
          accept=".csv,text/csv"
          multiple
          hidden
          onChange={event => {
            props.onImport([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
      </header>

      {props.importError ? <p className="import-error">{props.importError}</p> : null}

      {props.usesSampleSchema ? (
        <>
          <h4 className="schema-group">Sample schema <span>— TPC-H</span></h4>
          <p className="schema-hint">
            Plans against the row-count estimates below; runs against {formatCount(props.dataRows)} real
            sample rows. Change an estimate and every cost-based pass re-decides. Import a CSV and your
            tables take over the catalog.
          </p>
          <ul className="schema-tables">{props.tables.map(renderTable)}</ul>
          {edited ? (
            <p className="schema-edited">Estimates edited — the optimizer is planning for a catalog this size.</p>
          ) : null}
          <button type="button" className="schema-reset" onClick={props.onResetRowCounts} disabled={!edited}>
            reset estimates
          </button>
        </>
      ) : (
        <>
          <h4 className="schema-group">Your data</h4>
          <ul className="schema-tables">{props.tables.map(renderTable)}</ul>
        </>
      )}

      {dragging ? <div className="drop-overlay">Drop CSV files to import</div> : null}
    </section>
  );
}
