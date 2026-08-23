export type PaneKind = 'query' | 'passes' | 'stages';

export interface PaneDescriptor {
  kind: PaneKind;
  label: string;
  hint: string;
}

export const PANES: readonly PaneDescriptor[] = [
  { kind: 'query', label: 'Query', hint: 'the SQL and the catalog it runs against' },
  { kind: 'passes', label: 'Passes', hint: 'every optimizer pass, one row each' },
  { kind: 'stages', label: 'Stages', hint: 'the plan, the operators and the rows' },
];

export interface PaneRailProps {
  selected: PaneKind;
  badges: Readonly<Partial<Record<PaneKind, string>>>;
  onSelect: (kind: PaneKind) => void;
}

export function PaneRail({ selected, badges, onSelect }: PaneRailProps) {
  return (
    <nav className="pane-rail">
      {PANES.map(pane => {
        const badge = badges[pane.kind];
        return (
          <button
            key={pane.kind}
            type="button"
            className={pane.kind === selected ? 'selected' : ''}
            onClick={() => onSelect(pane.kind)}
            title={pane.hint}
            aria-current={pane.kind === selected}
          >
            {pane.label}
            {badge ? <span className="pane-badge">{badge}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
