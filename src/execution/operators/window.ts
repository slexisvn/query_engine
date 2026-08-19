import { DataChunk } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';
import type { DataType, ColumnValue } from '../../storage/data-type.js';
import type { BoundExpr, BoundWindowNode, BoundLiteralNode } from '../../binder/expression-binder.js';
import { encodeCompositeKey } from '../composite-key.js';
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
          row.push(chunk.columns[c].get(chunk.activeRowIndex ? chunk.activeRowIndex(r) : r));
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

    const getVal = (rowIdx: number, evalFn: CompiledExpr): EvalValue => {
      let offset = 0;
      for (const chunk of chunks) {
        if (rowIdx < offset + chunk.size) {
          return evalFn(chunk, rowIdx - offset);
        }
        offset += chunk.size;
      }
      return null;
    };

    const partitions = this.partitionRows(allRows, partitionBy, chunks);

    if (orderKeys.length > 0) {
      for (const partition of partitions) {
        partition.sort((a, b) => {
          for (const key of orderKeys) {
            const va = getVal(a, key.eval);
            const vb = getVal(b, key.eval);
            const an = va === null || va === undefined;
            const bn = vb === null || vb === undefined;
            if (an && bn) continue;
            if (an) return 1;
            if (bn) return -1;
            const cmp = this.compareValues(va, vb);
            if (cmp !== 0) return key.direction === 'DESC' ? -cmp : cmp;
          }
          return 0;
        });
      }
    }

    const result: EvalValue[] = new Array(allRows.length);
    const name = wExpr.name.toUpperCase();

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
            if (i > 0 && !this.sameOrderKey(partition[i], partition[i - 1], orderKeys, chunks)) {
              rank = i + 1;
            }
            result[partition[i]] = rank;
          }
          break;
        }

        case 'DENSE_RANK': {
          let rank = 1;
          for (let i = 0; i < partition.length; i++) {
            if (i > 0 && !this.sameOrderKey(partition[i], partition[i - 1], orderKeys, chunks)) {
              rank++;
            }
            result[partition[i]] = rank;
          }
          break;
        }

        case 'LAG': {
          const valueEval = wExpr.args.length > 0
            ? this.compileExpression(wExpr.args[0], this.childColumnMapping)
            : null;
          const lagOffset = wExpr.args.length > 1 ? (wExpr.args[1] as BoundLiteralNode).value as number : 1;
          const defaultVal = wExpr.args.length > 2 ? (wExpr.args[2] as BoundLiteralNode).value : null;

          for (let i = 0; i < partition.length; i++) {
            const srcIdx = i - lagOffset;
            if (srcIdx >= 0 && srcIdx < partition.length) {
              result[partition[i]] = valueEval ? getVal(partition[srcIdx], valueEval) : null;
            } else {
              result[partition[i]] = defaultVal;
            }
          }
          break;
        }

        case 'LEAD': {
          const valueEval = wExpr.args.length > 0
            ? this.compileExpression(wExpr.args[0], this.childColumnMapping)
            : null;
          const leadOffset = wExpr.args.length > 1 ? (wExpr.args[1] as BoundLiteralNode).value as number : 1;
          const defaultVal = wExpr.args.length > 2 ? (wExpr.args[2] as BoundLiteralNode).value : null;

          for (let i = 0; i < partition.length; i++) {
            const srcIdx = i + leadOffset;
            if (srcIdx >= 0 && srcIdx < partition.length) {
              result[partition[i]] = valueEval ? getVal(partition[srcIdx], valueEval) : null;
            } else {
              result[partition[i]] = defaultVal;
            }
          }
          break;
        }

        case 'SUM': {
          const valueEval = this.compileExpression(wExpr.args[0], this.childColumnMapping);
          if (orderKeys.length === 0) {
            let total = 0;
            let count = 0;
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null && v !== undefined) { total += typeof v === 'bigint' ? Number(v) : v as number; count++; }
            }
            const sum = count === 0 ? null : total;
            for (let i = 0; i < partition.length; i++) result[partition[i]] = sum;
          } else {
            let total = 0;
            let count = 0;
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null && v !== undefined) { total += typeof v === 'bigint' ? Number(v) : v as number; count++; }
              result[partition[i]] = count === 0 ? null : total;
            }
          }
          break;
        }

        case 'AVG': {
          const valueEval = this.compileExpression(wExpr.args[0], this.childColumnMapping);
          if (orderKeys.length === 0) {
            let total = 0;
            let count = 0;
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null && v !== undefined) { total += typeof v === 'bigint' ? Number(v) : v as number; count++; }
            }
            const avg = count === 0 ? null : total / count;
            for (let i = 0; i < partition.length; i++) result[partition[i]] = avg;
          } else {
            let total = 0;
            let count = 0;
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null && v !== undefined) { total += typeof v === 'bigint' ? Number(v) : v as number; count++; }
              result[partition[i]] = count === 0 ? null : total / count;
            }
          }
          break;
        }

        case 'COUNT': case 'COUNT_STAR': {
          const valueEval = wExpr.args.length > 0
            ? this.compileExpression(wExpr.args[0], this.childColumnMapping)
            : null;
          if (orderKeys.length === 0) {
            let total = 0;
            for (let i = 0; i < partition.length; i++) {
              if (valueEval) {
                const v = getVal(partition[i], valueEval);
                if (v !== null) total++;
              } else {
                total++;
              }
            }
            for (let i = 0; i < partition.length; i++) result[partition[i]] = total;
          } else {
            let count = 0;
            for (let i = 0; i < partition.length; i++) {
              if (valueEval) {
                const v = getVal(partition[i], valueEval);
                if (v !== null) count++;
              } else {
                count++;
              }
              result[partition[i]] = count;
            }
          }
          break;
        }

        case 'MIN': {
          const valueEval = this.compileExpression(wExpr.args[0], this.childColumnMapping);
          if (orderKeys.length === 0) {
            let min: EvalValue = null;
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null && (min === null || (v as number) < (min as number))) min = v;
            }
            for (let i = 0; i < partition.length; i++) result[partition[i]] = min;
          } else {
            let min: EvalValue = null;
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null && (min === null || (v as number) < (min as number))) min = v;
              result[partition[i]] = min;
            }
          }
          break;
        }

        case 'MAX': {
          const valueEval = this.compileExpression(wExpr.args[0], this.childColumnMapping);
          if (orderKeys.length === 0) {
            let max: EvalValue = null;
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null && (max === null || (v as number) > (max as number))) max = v;
            }
            for (let i = 0; i < partition.length; i++) result[partition[i]] = max;
          } else {
            let max: EvalValue = null;
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null && (max === null || (v as number) > (max as number))) max = v;
              result[partition[i]] = max;
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

    const getVal = (rowIdx: number, evalFn: CompiledExpr): EvalValue => {
      let offset = 0;
      for (const chunk of chunks) {
        if (rowIdx < offset + chunk.size) {
          return evalFn(chunk, rowIdx - offset);
        }
        offset += chunk.size;
      }
      return null;
    };

    const groups = new Map<string, number[]>();
    for (let i = 0; i < allRows.length; i++) {
      const key = encodeCompositeKey(partitionEvals.map((e) => getVal(i, e)));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(i);
    }
    return [...groups.values()];
  }

  sameOrderKey(idxA: number, idxB: number, orderKeys: OrderKey[], chunks: DataChunk[]): boolean {
    const getVal = (rowIdx: number, evalFn: CompiledExpr): EvalValue => {
      let offset = 0;
      for (const chunk of chunks) {
        if (rowIdx < offset + chunk.size) {
          return evalFn(chunk, rowIdx - offset);
        }
        offset += chunk.size;
      }
      return null;
    };

    for (const key of orderKeys) {
      const va = getVal(idxA, key.eval);
      const vb = getVal(idxB, key.eval);
      if (this.compareValues(va, vb) !== 0) return false;
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
