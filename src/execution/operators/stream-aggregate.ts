import { Column } from '../../storage/column.js';
import { DataChunk } from '../../storage/chunk.js';
import { DataType, type ColumnValue } from '../../storage/data-type.js';
import { globalDispatch } from '../../wasm/dispatch.js';
import { isVectorizableExpr, evalVectorized } from '../wasm-expr-eval.js';
import { resolveWasmAggKernel, type ScalarReduceKernel, type BitmapCountKernel } from './agg-wasm.js';
import { encodeCompositeKey } from '../composite-key.js';
import { GLOBAL_GROUP_KEY } from './hash-aggregate.js';
import type { BoundExpr } from '../../binder/expression-binder.js';
import type { CompiledExpr, ColumnMapping, EvalValue } from '../execution-types.js';
import { KernelOperand } from '../../wasm/wasm-types.js';

interface Accumulator {
  add(val: EvalValue): void;
  result(): ColumnValue;
}

interface NumericAccumulator extends Accumulator {
  sum: number;
  count: number;
}

interface AggregateDef {
  name: string;
  valueKey: string | null;
  resultType: DataType;
  createAccumulator: () => Accumulator;
  extractValue: CompiledExpr;
  _wasmColIndex?: number;
  _sourceExpr: BoundExpr | null;
  _columnMapping: ColumnMapping;
}

export class StreamAggregateOperator {
  groupByExtractors: CompiledExpr[];
  groupByTypes: DataType[];
  aggregateDefs: AggregateDef[];
  hasCachedValues: boolean;

  constructor(groupByExtractors: CompiledExpr[], groupByTypes: DataType[], aggregateDefs: AggregateDef[]) {
    this.groupByExtractors = groupByExtractors;
    this.groupByTypes = groupByTypes;
    this.aggregateDefs = aggregateDefs;
    this.hasCachedValues = aggregateDefs.some((def) => def.valueKey);
  }

  async init(): Promise<void> {}

  async _tryWasmUngrouped(chunks: DataChunk[]): Promise<DataChunk[] | null> {
    if (this.groupByExtractors.length !== 0) return null;
    if (!globalDispatch || globalDispatch.kernels.size === 0) return null;

    const accumulators = this.aggregateDefs.map((def) => def.createAccumulator());

    for (const chunk of chunks) {
      if (chunk.selectionVector || chunk.size === 0) return null;

      for (let a = 0; a < this.aggregateDefs.length; a++) {
        const def = this.aggregateDefs[a];
        const resolved = resolveWasmAggKernel(def, globalDispatch);
        if (!resolved) return null;

        const acc = accumulators[a] as NumericAccumulator;

        if (resolved.kind === 'COUNT_STAR') {
          acc.count += chunk.size;
          continue;
        }

        if (resolved.kind === 'COUNT') {
          if (!def._wasmColIndex && def._wasmColIndex !== 0) return null;
          const column = chunk.columns[def._wasmColIndex] as Column;
          if (!column) return null;
          if (!column.hasNulls) {
            acc.count += chunk.size;
          } else {
            const kernel = globalDispatch.lookup('countBits', KernelOperand.BITMAP) as BitmapCountKernel | null;
            if (!kernel) return null;
            const nonNullCount = await kernel(column.nullBitmap, chunk.size);
            acc.count += nonNullCount;
          }
          continue;
        }

        if (resolved.kind === 'AVG') {
          if (!def._wasmColIndex && def._wasmColIndex !== 0) return null;
          const column = chunk.columns[def._wasmColIndex] as Column;
          if (!column || !column.data) return null;
          if (column.dataType !== 'FLOAT64') return null;

          const rawData = (column.data as Float64Array).subarray(0, chunk.size);
          const kernel = globalDispatch.lookup(resolved.kernelKey!, resolved.operand!) as ScalarReduceKernel | null;
          if (!kernel) return null;
          const sum = await kernel(rawData);

          let nonNullCount: number;
          if (!column.hasNulls) {
            nonNullCount = chunk.size;
          } else {
            const countKernel = globalDispatch.lookup('countBits', KernelOperand.BITMAP) as BitmapCountKernel | null;
            if (!countKernel) return null;
            nonNullCount = await countKernel(column.nullBitmap, chunk.size);
          }

          acc.sum += sum;
          acc.count += nonNullCount;
          continue;
        }

        let rawData: Float64Array | null = null;

        if (def._wasmColIndex !== undefined && def._wasmColIndex !== null) {
          const column = chunk.columns[def._wasmColIndex] as Column;
          if (column && column.data) {
            const colType = column.dataType;
            if (resolved.operand === 'FLOAT64' && colType === 'FLOAT64') {
              rawData = (column.data as Float64Array).subarray(0, chunk.size);
            } else if (resolved.operand === 'INT32' && (colType === 'INT32' || colType === 'DATE')) {
              rawData = (column.data as Float64Array).subarray(0, chunk.size);
            }
          }
        }

        if (!rawData && def._sourceExpr && isVectorizableExpr(def._sourceExpr)) {
          const vectorResult = await evalVectorized(def._sourceExpr, chunk, def._columnMapping, chunk.size);
          if (vectorResult instanceof Float64Array) rawData = vectorResult;
        }

        if (!rawData) return null;

        const kernel = globalDispatch.lookup(resolved.kernelKey!, resolved.operand!) as ScalarReduceKernel | null;
        if (!kernel) return null;
        acc.add(await kernel(rawData));
      }
    }

    const row = accumulators.map((a) => a.result());
    const columns: Column[] = [];
    for (let a = 0; a < this.aggregateDefs.length; a++) {
      const col = new Column(this.aggregateDefs[a].resultType, 1);
      col.set(0, typeof row[a] === 'bigint' ? Number(row[a]) : row[a]);
      col.length = 1;
      columns.push(col);
    }

    return [new DataChunk(columns, 1)];
  }

