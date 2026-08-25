import { useMemo, useState } from 'react';

const INDENT = 2;
const OPEN_TO_DEPTH = 2;
const EMPTY_KEYS: readonly string[] = [];

export interface JsonViewProps {
  title: string;
  subtitle: string;
  value: unknown;
}

function serialize(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, serialize));
}

function isBranch(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function leafText(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

function summarise(value: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  const kind = value.kind;
  if (typeof kind === 'string') return kind;
  const keys = Object.keys(value);
  return keys.length === 0 ? '{}' : `${keys.length} field${keys.length === 1 ? '' : 's'}`;
}

function Branch({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  if (!isBranch(value)) {
    return (
      <div className="json-leaf">
        <span className="json-key">{name}</span>
        <span className={`json-value json-${value === null ? 'null' : typeof value}`}>{leafText(value)}</span>
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value).filter(([key]) => key !== 'kind');

  return (
    <details className="json-branch" open={depth < OPEN_TO_DEPTH}>
      <summary>
        <span className="json-key">{name}</span>
        <span className="json-summary">{summarise(value)}</span>
      </summary>
      <div className="json-children">
        {entries.length === 0
          ? <p className="json-empty">nothing here</p>
          : entries.map(([key, entry]) => <Branch key={key} name={key} value={entry} depth={depth + 1} />)}
      </div>
    </details>
  );
}

export function JsonView({ title, subtitle, value }: JsonViewProps) {
  const [raw, setRaw] = useState(false);

  const tree = useMemo(() => plain(value), [value]);
  const text = useMemo(() => JSON.stringify(value, serialize, INDENT), [value]);
  const roots = useMemo(
    () => (isBranch(tree) && !Array.isArray(tree) ? Object.keys(tree).filter(key => key !== 'kind') : EMPTY_KEYS),
    [tree],
  );

  return (
    <div className="json-view">
      <header>
        <div>
          <h4>{title}</h4>
          <p>{subtitle}</p>
        </div>
        <div className="stage-group">
          <button type="button" className={raw ? '' : 'selected'} onClick={() => setRaw(false)}>Tree</button>
          <button type="button" className={raw ? 'selected' : ''} onClick={() => setRaw(true)}>JSON</button>
        </div>
      </header>

      {raw ? (
        <pre>{text}</pre>
      ) : (
        <div className="json-tree">
          {isBranch(tree) && !Array.isArray(tree) ? (
            <>
              <p className="json-root">{summarise(tree)}</p>
              {roots.map(key => <Branch key={key} name={key} value={tree[key]} depth={1} />)}
            </>
          ) : (
            <Branch name="value" value={tree} depth={0} />
          )}
        </div>
      )}
    </div>
  );
}
