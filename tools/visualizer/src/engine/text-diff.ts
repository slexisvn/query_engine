export type DiffKind = 'context' | 'added' | 'removed' | 'moved';

export interface DiffRow {
  kind: DiffKind;
  text: string;
}

function commonPrefix(before: readonly string[], after: readonly string[]): number {
  const limit = Math.min(before.length, after.length);
  let index = 0;
  while (index < limit && before[index] === after[index]) index++;
  return index;
}

function commonSuffix(before: readonly string[], after: readonly string[], floor: number): number {
  const limit = Math.min(before.length, after.length) - floor;
  let index = 0;
  while (index < limit && before[before.length - 1 - index] === after[after.length - 1 - index]) index++;
  return index;
}

function longestCommonTable(before: readonly string[], after: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: before.length + 1 }, () => new Array<number>(after.length + 1).fill(0));

  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i][j] = before[i] === after[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  return table;
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function take(counts: Map<string, number>, key: string): boolean {
  const remaining = counts.get(key) ?? 0;
  if (remaining === 0) return false;
  counts.set(key, remaining - 1);
  return true;
}

function foldIndentShifts(rows: readonly DiffRow[]): DiffRow[] {
  const removedByText = new Map<string, number>();
  for (const row of rows) if (row.kind === 'removed') bump(removedByText, row.text.trim());

  const pairedByText = new Map<string, number>();
  const promoted = rows.map(row => {
    if (row.kind !== 'added' || !take(removedByText, row.text.trim())) return row;
    bump(pairedByText, row.text.trim());
    return { kind: 'moved' as const, text: row.text };
  });

  return promoted.filter(row => row.kind !== 'removed' || !take(pairedByText, row.text.trim()));
}

function alignLines(before: readonly string[], after: readonly string[]): DiffRow[] {
  const head = commonPrefix(before, after);
  const tail = commonSuffix(before, after, head);
  const beforeCore = before.slice(head, before.length - tail);
  const afterCore = after.slice(head, after.length - tail);

  const rows: DiffRow[] = before.slice(0, head).map(text => ({ kind: 'context' as const, text }));
  const table = longestCommonTable(beforeCore, afterCore);

  let i = 0;
  let j = 0;
  while (i < beforeCore.length && j < afterCore.length) {
    if (beforeCore[i] === afterCore[j]) {
      rows.push({ kind: 'context', text: beforeCore[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ kind: 'removed', text: beforeCore[i] });
      i++;
    } else {
      rows.push({ kind: 'added', text: afterCore[j] });
      j++;
    }
  }

  while (i < beforeCore.length) rows.push({ kind: 'removed', text: beforeCore[i++] });
  while (j < afterCore.length) rows.push({ kind: 'added', text: afterCore[j++] });

  for (const text of after.slice(after.length - tail)) rows.push({ kind: 'context', text });
  return rows;
}

export function diffLines(before: readonly string[], after: readonly string[]): DiffRow[] {
  return foldIndentShifts(alignLines(before, after));
}

export function countKind(rows: readonly DiffRow[], kind: DiffKind): number {
  return rows.reduce((total, row) => (row.kind === kind ? total + 1 : total), 0);
}
