import { DataChunk } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';
import type { DataType, ColumnValue } from '../../storage/data-type.js';
import type { BoundExpr, BoundWindowNode } from '../../binder/expression-binder.js';
import { encodeCompositeKey } from '../composite-key.js';
import { DEFAULT_FRAME, FRAME_AGGREGATORS, frameRangesOf, peerGroupsOf } from './window-frame.js';
import type { CompiledExpr, ColumnMapping, ExecSchema, ExecColumn, EvalValue } from '../execution-types.js';

type CompileExpressionFn = (expr: BoundExpr, mapping: ColumnMapping) => CompiledExpr;

interface OrderKey {
  eval: CompiledExpr;
  direction: string;
}

export class WindowOperator {
  windowExprs: BoundWindowNode[];
  childSchema: ExecSchema;
  childColumnMapping: ColumnMapping;
  compileExpression: CompileExpressionFn;

  constructor(windowExprs: BoundWindowNode[], childSchema: ExecSchema, childColumnMapping: ColumnMapping, compileExpressionFn: CompileExpressionFn) {
    this.windowExprs = windowExprs;
    this.childSchema = childSchema;
    this.childColumnMapping = childColumnMapping;
    this.compileExpression = compileExpressionFn;
  }

  async execute(chunks: DataChunk[]): Promise<DataChunk[]> {
    const allRows: ColumnValue[][] = [];
    for (const chunk of chunks) {
      for (let r = 0; r < chunk.size; r++) {
        const row: ColumnValue[] = [];
        for (let c = 0; c < chunk.columns.length; c++) {
          row.push(chunk.columns[c].get(chunk.activeRowIndex(r)));
        }
        allRows.push(row);
      }
    }

    if (allRows.length === 0) return [];

    const windowResults: EvalValue[][] = [];
    for (const wExpr of this.windowExprs) {
      windowResults.push(this.computeWindow(wExpr, allRows, chunks));
    }

    const resultCol: Column[] = [];
    for (let c = 0; c < this.childSchema.length; c++) {
      const col = new Column((this.childSchema[c] as ExecColumn).dataType, allRows.length);
      for (let r = 0; r < allRows.length; r++) {
        col.set(r, allRows[r][c]);
      }
      col.length = allRows.length;
      resultCol.push(col);
    }

    for (let w = 0; w < windowResults.length; w++) {
      const dt = this.windowExprs[w].resultType || 'INT64';
      const col = new Column((dt === 'INT64' ? 'FLOAT64' : dt) as DataType, allRows.length);
      for (let r = 0; r < allRows.length; r++) {
        col.set(r, windowResults[w][r] as ColumnValue);
      }
      col.length = allRows.length;
      resultCol.push(col);
    }

    return [new DataChunk(resultCol, allRows.length)];
  }

