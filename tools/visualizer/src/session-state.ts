import { decodeState, encodeState } from './engine/repro.js';
import type { ReproState } from './engine/repro.js';
import type { RowCounts } from './engine/demo-catalog.js';

const STORAGE_KEY = 'query-engine-visualizer/session';
const SHARE_PREFIX = '#s=';

export interface SessionState {
  sql: string;
  rowCounts: RowCounts;
}

function isRowCounts(value: unknown): value is RowCounts {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every(entry => typeof entry === 'number' && Number.isFinite(entry));
}

function clearHash(): void {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

export function readSharedState(): ReproState | null {
  if (typeof location === 'undefined' || typeof history === 'undefined' || location.hash === '') return null;

  const shared = location.hash.startsWith(SHARE_PREFIX)
    ? decodeState(location.hash.slice(SHARE_PREFIX.length))
    : null;
  clearHash();
  return shared;
}

export function shareLinkFor(state: ReproState): string {
  const base = typeof location === 'undefined' ? '' : `${location.origin}${location.pathname}${location.search}`;
  return `${base}${SHARE_PREFIX}${encodeState(state)}`;
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
