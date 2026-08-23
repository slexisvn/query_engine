import type { RowCounts } from './engine/demo-catalog.js';

const STORAGE_KEY = 'query-engine-visualizer/session';

export interface SessionState {
  sql: string;
  rowCounts: RowCounts;
}

function isRowCounts(value: unknown): value is RowCounts {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every(entry => typeof entry === 'number' && Number.isFinite(entry));
}

export function dropLegacyHash(): void {
  if (typeof location === 'undefined' || typeof history === 'undefined' || location.hash === '') return;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

export function readSession(): SessionState | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return null;
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { sql, rowCounts } = parsed as { sql?: unknown; rowCounts?: unknown };
    if (typeof sql !== 'string' || !isRowCounts(rowCounts)) return null;
    return { sql, rowCounts };
  } catch {
    return null;
  }
}

export function writeSession(state: SessionState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
}
