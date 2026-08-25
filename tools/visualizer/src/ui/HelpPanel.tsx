import { useEffect, useRef } from 'react';
import { STAGES } from './StageRail.js';

const SHORTCUTS: readonly (readonly [string, string])[] = [
  ['Ctrl / ⌘ + Enter', 'run the query'],
  ['← / →', 'previous / next pass'],
  ['Space', 'play through every pass that changed something'],
  ['R', 'replay the current pass'],
];

const COLOURS: readonly { status: string; label: string; means: string }[] = [
  { status: 'moved', label: 'blue', means: 'the same operator, in a new place' },
  { status: 'modified', label: 'amber', means: 'it stayed put, but its contents were rewritten' },
  { status: 'added', label: 'green', means: 'the pass created it' },
  { status: 'removed', label: 'removed', means: 'the pass consumed it' },
];

export interface HelpPanelProps {
  onClose: () => void;
}

export function HelpPanel({ onClose }: HelpPanelProps) {
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="help-backdrop" onClick={onClose}>
      <section
        className="help-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onClick={event => event.stopPropagation()}
      >
        <header>
          <h2 id="help-title">What this tool shows</h2>
          <button type="button" ref={close} onClick={onClose} aria-label="Close help">×</button>
        </header>

        <p>
          A database does not run your SQL as written. It first turns the text into a <strong>plan</strong> — a
          tree of operators — and then rewrites that tree, over and over, into one that computes the same
          answer for less work. This tool shows you every one of those rewrites.
        </p>

        <h3>The stages across the top</h3>
        <dl className="help-stages">
          {STAGES.map(stage => (
            <div key={stage.kind}>
              <dt>{stage.label}</dt>
              <dd>{stage.hint}</dd>
            </div>
          ))}
        </dl>
        <p className="help-note">
          Everything before <strong>Results</strong> is planning — it never touches a row of data.
        </p>

        <h3>Passes</h3>
        <p>
          A <strong>pass</strong> is one rewrite rule. The optimizer runs 27 of them in order, and most do
          nothing to any given query — a rule that fuses <code>ORDER BY</code> with <code>LIMIT</code> has
          nothing to say about a query with no <code>ORDER BY</code>. The list in the middle shows the ones
          that fired; untick <em>only changes</em> to see them all. Click one to watch it happen.
        </p>

        <h3>Colours in the plan</h3>
        <ul className="help-colours">
          {COLOURS.map(colour => (
            <li key={colour.status} className={`legend-${colour.status}`}>
              <span>{colour.label}</span> — {colour.means}
            </li>
          ))}
        </ul>

        <h3>Cost</h3>
        <p>
          The percentages are an <em>estimate</em> of how much work the plan is, not a measured time. Every
          row is priced the same way: the finished plan is handed to the physical planner and the operator
          costs are added up.
        </p>
        <p>
          That means the number is a <strong>second opinion, not the pass&apos;s own reasoning</strong>. A
          cost-based pass like <code>JoinReorder</code> chooses with its own model, so it can rearrange the
          tree and still leave the bar at 0% — the two models priced the result the same. Other passes read
          as 0% because this model prices a scan by how many rows it reads and not how wide they are, so
          dropping columns is a real saving it cannot see. Watch the plan, not just the bar.
        </p>

        <h3>Row counts</h3>
        <p>
          The catalog plans against TPC-H-sized <em>estimates</em> so the plans stay interesting, and runs
          against a small sample of real rows. That is why a node can estimate 1.5M rows and Results return
          a few hundred — the gap between estimate and reality is the thing query optimizers live with.
          Edit any row count and every cost-based pass re-decides.
        </p>

        <h3>Keyboard</h3>
        <dl className="help-keys">
          {SHORTCUTS.map(([keys, means]) => (
            <div key={keys}>
              <dt><kbd>{keys}</kbd></dt>
              <dd>{means}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
