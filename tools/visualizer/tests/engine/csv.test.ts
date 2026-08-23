import { describe, it, expect } from 'vitest';
import { coerceCell, parseCsv, splitCsvRecords, tableNameFromFile } from '../../src/engine/csv.js';

describe('splitCsvRecords', () => {
  it('splits plain rows on commas and newlines', () => {
    expect(splitCsvRecords('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps a comma that sits inside quotes', () => {
    expect(splitCsvRecords('name,note\n"Hanoi, VN",ok')).toEqual([['name', 'note'], ['Hanoi, VN', 'ok']]);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(splitCsvRecords('a\n"say ""hi"""')).toEqual([['a'], ['say "hi"']]);
  });

  it('keeps a newline that sits inside quotes', () => {
    expect(splitCsvRecords('a,b\n"one\ntwo",3')).toEqual([['a', 'b'], ['one\ntwo', '3']]);
  });

  it('treats CRLF as one record break', () => {
    expect(splitCsvRecords('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('drops blank lines', () => {
    expect(splitCsvRecords('a\n\n1\n\n')).toEqual([['a'], ['1']]);
  });

  it('keeps an empty field between two commas', () => {
    expect(splitCsvRecords('a,b,c\n1,,3')).toEqual([['a', 'b', 'c'], ['1', '', '3']]);
  });
});

describe('coerceCell', () => {
  it('reads an empty cell as null', () => {
    expect(coerceCell('   ')).toBe(null);
  });

  it('reads a whole number as a number', () => {
    expect(coerceCell('-12')).toBe(-12);
  });

  it('reads a decimal as a number', () => {
    expect(coerceCell('1.5')).toBe(1.5);
  });

  it('reads scientific notation as a number', () => {
    expect(coerceCell('2e3')).toBe(2000);
  });

  it('reads a boolean word as a boolean', () => {
    expect(coerceCell('TRUE')).toBe(true);
    expect(coerceCell('false')).toBe(false);
  });

  it('leaves an ISO date as text so it compares against a string literal', () => {
    expect(coerceCell('2024-03-15')).toBe('2024-03-15');
  });

  it('leaves an identifier that only looks numeric as text', () => {
    expect(coerceCell('007123456789012345678')).toBe('007123456789012345678');
  });

  it('leaves anything else as trimmed text', () => {
    expect(coerceCell('  north  ')).toBe('north');
  });
});

describe('parseCsv', () => {
  it('uppercases headers and keys rows by them', () => {
    expect(parseCsv('region,amount\nnorth,12').rows).toEqual([{ REGION: 'north', AMOUNT: 12 }]);
  });

  it('gives duplicate headers distinct names', () => {
    expect(parseCsv('id,id,id\n1,2,3').columns).toEqual(['ID', 'ID_2', 'ID_3']);
  });

  it('names an unlabelled column after its position', () => {
    expect(parseCsv('a,,c\n1,2,3').columns).toEqual(['A', 'COLUMN_2', 'C']);
  });

  it('pads a short row with nulls', () => {
    expect(parseCsv('a,b,c\n1').rows).toEqual([{ A: 1, B: null, C: null }]);
  });

  it('ignores cells past the last header', () => {
    expect(parseCsv('a,b\n1,2,3').rows).toEqual([{ A: 1, B: 2 }]);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual({ columns: [], rows: [] });
  });

  it('returns headers with no rows for a header-only file', () => {
    expect(parseCsv('a,b')).toEqual({ columns: ['A', 'B'], rows: [] });
  });
});

describe('tableNameFromFile', () => {
  it('strips the extension and uppercases', () => {
    expect(tableNameFromFile('sales.csv')).toBe('SALES');
  });

  it('replaces characters SQL cannot use in a name', () => {
    expect(tableNameFromFile('q1 sales-2024.csv')).toBe('Q1_SALES_2024');
  });

  it('prefixes a name that would start with a digit', () => {
    expect(tableNameFromFile('2024.csv')).toBe('T_2024');
  });
});
