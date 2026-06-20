import type { ColumnValue } from '../storage/data-type.js';

interface ResultLike {
  rows: Record<string, ColumnValue>[];
  columns?: string[];
  message?: string;
}

export function formatResult(result: ResultLike | null | undefined): void {
  if (!result || !result.rows || result.rows.length === 0) {
    console.log('Empty result set.');
    return;
  }

  const columnNames = result.columns || Object.keys(result.rows[0]);

  if (columnNames.length === 1 && (columnNames[0] === 'EXPLAIN_PLAN' || columnNames[0] === 'EXPLAIN_ANALYZE')) {
    console.log(`\n${result.rows[0][columnNames[0]]}\n`);
    return;
  }
  const colWidths = columnNames.map(name => name.length);

  for (const row of result.rows) {
    for (let i = 0; i < columnNames.length; i++) {
      const val = row[columnNames[i]];
      const str = String(val ?? 'NULL');
      if (str.length > colWidths[i]) {
        colWidths[i] = str.length;
      }
    }
  }

  const separator = '+' + colWidths.map(w => '-'.repeat(w + 2)).join('+') + '+';

  console.log(separator);
  console.log('|' + columnNames.map((name, i) => ' ' + name.padEnd(colWidths[i]) + ' ').join('|') + '|');
  console.log(separator);

  for (const row of result.rows) {
    console.log('|' + columnNames.map((name, i) => {
      const val = row[name];
      const str = String(val ?? 'NULL');
      return ' ' + str.padEnd(colWidths[i]) + ' ';
    }).join('|') + '|');
  }

  console.log(separator);
  console.log(`${result.rows.length} row(s) returned.\n`);
}
