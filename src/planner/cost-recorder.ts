import type { DefaultCostModel } from './cost-model.js';

export interface CostTerm {
  method: string;
  args: readonly unknown[];
  value: number;
  depth: number;
}

type CostMethod = (...args: unknown[]) => number;

export class CostRecorder {
  readonly model: DefaultCostModel;

  private terms: CostTerm[] = [];
  private depth = 0;

  constructor(base: DefaultCostModel) {
    this.model = new Proxy(base, {
      get: (target, property, receiver): unknown => {
        const member: unknown = Reflect.get(target, property, receiver);
        if (typeof member !== 'function') return member;
        return this.wrap(String(property), member as CostMethod);
      },
    });
  }

  collect(run: (model: DefaultCostModel) => void): CostTerm[] {
    this.terms = [];
    this.depth = 0;
    run(this.model);
    return this.terms;
  }

  private wrap(method: string, target: CostMethod): CostMethod {
    return (...args: unknown[]): number => {
      const term: CostTerm = { method, args, value: 0, depth: this.depth };
      this.terms.push(term);
      this.depth++;
      try {
        term.value = target.apply(this.model, args);
        return term.value;
      } finally {
        this.depth--;
      }
    };
  }
}

export function topLevelIndexes(terms: readonly CostTerm[]): number[] {
  const indexes: number[] = [];
  terms.forEach((term, index) => {
    if (term.depth === 0) indexes.push(index);
  });
  return indexes;
}

export function childIndexesOf(terms: readonly CostTerm[], parentIndex: number): number[] {
  const parentDepth = terms[parentIndex].depth;
  const children: number[] = [];

  for (let index = parentIndex + 1; index < terms.length; index++) {
    const depth = terms[index].depth;
    if (depth <= parentDepth) break;
    if (depth === parentDepth + 1) children.push(index);
  }
  return children;
}
