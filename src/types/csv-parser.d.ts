declare module 'csv-parser' {
  import { Transform } from 'stream';

  interface CsvParserOptions {
    separator?: string;
    quote?: string;
    escape?: string;
    newline?: string;
    headers?: string[] | boolean;
    mapHeaders?: (args: { header: string; index: number }) => string | null;
    mapValues?: (args: { header: string; index: number; value: string }) => string;
    skipLines?: number;
    skipComments?: boolean | string;
    strict?: boolean;
    maxRowBytes?: number;
  }

  function csvParser(optionsOrHeaders?: CsvParserOptions | ReadonlyArray<string>): Transform;

  export = csvParser;
}
