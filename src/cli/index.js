import fs from 'fs';
import path from 'path';
import { Catalog } from '../catalog/catalog.js';
import { QueryEngine } from '../index.js';
import { LoaderFactory } from './loaders/loader-factory.js';
import { startREPL } from './repl.js';

async function main() {
  const args = process.argv.slice(2);
  const dataPaths = [];
  let useWasm = true;

  for (const arg of args) {
    if (arg === '--no-wasm') {
      useWasm = false;
    } else if (!arg.startsWith('-')) {
      dataPaths.push(arg);
    }
  }

  if (dataPaths.length === 0) {
    console.error('Usage: npm start -- [--no-wasm] <file1> [file2...]');
    process.exit(1);
  }

  try {
    const catalog = new Catalog();
    const engine = new QueryEngine(catalog);
    
    if (useWasm) {
      await engine.enableWasm();
    }

    if (engine.wasmEnabled) {
      console.log('⚡ WebAssembly Acceleration Enabled');
    }
    
    for (const dp of dataPaths) {
      const resolvedPath = path.resolve(process.cwd(), dp);
      if (!fs.existsSync(resolvedPath)) {
        console.error(`File not found: ${resolvedPath}`);
        process.exit(1);
      }
      const loader = LoaderFactory.getLoader(resolvedPath);
      const tableName = await loader.load(engine, resolvedPath);
      console.log(`Loaded table ${tableName} from ${dp}`);
    }
    
    startREPL(engine);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
