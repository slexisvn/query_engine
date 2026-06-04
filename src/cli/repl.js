import readline from 'readline';
import { highlight } from 'cli-highlight';
import { formatResult } from './format.js';

export function startREPL(engine) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'sql> ',
  });

  const originalWriteToOutput = rl._writeToOutput.bind(rl);
  rl._writeToOutput = function(stringToWrite) {
    const promptIdx1 = stringToWrite.indexOf('sql> ');
    const promptIdx2 = stringToWrite.indexOf('...> ');
    const promptIdx = promptIdx1 > -1 ? promptIdx1 + 5 : (promptIdx2 > -1 ? promptIdx2 + 5 : -1);
    
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

  rl.prompt();

  let queryBuffer = '';

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
      rl.close();
      return;
    }
    if (trimmed === '') {
      rl.prompt();
      return;
    }

    queryBuffer += (queryBuffer ? ' ' : '') + trimmed;

    if (queryBuffer.endsWith(';')) {
      try {
        console.log(); 
        const startTime = performance.now();
        const result = await engine.run(queryBuffer);
        const endTime = performance.now();
        formatResult(result);
        console.log(`Executed in ${(endTime - startTime).toFixed(2)} ms\n`);
      } catch (err) {
        console.error(err.message);
      }
      queryBuffer = '';
      rl.setPrompt('sql> ');
    } else {
      rl.setPrompt('...> ');
    }
    rl.prompt();
  }).on('close', () => {
    process.exit(0);
  });
}
