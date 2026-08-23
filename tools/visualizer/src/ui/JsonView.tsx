import { useMemo } from 'react';

const INDENT = 2;

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

export function JsonView({ title, subtitle, value }: JsonViewProps) {
  const text = useMemo(() => JSON.stringify(value, serialize, INDENT), [value]);

  return (
    <div className="json-view">
      <header>
        <h4>{title}</h4>
        <p>{subtitle}</p>
      </header>
      <pre>{text}</pre>
    </div>
  );
}
