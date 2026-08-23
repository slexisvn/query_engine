import type { ColumnValue } from '@engine/storage/data-type.js';

export type CsvValue = ColumnValue;
export type CsvRow = Record<string, CsvValue>;

export interface CsvTable {
  columns: string[];
  rows: CsvRow[];
}

const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?(?:\d+\.\d*|\.\d+|\d+(?:[eE][-+]?\d+))$/;
const SAFE_INTEGER_DIGITS = 15;

export function splitCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = (): void => {
    record.push(field);
    field = '';
    started = false;
  };

  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index];

    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = false;
      }
      continue;
    }

    if (character === '"' && !started) {
      quoted = true;
      started = true;
    } else if (character === ',') {
      endField();
    } else if (character === '\r') {
      if (text[index + 1] === '\n') index++;
      endRecord();
    } else if (character === '\n') {
      endRecord();
    } else {
      field += character;
      started = true;
    }
  }

  if (field !== '' || record.length > 0) endRecord();
  return records.filter(row => row.length > 1 || row[0] !== '');
}

export function coerceCell(raw: string): CsvValue {
  const text = raw.trim();
  if (text === '') return null;

  if (INTEGER.test(text) && text.replace('-', '').length <= SAFE_INTEGER_DIGITS) return Number(text);
  if (DECIMAL.test(text)) return Number(text);

  const lowered = text.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;

  return text;
}

function uniqueHeaders(raw: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((header, index) => {
    const base = header.trim() === '' ? `COLUMN_${index + 1}` : header.trim().toUpperCase();
    const previous = seen.get(base);
    if (previous === undefined) {
      seen.set(base, 1);
      return base;
    }
    seen.set(base, previous + 1);
    return `${base}_${previous + 1}`;
  });
}

export function parseCsv(text: string): CsvTable {
  const records = splitCsvRecords(text);
  if (records.length === 0) return { columns: [], rows: [] };

  const columns = uniqueHeaders(records[0]);
  const rows = records.slice(1).map(record => {
    const row: CsvRow = {};
    for (let index = 0; index < columns.length; index++) {
      row[columns[index]] = index < record.length ? coerceCell(record[index]) : null;
    }
    return row;
  });

  return { columns, rows };
}

export function tableNameFromFile(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, '');
  const cleaned = stem.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  if (cleaned === '' || /^\d/.test(cleaned)) return `T_${cleaned}`;
  return cleaned;
}
