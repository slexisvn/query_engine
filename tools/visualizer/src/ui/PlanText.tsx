import { useMemo } from 'react';
import { planViewToText, toPlanView } from '../engine/plan-view.js';
import { countKind, diffLines } from '../engine/text-diff.js';
import type { LogicalPlanNode } from '@engine/planner/logical-plan.js';

const MARKERS: Readonly<Record<string, string>> = { context: ' ', added: '+', removed: '-', moved: '~' };

export interface PlanTextProps {
  before: LogicalPlanNode | null;
  after: LogicalPlanNode;
}

function planLines(plan: LogicalPlanNode): string[] {
  return planViewToText(toPlanView(plan));
}

export function PlanText({ before, after }: PlanTextProps) {
  const rows = useMemo(() => {
    const afterLines = planLines(after);
    if (before === null) return afterLines.map(text => ({ kind: 'context' as const, text }));
    return diffLines(planLines(before), afterLines);
  }, [before, after]);

  const removed = countKind(rows, 'removed');
  const added = countKind(rows, 'added');
  const moved = countKind(rows, 'moved');

  return (
    <div className="plan-diff">
      <header>
        {before === null ? (
          <span className="diff-unchanged">{rows.length} lines</span>
        ) : removed === 0 && added === 0 && moved === 0 ? (
          <span className="diff-unchanged">no lines changed</span>
        ) : (
          <>
            {removed === 0 ? null : <span className="diff-count removed">−{removed} removed</span>}
            {added === 0 ? null : <span className="diff-count added">+{added} added</span>}
            {moved === 0 ? null : <span className="diff-count moved">~{moved} re-nested</span>}
          </>
        )}
      </header>
      <div className="diff-body">
        {rows.map((row, index) => (
          <div key={index} className={`diff-row ${row.kind}`}>
            <span className="diff-marker">{MARKERS[row.kind]}</span>
            <span className="diff-text">{row.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
