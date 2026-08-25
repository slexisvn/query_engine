import type { CompileFailure, CompilePhase } from '../engine/compile.js';

const PHASE_LABELS: Readonly<Record<CompilePhase, string>> = {
  parse: 'Parse',
  bind: 'Bind',
  plan: 'Plan',
};

const PHASE_HINTS: Readonly<Record<CompilePhase, string>> = {
  parse: 'The text could not be read as a SQL statement, so nothing downstream ran.',
  bind: 'The statement parsed, but a name in it is not in the catalog.',
  plan: 'The query bound cleanly, but it could not be turned into a logical plan.',
};

const UNKNOWN_NAME = /Unknown (?:table|column):/i;
const POSITION = /position (\d+)/i;

export function locationOf(sql: string, message: string): string | null {
  const found = POSITION.exec(message);
  if (!found) return null;

  const offset = Math.min(Number(found[1]), sql.length);
  const before = sql.slice(0, offset);
  const line = before.split('\n').length;
  return `line ${line}, column ${offset - before.lastIndexOf('\n')}`;
}

function headline(error: CompileFailure): string {
  const label = PHASE_LABELS[error.phase];
  return error.message.toLowerCase().startsWith(`${label.toLowerCase()} error`)
    ? error.message
    : `${label} error: ${error.message}`;
}

export interface CompileErrorProps {
  error: CompileFailure;
  sql: string;
  tables: readonly string[];
  stale: boolean;
}

export function CompileError({ error, sql, tables, stale }: CompileErrorProps) {
  const where = locationOf(sql, error.message);

  return (
    <div className="compile-error" role="status">
      <p className="compile-error-message">
        {headline(error)}
        {where === null ? null : <span className="compile-error-where"> · {where}</span>}
      </p>
      <p className="compile-error-hint">{PHASE_HINTS[error.phase]}</p>
      {UNKNOWN_NAME.test(error.message) && tables.length > 0 ? (
        <p className="compile-error-hint">The catalog holds {tables.join(', ')}.</p>
      ) : null}
      {stale ? <p className="compile-error-hint">You have edited the query since — press Run to check it.</p> : null}
    </div>
  );
}
