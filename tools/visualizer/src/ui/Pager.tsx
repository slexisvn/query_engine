import { formatCount } from './format.js';

export interface PagerProps {
  page: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  unit: string;
  note?: string;
  onPage: (page: number) => void;
}

export function pageCountOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function Pager({ page, pageCount, from, to, total, unit, note, onPage }: PagerProps) {
  if (total === 0) return null;

  return (
    <div className="pager">
      <span className="pager-range">
        {formatCount(from)}–{formatCount(to)} of {formatCount(total)} {unit}
        {note ? ` (${note})` : ''}
      </span>
      {pageCount <= 1 ? null : (
        <div className="pager-buttons">
          <button type="button" onClick={() => onPage(0)} disabled={page === 0} title="First page" aria-label="First page">«</button>
          <button type="button" onClick={() => onPage(page - 1)} disabled={page === 0} title="Previous page" aria-label="Previous page">‹</button>
          <span className="pager-position">{page + 1} / {pageCount}</span>
          <button type="button" onClick={() => onPage(page + 1)} disabled={page + 1 >= pageCount} title="Next page" aria-label="Next page">›</button>
          <button type="button" onClick={() => onPage(pageCount - 1)} disabled={page + 1 >= pageCount} title="Last page" aria-label="Last page">»</button>
        </div>
      )}
    </div>
  );
}
