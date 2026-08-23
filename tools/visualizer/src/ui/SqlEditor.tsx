import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { sql, StandardSQL } from '@codemirror/lang-sql';
import { DEMO_SCHEMA } from '../engine/demo-catalog.js';

export interface SqlEditorProps {
  value: string;
  onChange: (next: string) => void;
}

export function SqlEditor({ value, onChange }: SqlEditorProps) {
  const extensions = useMemo(() => {
    const schema: Record<string, string[]> = {};
    for (const [table, columns] of Object.entries(DEMO_SCHEMA)) schema[table] = [...columns];
    return [sql({ dialect: StandardSQL, schema, upperCaseKeywords: true })];
  }, []);

  return (
    <CodeMirror
      className="sql-editor"
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme="dark"
      height="100%"
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false, autocompletion: true }}
    />
  );
}
