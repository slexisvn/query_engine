import { DataType, epochDaysToDate } from '@engine/storage/data-type.js';
const UNITS: readonly { limit: number; suffix: string }[] = [
  { limit: 1e12, suffix: 'T' },
  { limit: 1e9, suffix: 'B' },
  { limit: 1e6, suffix: 'M' },
  { limit: 1e3, suffix: 'K' },
];

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  for (const unit of UNITS) {
    if (magnitude >= unit.limit) {
      const scaled = value / unit.limit;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}${unit.suffix}`;
    }
  }
  return `${Math.round(value)}`;
}

export function percentChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  // Free before and free after is a 0% move; free before and costly after has no percentage at all.
  if (from === 0) return to === 0 ? 0 : null;
  return ((to - from) / from) * 100;
}

export function formatPercent(value: number | null, signed: boolean = true): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0%';
  const shown = signed ? value : Math.abs(value);
  const rounded = Math.abs(shown) < 1 ? shown.toFixed(2) : shown.toFixed(0);
  return `${signed && value > 0 ? '+' : ''}${rounded}%`;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 100) return `${Math.round(value)} ms`;
  if (value >= 1) return `${value.toFixed(1)} ms`;
  return '<1 ms';
}

export function formatSelectivity(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0%';
  const percent = value * 100;
  if (percent >= 10) return `${percent.toFixed(0)}%`;
  if (percent >= 0.1) return `${percent.toFixed(1)}%`;
  return `${percent.toExponential(1)}%`;
}

function padded(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

export function formatValue(value: unknown, dataType?: string): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (dataType !== DataType.DATE) return formatCount(value);
    const { year, month, day } = epochDaysToDate(value);
    return `${year}-${padded(month)}-${padded(day)}`;
  }
  return clip(String(value), 18);
}
