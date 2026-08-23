import { useMemo } from 'react';
import type { ResultRow } from '../engine/workspace.js';

export interface DataGridProps {
  columns: readonly string[];
  rows: readonly ResultRow[];
  types?: Readonly<Record<string, string>>;
  firstRowNumber: number;
  compact?: boolean;
}

function numericColumns(columns: readonly string[], rows: readonly ResultRow[]): Set<string> {
  const numeric = new Set<string>();
  for (const column of columns) {
    const sample = rows.find(row => row[column] !== null && row[column] !== undefined);
    const value = sample?.[column];
    if (typeof value === 'number' || typeof value === 'bigint') numeric.add(column);
  }
  return numeric;
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

export function DataGrid({ columns, rows, types, firstRowNumber, compact }: DataGridProps) {
  const numeric = useMemo(() => numericColumns(columns, rows), [columns, rows]);

  return (
    <div className={`data-grid${compact ? ' compact' : ''}`}>
      <table>
        <thead>
          <tr>
            <th className="row-number" scope="col">#</th>
            {columns.map(column => (
              <th key={column} scope="col" className={numeric.has(column) ? 'numeric' : ''}>
                {column}
                {types?.[column] ? <span className="column-type">{types[column]}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td className="row-number">{firstRowNumber + index}</td>
              {columns.map(column => {
                const value = row[column];
                const empty = value === null || value === undefined;
                return (
                  <td key={column} className={`${numeric.has(column) ? 'numeric' : ''}${empty ? ' empty' : ''}`}>
                    {renderCell(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
