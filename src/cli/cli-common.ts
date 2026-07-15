import fs from 'fs';
import path from 'path';
import { LoaderFactory } from './loaders/loader-factory.js';
import type { Catalog, QueryEngine } from '../index.js';

interface LoadDataFilesOptions {
  loadOptions?: object;
  formatLoadLine?: (context: { tableName: string; rowCount: number; dataPath: string }) => string;
}

interface LoaderLike {
  load(engine: QueryEngine, filePath: string, options?: object): Promise<string>;
}

export async function loadDataFiles(
  engine: QueryEngine,
  catalog: Catalog,
  dataPaths: string[],
  options: LoadDataFilesOptions = {},
): Promise<void> {
  const loadOptions = options.loadOptions ?? {};
  const formatLoadLine = options.formatLoadLine
    ?? (({ tableName, rowCount, dataPath }) => `[load] ${tableName} (${rowCount} rows) from ${dataPath}`);

  for (const dp of dataPaths) {
    const resolvedPath = path.resolve(process.cwd(), dp);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`File not found: ${resolvedPath}`);
      process.exit(1);
    }
    const loader = LoaderFactory.getLoader(resolvedPath) as LoaderLike;
    const tableName = await loader.load(engine, resolvedPath, loadOptions);
    const storage = catalog.getTableStorage(tableName);
    const rowCount = storage ? storage.rowCount() : 0;
    console.log(formatLoadLine({ tableName, rowCount, dataPath: dp }));
  }
}
