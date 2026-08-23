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

export function formatSigned(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  return `${value > 0 ? '+' : '-'}${formatCount(Math.abs(value))}`;
}

export function percentChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0%';
  const rounded = Math.abs(value) < 1 ? value.toFixed(2) : value.toFixed(0);
  return `${value > 0 ? '+' : ''}${rounded}%`;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
