export type StageKind = 'parse' | 'bind' | 'plan' | 'optimize' | 'physical' | 'results';

export type StagePhase = 'compile' | 'execute';

export interface StageDescriptor {
  kind: StageKind;
  label: string;
  phase: StagePhase;
  hint: string;
}

export const STAGES: readonly StageDescriptor[] = [
  { kind: 'parse', label: 'Parse', phase: 'compile', hint: 'SQL text into an abstract syntax tree' },
  { kind: 'bind', label: 'Bind', phase: 'compile', hint: 'names resolved against the catalog, types inferred' },
  { kind: 'plan', label: 'Plan', phase: 'compile', hint: 'bound query into an unoptimized logical plan' },
  { kind: 'optimize', label: 'Optimize', phase: 'compile', hint: 'the rewrite passes, one at a time' },
  { kind: 'physical', label: 'Physical', phase: 'compile', hint: 'logical operators into executable ones' },
  { kind: 'results', label: 'Results', phase: 'execute', hint: 'the rows the query computed when it ran' },
];

export interface StageBadge {
  text: string;
  tone?: 'error';
}

export interface StageRailProps {
  selected: StageKind;
  badges: Readonly<Partial<Record<StageKind, StageBadge>>>;
  onSelect: (kind: StageKind) => void;
}

interface StageGroupProps extends StageRailProps {
  phase: StagePhase;
  caption: string;
}

function StageGroup({ phase, caption, selected, badges, onSelect }: StageGroupProps) {
  return (
    <div className="stage-phase">
      <span className="stage-caption">{caption}</span>
      <div className="stage-group">
        {STAGES.filter(stage => stage.phase === phase).map(stage => (
          <button
            key={stage.kind}
            type="button"
            className={stage.kind === selected ? 'selected' : ''}
            onClick={() => onSelect(stage.kind)}
            title={stage.hint}
          >
            {stage.label}
            {badges[stage.kind] ? (
              <span className={`stage-badge${badges[stage.kind]?.tone === 'error' ? ' failed' : ''}`}>
                {badges[stage.kind]?.text}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function StageRail(props: StageRailProps) {
  return (
    <nav className="stage-rail">
      <StageGroup {...props} phase="compile" caption="planning" />
      <StageGroup {...props} phase="execute" caption="running" />
    </nav>
  );
}
