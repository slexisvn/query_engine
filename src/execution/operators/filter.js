import { DataChunk } from '../../storage/chunk.js';

export class FilterOperator {
  constructor(predicate, evaluator) {
    this.predicate = predicate;
    this.evaluator = evaluator;
  }

  async init() {}

  async process(chunk) {
    const size = chunk.size;
    if (size === 0) return new DataChunk(chunk.columns, 0);

    const sv = new Uint32Array(size);
    let count = 0;

    if (chunk.selectionVector) {
      const inputSv = chunk.selectionVector;
      for (let i = 0; i < size; i++) {
        const rowIdx = inputSv[i];
        if (this.evaluator(chunk, rowIdx)) {
          sv[count++] = rowIdx;
        }
      }
    } else {
      for (let i = 0; i < size; i++) {
        if (this.evaluator(chunk, i)) {
          sv[count++] = i;
        }
      }
    }

    if (count === 0) {
      return new DataChunk(chunk.columns, 0);
    }

    if (count === size) {
      return chunk;
    }

    const result = new DataChunk(chunk.columns, count);
    if (count > 64) {
      result.setSelectionVector(sv.subarray(0, count), count);
    } else {
      result.setSelectionVector(sv.slice(0, count), count);
    }
    return result;
  }
}
