import { useCallback, useEffect, useRef, useState } from 'react';

const FEEDBACK_MS = 2200;

const LINK_HINT = 'A link that reopens this SQL, these row-count estimates and any passes you switched off.';
const REPRO_HINT =
  'The whole bug report as JSON: SQL, schema, statistics, the passes you switched off, '
  + 'and the estimated-versus-actual rows from the last run.';

export interface ShareMenuProps {
  onLink: () => string;
  onRepro: () => string;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ShareMenu({ onLink, onRepro }: ShareMenuProps) {
  const [note, setNote] = useState<string | null>(null);
  const [fallback, setFallback] = useState<{ name: string; text: string } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => setNote(null), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [note]);

  useEffect(() => {
    if (fallback === null) return;
    box.current?.select();
  }, [fallback]);

  const run = useCallback(async (build: () => string, name: string) => {
    const text = build();
    if (await copy(text)) {
      setNote(`${name} copied`);
      return;
    }
    setFallback({ name, text });
  }, []);

  return (
    <div className="share-menu">
      <button type="button" title={LINK_HINT} onClick={() => void run(onLink, 'link')}>copy link</button>
      <button type="button" title={REPRO_HINT} onClick={() => void run(onRepro, 'repro')}>copy repro</button>
      {note === null ? null : <span className="share-note">{note}</span>}

      {fallback === null ? null : (
        <div className="share-fallback">
          <header>
            <span>the clipboard is blocked here — copy the {fallback.name} by hand</span>
            <button type="button" aria-label="Close" onClick={() => setFallback(null)}>×</button>
          </header>
          <textarea ref={box} readOnly value={fallback.text} spellCheck={false} />
        </div>
      )}
    </div>
  );
}
