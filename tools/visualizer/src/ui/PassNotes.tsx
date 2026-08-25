import { noteFor, STAGE_NOTES } from '../content/pass-notes.js';
import type { PassStep } from '../engine/trace.js';

export interface PassNotesProps {
  step: PassStep | null;
}

export function PassNotes({ step }: PassNotesProps) {
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
      <h3>{note?.title ?? step.pass}</h3>
      {note ? (
        <>
          <p className="note-summary">{note.summary}</p>
          <p className="note-why"><strong>Why it pays off.</strong> {note.why}</p>
          <p className="note-trigger"><strong>Fires on.</strong> <code>{note.trigger}</code></p>
        </>
      ) : null}
      {stageNote ? <p className="note-stage"><strong>{step.stage}.</strong> {stageNote}</p> : null}
      {step.changed ? null : <p className="note-noop">This run left the plan untouched.</p>}
    </section>
  );
}
