import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { DataType } from '../../storage/data-type.js';

export class StreamAggregateOperator {
  constructor(groupByExtractors, groupByTypes, aggregateDefs) {
    this.groupByExtractors = groupByExtractors;
    this.groupByTypes = groupByTypes;
    this.aggregateDefs = aggregateDefs;
    this.hasCachedValues = aggregateDefs.some(def => def.valueKey);
  }

  async init() {}

  async execute(chunks) {
    const outputRows = [];

        let currentKey = null;
    let groupValues = null;
    let accumulators = null;

    for (const chunk of chunks) {
      for (let i = 0; i < chunk.size; i++) {
        const rowIdx = chunk.activeRowIndex(i);
        const key = this.extractGroupKey(chunk, rowIdx);

        if (currentKey !== key) {
          if (accumulators !== null) {
            const row = [...groupValues];
            for (let a = 0; a < accumulators.length; a++) {
              row.push(accumulators[a].result());
            }
            outputRows.push(row);
          }
          currentKey = key;
          groupValues = this.groupByExtractors.map(fn => fn(chunk, rowIdx));
          accumulators = this.aggregateDefs.map(def => def.createAccumulator());
        }

        if (accumulators !== null) {
          const valueCache = this.hasCachedValues ? Object.create(null) : null;
          for (let a = 0; a < this.aggregateDefs.length; a++) {
            const def = this.aggregateDefs[a];
            let val;
            if (valueCache && def.valueKey) {
              if (Object.prototype.hasOwnProperty.call(valueCache, def.valueKey)) {
                val = valueCache[def.valueKey];
              } else {
                val = def.extractValue(chunk, rowIdx);
                valueCache[def.valueKey] = val;
              }
            } else {
              val = def.extractValue(chunk, rowIdx);
            }
            accumulators[a].add(val);
          }
        }
      }
    }

    if (accumulators !== null) {
      const row = [...groupValues];
      for (let a = 0; a < accumulators.length; a++) {
        row.push(accumulators[a].result());
      }
      outputRows.push(row);
    } else if (this.groupByExtractors.length === 0) {
      const acc = this.aggregateDefs.map(def => def.createAccumulator());
      outputRows.push(acc.map(a => a.result()));
    }

    if (outputRows.length === 0) return [];

    const totalCols = this.groupByExtractors.length + this.aggregateDefs.length;
    const columns = [];

    for (let g = 0; g < this.groupByExtractors.length; g++) {
      columns.push(new Column(this.groupByTypes[g] || DataType.VARCHAR, outputRows.length));
    }
    for (let a = 0; a < this.aggregateDefs.length; a++) {
      columns.push(new Column(this.aggregateDefs[a].resultType, outputRows.length));
    }

    for (let r = 0; r < outputRows.length; r++) {
      const row = outputRows[r];
      for (let c = 0; c < totalCols; c++) {
        columns[c].set(r, typeof row[c] === 'bigint' ? Number(row[c]) : row[c]);
      }
    }

    for (const col of columns) col.length = outputRows.length;

    return [new DataChunk(columns, outputRows.length)];
  }

  extractGroupKey(chunk, rowIdx) {
    if (this.groupByExtractors.length === 0) return '__ALL__';
    return this.groupByExtractors.map(fn => {
      const v = fn(chunk, rowIdx);
      return typeof v === 'bigint' ? v.toString() : String(v);
    }).join('|');
  }
}
