import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { DataType } from '../../storage/data-type.js';
import { globalDispatch } from '../../wasm/dispatch.js';
import { isVectorizableExpr, evalVectorized } from '../wasm-expr-eval.js';

export class StreamAggregateOperator {
  groupByExtractors: any;
  groupByTypes: any;
  aggregateDefs: any;
  hasCachedValues: boolean;

  constructor(groupByExtractors: any, groupByTypes: any, aggregateDefs: any) {
    this.groupByExtractors = groupByExtractors;
    this.groupByTypes = groupByTypes;
    this.aggregateDefs = aggregateDefs;
    this.hasCachedValues = aggregateDefs.some((def: any) => def.valueKey);
  }

  async init(): Promise<void> {}

  _resolveWasmAggKernel(def: any): any {
    const name = def.name?.toUpperCase();
    if (!name) return null;

    if (name === 'SUM' && def.resultType === 'FLOAT64') {
      if (globalDispatch.has('sumF64', 'FLOAT64')) return { kernelKey: 'sumF64', dataType: 'FLOAT64', kind: 'SUM' };
      if (globalDispatch.has('sumI32', 'INT32')) return { kernelKey: 'sumI32', dataType: 'INT32', kind: 'SUM' };
    }
    if (name === 'MIN') {
      if (def.resultType === 'FLOAT64' && globalDispatch.has('minF64', 'FLOAT64')) return { kernelKey: 'minF64', dataType: 'FLOAT64', kind: 'MIN' };
      if (def.resultType === 'INT32' && globalDispatch.has('minI32', 'INT32')) return { kernelKey: 'minI32', dataType: 'INT32', kind: 'MIN' };
    }
    if (name === 'MAX') {
      if (def.resultType === 'FLOAT64' && globalDispatch.has('maxF64', 'FLOAT64')) return { kernelKey: 'maxF64', dataType: 'FLOAT64', kind: 'MAX' };
      if (def.resultType === 'INT32' && globalDispatch.has('maxI32', 'INT32')) return { kernelKey: 'maxI32', dataType: 'INT32', kind: 'MAX' };
    }
    if (name === 'COUNT') {
      return { kernelKey: 'countBits', dataType: 'UINT8', kind: 'COUNT' };
    }
    if (name === 'COUNT_STAR') {
      return { kernelKey: null, dataType: null, kind: 'COUNT_STAR' };
    }
    if (name === 'AVG' && def.resultType === 'FLOAT64') {
      if (globalDispatch.has('sumF64', 'FLOAT64')) return { kernelKey: 'sumF64', dataType: 'FLOAT64', kind: 'AVG' };
    }
    return null;
  }

  async _tryWasmUngrouped(chunks: any): Promise<any> {
    if (this.groupByExtractors.length !== 0) return null;
    if (!globalDispatch || globalDispatch.kernels.size === 0) return null;

    const accumulators = this.aggregateDefs.map((def: any) => def.createAccumulator());

    for (const chunk of chunks) {
      if (chunk.selectionVector || chunk.size === 0) return null;

      for (let a = 0; a < this.aggregateDefs.length; a++) {
        const def = this.aggregateDefs[a];
        const resolved = this._resolveWasmAggKernel(def);
        if (!resolved) return null;

        const acc = accumulators[a];

        if (resolved.kind === 'COUNT_STAR') {
          acc.count += chunk.size;
          continue;
        }

        if (resolved.kind === 'COUNT') {
          if (!def._wasmColIndex && def._wasmColIndex !== 0) return null;
          const column = chunk.columns[def._wasmColIndex];
          if (!column) return null;
          if (!column.hasNulls) {
            acc.count += chunk.size;
          } else {
            const kernel = globalDispatch.lookup('countBits', 'UINT8');
            if (!kernel) return null;
            const nonNullCount = await kernel(column.nullBitmap, chunk.size);
            acc.count += nonNullCount;
          }
          continue;
        }

        if (resolved.kind === 'AVG') {
          if (!def._wasmColIndex && def._wasmColIndex !== 0) return null;
          const column = chunk.columns[def._wasmColIndex];
          if (!column || !column.data) return null;
          if (column.dataType !== 'FLOAT64') return null;

          const rawData = column.data.subarray(0, chunk.size);
          const kernel = globalDispatch.lookup(resolved.kernelKey, resolved.dataType);
          if (!kernel) return null;
          const sum = await kernel(rawData);

          let nonNullCount: any;
          if (!column.hasNulls) {
            nonNullCount = chunk.size;
          } else {
            const countKernel = globalDispatch.lookup('countBits', 'UINT8');
            if (!countKernel) return null;
            nonNullCount = await countKernel(column.nullBitmap, chunk.size);
          }

          acc.sum += sum;
          acc.count += nonNullCount;
          continue;
        }

        let rawData: any = null;

        if (def._wasmColIndex !== undefined && def._wasmColIndex !== null) {
          const column = chunk.columns[def._wasmColIndex];
          if (column && column.data) {
            const colType = column.dataType;
            if (resolved.dataType === 'FLOAT64' && colType === 'FLOAT64') {
              rawData = column.data.subarray(0, chunk.size);
            } else if (resolved.dataType === 'INT32' && (colType === 'INT32' || colType === 'DATE')) {
              rawData = column.data.subarray(0, chunk.size);
            }
          }
        }

        if (!rawData && def._sourceExpr && isVectorizableExpr(def._sourceExpr)) {
          const vectorResult = await evalVectorized(def._sourceExpr, chunk, def._columnMapping, chunk.size);
          if (vectorResult instanceof Float64Array) rawData = vectorResult;
        }

        if (!rawData) return null;

        const kernel = globalDispatch.lookup(resolved.kernelKey, resolved.dataType);
        if (!kernel) return null;
        acc.add(await kernel(rawData));
      }
    }

    const row = accumulators.map((a: any) => a.result());
    const columns = [];
    for (let a = 0; a < this.aggregateDefs.length; a++) {
      const col = new Column(this.aggregateDefs[a].resultType, 1);
      col.set(0, typeof row[a] === 'bigint' ? Number(row[a]) : row[a]);
      col.length = 1;
      columns.push(col);
    }

    return [new DataChunk(columns, 1)];
  }

  async execute(chunks: any): Promise<any> {
    const wasmResult = await this._tryWasmUngrouped(chunks);
    if (wasmResult !== null) return wasmResult;

    const outputRows = [];

    let currentKey: any = null;
    let groupValues: any = null;
    let accumulators: any = null;

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
          groupValues = this.groupByExtractors.map((fn: any) => fn(chunk, rowIdx));
          accumulators = this.aggregateDefs.map((def: any) => def.createAccumulator());
        }

        if (accumulators !== null) {
          const valueCache = this.hasCachedValues ? Object.create(null) : null;
          for (let a = 0; a < this.aggregateDefs.length; a++) {
            const def = this.aggregateDefs[a];
            let val: any;
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
      const acc = this.aggregateDefs.map((def: any) => def.createAccumulator());
      outputRows.push(acc.map((a: any) => a.result()));
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

  extractGroupKey(chunk: any, rowIdx: any): any {
    if (this.groupByExtractors.length === 0) return '__ALL__';
    return this.groupByExtractors.map((fn: any) => {
      const v = fn(chunk, rowIdx);
      return typeof v === 'bigint' ? v.toString() : String(v);
    }).join('|');
  }
}
