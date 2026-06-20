import path from 'path';
import { CSVLoader } from './csv-loader.js';
import { JSONLoader } from './json-loader.js';
import type { DataLoader } from './data-loader.js';

export class LoaderFactory {
  static getLoader(filePath: string): DataLoader {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.csv':
        return new CSVLoader();
      case '.json':
        return new JSONLoader();
      default:
        throw new Error(`Unsupported file extension: ${ext}`);
    }
  }
}
