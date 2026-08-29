import { noteFor, STAGE_NOTES } from '../content/pass-notes.js';
import { isEmptySummary } from '../engine/step-summary.js';
import { formatMs } from './format.js';
import type { LabelCount, StepSummary } from '../engine/step-summary.js';
import type { JoinOrderNote } from '../engine/join-order-note.js';
import type { PassStep } from '../engine/trace.js';

const TIMED_PASS_FLOOR_MS = 1;

export interface PassNotesProps {
  step: PassStep | null;
  summary: StepSummary | null;
  joinOrder: JoinOrderNote | null;
}

function ChangeLine({ kind, entries }: { kind: string; entries: readonly LabelCount[] }) {
  if (entries.length === 0) return null;

  return (
    <li className={`change-${kind}`}>
      <span className="change-kind">{kind}</span>
      <span className="change-labels">
        {entries.map(entry => (entry.count === 1 ? entry.label : `${entry.label} ×${entry.count}`)).join(', ')}
      </span>
    </li>
  );
}

function Changes({ summary }: { summary: StepSummary }) {
  if (isEmptySummary(summary)) return null;

  return (
    <ul className="note-changes">
      <ChangeLine kind="added" entries={summary.added} />
      <ChangeLine kind="removed" entries={summary.removed} />
      <ChangeLine kind="rewritten" entries={summary.modified} />
      {summary.moved === 0 ? null : (
        <li className="change-moved">
          <span className="change-kind">moved</span>
          <span className="change-labels">{summary.moved} {summary.moved === 1 ? 'node' : 'nodes'}</span>
        </li>
      )}
    </ul>
  );
}

function JoinOrder({ note }: { note: JoinOrderNote }) {
  if (note.clusters.length === 0) return null;

  return (
    <ul className="note-changes">
      {note.clusters.map((cluster, index) => (
        <li key={index} className={cluster.enumerator === 'DPhyp' ? 'change-added' : 'change-rewritten'}>
          <span className="change-kind">{cluster.enumerator}</span>
          <span className="change-labels">
            {cluster.relations} relations{cluster.enumerator === 'greedy'
              ? ` — past the ${note.dpLimit} that exhaustive search handles, so the order is a heuristic`
              : ` — within the ${note.dpLimit} exhaustive search handles`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PassNotes({ step, summary, joinOrder }: PassNotesProps) {
  if (!step) {
    return (
      <section className="pass-notes empty">
        <p>Pick a pass above to see what it does and watch the plan change.</p>
      </section>
    );
  }

  const note = noteFor(step.pass);
  const stageNote = STAGE_NOTES[step.stage];

  return (
    <section className="pass-notes">
      <h3>
        {note?.title ?? step.pass}
        {step.ms >= TIMED_PASS_FLOOR_MS ? <span className="note-timing">{formatMs(step.ms)}</span> : null}
      </h3>
      {note ? (
        <>
          <p className="note-summary">{note.summary}</p>
          <p className="note-why"><strong>Why it pays off.</strong> {note.why}</p>
          <p className="note-trigger"><strong>Fires on.</strong> <code>{note.trigger}</code></p>
        </>
      ) : null}
      {summary === null ? null : <Changes summary={summary} />}
      {joinOrder === null ? null : <JoinOrder note={joinOrder} />}
      {step.repeats === null ? null : (
        <p className="note-cycle">
          This run put the plan back into the shape step {step.repeats + 1} already produced — the fixpoint is cycling.
        </p>
      )}
      {stageNote ? <p className="note-stage"><strong>{step.stage}.</strong> {stageNote}</p> : null}
      {step.changed ? null : <p className="note-noop">This run left the plan untouched.</p>}
    </section>
  );
}