  computeWindow(wExpr: BoundWindowNode, allRows: ColumnValue[][], chunks: DataChunk[]): EvalValue[] {
    const partitionBy = wExpr.partitionBy.map((e) => this.compileExpression(e, this.childColumnMapping));
    const orderKeys: OrderKey[] = wExpr.orderBy.map((ok) => ({
      eval: this.compileExpression(ok.expr, this.childColumnMapping),
      direction: ok.direction || 'ASC',
    }));

    const rowCount = allRows.length;
    const orderValues = orderKeys.map((key) => materializeColumn(chunks, key.eval, rowCount));
    const valueEvalColumn = new Map<CompiledExpr, EvalValue[]>();
    const getVal = (rowIdx: number, evalFn: CompiledExpr): EvalValue => {
      let column = valueEvalColumn.get(evalFn);
      if (!column) {
        column = materializeColumn(chunks, evalFn, rowCount);
        valueEvalColumn.set(evalFn, column);
      }
      return column[rowIdx];
    };

    const partitions = this.partitionRows(allRows, partitionBy, chunks);

    if (orderKeys.length > 0) {
      for (const partition of partitions) {
        partition.sort((a, b) => {
          for (let k = 0; k < orderKeys.length; k++) {
            const va = orderValues[k][a];
            const vb = orderValues[k][b];
            const an = va === null || va === undefined;
            const bn = vb === null || vb === undefined;
            if (an && bn) continue;
            if (an) return 1;
            if (bn) return -1;
            const cmp = this.compareValues(va, vb);
            if (cmp !== 0) return orderKeys[k].direction === 'DESC' ? -cmp : cmp;
          }
          return 0;
        });
      }
    }

    const result: EvalValue[] = new Array(allRows.length);
    const name = wExpr.name.toUpperCase();

    const aggregator = FRAME_AGGREGATORS.get(name === 'COUNT' && wExpr.args.length === 0 ? 'COUNT_STAR' : name);
    if (aggregator) {
      const valueEval = wExpr.args.length > 0
        ? this.compileExpression(wExpr.args[0], this.childColumnMapping)
        : null;
      const frame = wExpr.frame ?? DEFAULT_FRAME;
      for (const partition of partitions) {
        const values = partition.map((rowIdx) => (valueEval ? getVal(rowIdx, valueEval) : null));
        const peers = peerGroupsOf(partition.length, (a, b) => this.sameOrderKey(partition[a], partition[b], orderValues));
        const computed = aggregator(values, frameRangesOf(frame, partition.length, peers));
        for (let i = 0; i < partition.length; i++) result[partition[i]] = computed[i];
      }
      return result;
    }

    for (const partition of partitions) {
      switch (name) {
        case 'ROW_NUMBER':
          for (let i = 0; i < partition.length; i++) {
            result[partition[i]] = i + 1;
          }
          break;

        case 'RANK': {
          let rank = 1;
          for (let i = 0; i < partition.length; i++) {
            if (i > 0 && !this.sameOrderKey(partition[i], partition[i - 1], orderValues)) {
              rank = i + 1;
            }
            result[partition[i]] = rank;
          }
          break;
        }

        case 'DENSE_RANK': {
          let rank = 1;
          for (let i = 0; i < partition.length; i++) {
            if (i > 0 && !this.sameOrderKey(partition[i], partition[i - 1], orderValues)) {
              rank++;
            }
            result[partition[i]] = rank;
          }
          break;
        }

        case 'LAG':
        case 'LEAD': {
          const valueEval = wExpr.args.length > 0
            ? this.compileExpression(wExpr.args[0], this.childColumnMapping)
            : null;
          const step = name === 'LAG' ? -1 : 1;
          const offset = step * (wExpr.args.length > 1
            ? Number(getVal(partition[0], this.compileExpression(wExpr.args[1], this.childColumnMapping)))
            : 1);
          const defaultEval = wExpr.args.length > 2
            ? this.compileExpression(wExpr.args[2], this.childColumnMapping)
            : null;

          for (let i = 0; i < partition.length; i++) {
            const srcIdx = i + offset;
            if (srcIdx >= 0 && srcIdx < partition.length) {
              result[partition[i]] = valueEval ? getVal(partition[srcIdx], valueEval) : null;
            } else {
              result[partition[i]] = defaultEval ? getVal(partition[i], defaultEval) : null;
            }
          }
          break;
        }

        default:
          for (let i = 0; i < partition.length; i++) {
            result[partition[i]] = null;
          }
      }
    }

    return result;
  }

  partitionRows(allRows: ColumnValue[][], partitionEvals: CompiledExpr[], chunks: DataChunk[]): number[][] {
    if (partitionEvals.length === 0) {
      return [allRows.map((_, i) => i)];
    }

    const columns = partitionEvals.map((evalFn) => materializeColumn(chunks, evalFn, allRows.length));
    const groups = new Map<string, number[]>();

    for (let i = 0; i < allRows.length; i++) {
      const key = encodeCompositeKey(columns.map((column) => column[i]));
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(i);
    }

    return [...groups.values()];
  }

  sameOrderKey(idxA: number, idxB: number, orderValues: EvalValue[][]): boolean {
    for (const column of orderValues) {
      if (this.compareValues(column[idxA], column[idxB]) !== 0) return false;
    }
    return true;
  }

  compareValues(a: EvalValue, b: EvalValue): number {
    const na = typeof a === 'bigint' ? Number(a) : a;
    const nb = typeof b === 'bigint' ? Number(b) : b;
    if (na === null && nb === null) return 0;
    if (na === null) return 1;
    if (nb === null) return -1;
    if ((na as number) < (nb as number)) return -1;
    if ((na as number) > (nb as number)) return 1;
    return 0;
  }
}

function materializeColumn(chunks: DataChunk[], evalFn: CompiledExpr, rowCount: number): EvalValue[] {
  const values: EvalValue[] = new Array(rowCount);
  let offset = 0;
  for (const chunk of chunks) {
    for (let r = 0; r < chunk.size; r++) values[offset + r] = evalFn(chunk, chunk.activeRowIndex(r));
    offset += chunk.size;
  }
  return values;
}
