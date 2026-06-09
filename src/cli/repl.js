import readline from 'readline';
import { highlight } from 'cli-highlight';
import { formatResult } from './format.js';

export function startREPL(engine, options = {}) {
  const coordinator = options.coordinator || null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: coordinator ? 'dist> ' : 'sql> ',
  });

  const originalWriteToOutput = rl._writeToOutput.bind(rl);
  rl._writeToOutput = function(stringToWrite) {
    const promptPatterns = ['sql> ', '...> ', 'dist> '];
    let promptIdx = -1;
    let promptLen = 0;
    for (const p of promptPatterns) {
      const idx = stringToWrite.indexOf(p);
      if (idx > -1) {
        promptIdx = idx + p.length;
        promptLen = p.length;
        break;
      }
    }

    if (promptIdx > -1) {
      const prefix = stringToWrite.substring(0, promptIdx);
      const code = stringToWrite.substring(promptIdx);
      const highlightedCode = highlight(code, { language: 'sql', ignoreIllegals: true });
      originalWriteToOutput(prefix + highlightedCode);
    } else {
      originalWriteToOutput(stringToWrite);
    }
  };

  rl._insertString = function(c) {
    if (this.cursor < this.line.length) {
      const beg = this.line.slice(0, this.cursor);
      const end = this.line.slice(this.cursor, this.line.length);
      this.line = beg + c + end;
      this.cursor += c.length;
      this._refreshLine();
    } else {
      this.line += c;
      this.cursor += c.length;
      this._refreshLine();
    }
  };

  const defaultPrompt = coordinator ? 'dist> ' : 'sql> ';
  rl.prompt();

  let queryBuffer = '';

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
      await engine.shutdown();
      rl.close();
      return;
    }
    if (trimmed === '') {
      rl.prompt();
      return;
    }

    if (trimmed.startsWith('.')) {
      await handleMetaCommand(trimmed, engine, coordinator);
      rl.prompt();
      return;
    }

    queryBuffer += (queryBuffer ? ' ' : '') + trimmed;

    if (queryBuffer.endsWith(';')) {
      try {
        console.log();
        const sql = queryBuffer;
        const startTime = performance.now();
        let result;

        if (coordinator) {
          result = await coordinator.execute(sql);
        } else {
          result = await engine.run(sql);
        }

        const endTime = performance.now();
        formatResult(result);
        const mode = coordinator ? ' [distributed]' : '';
        console.log(`Executed in ${(endTime - startTime).toFixed(2)} ms${mode}\n`);
      } catch (err) {
        console.error(err.message);
      }
      queryBuffer = '';
      rl.setPrompt(defaultPrompt);
    } else {
      rl.setPrompt('...> ');
    }
    rl.prompt();
  }).on('close', () => {
    process.exit(0);
  });
}

async function handleMetaCommand(cmd, engine, coordinator) {
  const parts = cmd.split(/\s+/);
  const command = parts[0].toLowerCase();

  switch (command) {
    case '.status': {
      console.log('');
      console.log(`  wasm:        ${engine.wasmEnabled ? 'enabled' : 'disabled'}`);
      console.log(`  parallel:    ${engine.parallelEnabled ? `enabled (${engine.workerPool?.maxWorkers} workers)` : 'disabled'}`);
      const distInfo = engine.distributed
        ? (() => {
          const workers = engine.distributed.clusterManager.getWorkerNodes?.() || [];
          return `enabled (node: ${engine.distributed.localNode.nodeId}, ${workers.length} worker(s))`;
        })()
        : 'disabled';
      console.log(`  distributed: ${distInfo}`);
      console.log(`  mode:        ${coordinator ? 'distributed (queries go through coordinator)' : 'local'}`);
      console.log('');
      break;
    }
    case '.tables': {
      const tables = engine.catalog.listTables();
      if (tables.length === 0) {
        console.log('\n  No tables loaded.\n');
      } else {
        console.log('');
        for (const name of tables) {
          const storage = engine.catalog.getTableStorage(name);
          const rows = storage ? storage.rowCount() : '?';
          const tableDef = engine.catalog.getTable(name);
          const cols = tableDef ? tableDef.columns.map(c => c.name).join(', ') : '';
          console.log(`  ${name} (${rows} rows) - [${cols}]`);
        }
        console.log('');
      }
      break;
    }
    case '.explain': {
      const sql = parts.slice(1).join(' ');
      if (!sql) {
        console.log('\n  Usage: .explain <sql query>\n');
        break;
      }
      try {
        const compiled = await engine.compile(sql.endsWith(';') ? sql : sql + ';');
        if (compiled.ddl) {
          console.log('\n  DDL statement, no plan.\n');
          break;
        }
        let plan = compiled.plan;
        if (coordinator) {
          plan._distributed = true;
          plan = engine.optimize(plan);
        }
        const { planToString } = await import('../planner/logical-plan.js');
        console.log('');
        console.log(planToString(plan));
      } catch (err) {
        console.error(err.message);
      }
      break;
    }
    case '.help': {
      console.log('');
      console.log('  .status         Show engine status');
      console.log('  .tables         List loaded tables');
      console.log('  .explain <sql>  Show query plan');
      console.log('  exit / quit     Exit');
      console.log('');
      break;
    }
    default:
      console.log(`\n  Unknown command: ${command}. Type .help for available commands.\n`);
  }
}