  async execute(chunks: DataChunk[]): Promise<DataChunk[]> {
    const wasmResult = await this._tryWasmUngrouped(chunks);
    if (wasmResult !== null) return wasmResult;

    const outputRows: ColumnValue[][] = [];

    let currentKey: string | null = null;
    let groupValues: ColumnValue[] | null = null;
    let accumulators: Accumulator[] | null = null;

    for (const chunk of chunks) {
      for (let i = 0; i < chunk.size; i++) {
        const rowIdx = chunk.activeRowIndex(i);
        const key = this.extractGroupKey(chunk, rowIdx);

        if (currentKey !== key) {
          if (accumulators !== null) {
            const row = [...groupValues!];
            for (let a = 0; a < accumulators.length; a++) {
              row.push(accumulators[a].result());
            }
            outputRows.push(row);
          }
          currentKey = key;
          groupValues = this.groupByExtractors.map((fn) => fn(chunk, rowIdx) as ColumnValue);
          accumulators = this.aggregateDefs.map((def) => def.createAccumulator());
        }

        if (accumulators !== null) {
          const valueCache: Record<string, EvalValue> | null = this.hasCachedValues ? Object.create(null) : null;
          for (let a = 0; a < this.aggregateDefs.length; a++) {
            const def = this.aggregateDefs[a];
            let val: EvalValue;
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
      const row = [...groupValues!];
      for (let a = 0; a < accumulators.length; a++) {
        row.push(accumulators[a].result());
      }
      outputRows.push(row);
    } else if (this.groupByExtractors.length === 0) {
      const acc = this.aggregateDefs.map((def) => def.createAccumulator());
      outputRows.push(acc.map((a) => a.result()));
    }

    if (outputRows.length === 0) return [];

    const totalCols = this.groupByExtractors.length + this.aggregateDefs.length;
    const columns: Column[] = [];

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

  extractGroupKey(chunk: DataChunk, rowIdx: number): string {
    if (this.groupByExtractors.length === 0) return GLOBAL_GROUP_KEY;
    return encodeCompositeKey(this.groupByExtractors.map((fn) => fn(chunk, rowIdx)));
  }
}
