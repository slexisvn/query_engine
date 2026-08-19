import type { EvalValue } from './execution-types.js';

const NULL_MARK = 'n';
const LENGTH_TERMINATOR = ':';
const UNTYPED_TAG = 'x';

const VALUE_TAGS: Record<string, string> = {
  string: 's',
  number: 'd',
  bigint: 'i',
  boolean: 'b',
};

export function encodeCompositeKey(values: readonly EvalValue[]): string {
  let key = '';
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === null || value === undefined) {
      key += NULL_MARK;
      continue;
    }
    const text = typeof value === 'string' ? value : String(value);
    key += (VALUE_TAGS[typeof value] ?? UNTYPED_TAG) + text.length + LENGTH_TERMINATOR + text;
  }
  return key;
}
