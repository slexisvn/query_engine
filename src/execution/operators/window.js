import { DataChunk } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';

export class WindowOperator {
  constructor(windowExprs, childSchema, childColumnMapping, compileExpressionFn) {
    this.windowExprs = windowExprs;
    this.childSchema = childSchema;
    this.childColumnMapping = childColumnMapping;
    this.compileExpression = compileExpressionFn;
  }

  async execute(chunks) {
    const allRows = [];
    for (const chunk of chunks) {
      for (let r = 0; r < chunk.size; r++) {
        const row = [];
        for (let c = 0; c < chunk.columns.length; c++) {
          row.push(chunk.columns[c].get(chunk.activeRowIndex ? chunk.activeRowIndex(r) : r));
        }
        allRows.push(row);
      }
    }

    if (allRows.length === 0) return [];

    const windowResults = [];
    for (const wExpr of this.windowExprs) {
      windowResults.push(this.computeWindow(wExpr, allRows, chunks));
    }

    const colCount = this.childSchema.length + this.windowExprs.length;
    const resultCol = [];
    for (let c = 0; c < this.childSchema.length; c++) {
      const col = new Column(this.childSchema[c].dataType, allRows.length);
      for (let r = 0; r < allRows.length; r++) {
        col.set(r, allRows[r][c]);
      }
      col.length = allRows.length;
      resultCol.push(col);
    }

    for (let w = 0; w < windowResults.length; w++) {
      const dt = this.windowExprs[w].resultType || 'INT64';
      const col = new Column(dt === 'INT64' ? 'FLOAT64' : dt, allRows.length);
      for (let r = 0; r < allRows.length; r++) {
        col.set(r, windowResults[w][r]);
      }
      col.length = allRows.length;
      resultCol.push(col);
    }

    return [new DataChunk(resultCol, allRows.length)];
  }

  computeWindow(wExpr, allRows, chunks) {
    const partitionBy = wExpr.partitionBy.map(e => this.compileExpression(e, this.childColumnMapping));
    const orderKeys = wExpr.orderBy.map(ok => ({
      eval: this.compileExpression(ok.expr, this.childColumnMapping),
      direction: ok.direction || 'ASC',
    }));

    const tempChunk = chunks.length > 0 ? chunks[0] : null;
    const getVal = (rowIdx, evalFn) => {
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
            const cmp = this.compareValues(va, vb);
            if (cmp !== 0) return key.direction === 'DESC' ? -cmp : cmp;
          }
          return 0;
        });
      }
    }

    const result = new Array(allRows.length);
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
          const lagOffset = wExpr.args.length > 1 ? wExpr.args[1].value : 1;
          const defaultVal = wExpr.args.length > 2 ? wExpr.args[2].value : null;

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
          const leadOffset = wExpr.args.length > 1 ? wExpr.args[1].value : 1;
          const defaultVal = wExpr.args.length > 2 ? wExpr.args[2].value : null;

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
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null) total += typeof v === 'bigint' ? Number(v) : v;
            }
            for (let i = 0; i < partition.length; i++) result[partition[i]] = total;
          } else {
            let sum = 0;
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null) sum += typeof v === 'bigint' ? Number(v) : v;
              result[partition[i]] = sum;
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
            let min = null;
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null && (min === null || v < min)) min = v;
            }
            for (let i = 0; i < partition.length; i++) result[partition[i]] = min;
          } else {
            let min = null;
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null && (min === null || v < min)) min = v;
              result[partition[i]] = min;
            }
          }
          break;
        }

        case 'MAX': {
          const valueEval = this.compileExpression(wExpr.args[0], this.childColumnMapping);
          if (orderKeys.length === 0) {
            let max = null;
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null && (max === null || v > max)) max = v;
            }
            for (let i = 0; i < partition.length; i++) result[partition[i]] = max;
          } else {
            let max = null;
            for (let i = 0; i < partition.length; i++) {
              const v = getVal(partition[i], valueEval);
              if (v !== null && (max === null || v > max)) max = v;
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

  partitionRows(allRows, partitionEvals, chunks) {
    if (partitionEvals.length === 0) {
      return [allRows.map((_, i) => i)];
    }

    const getVal = (rowIdx, evalFn) => {
      let offset = 0;
      for (const chunk of chunks) {
        if (rowIdx < offset + chunk.size) {
          return evalFn(chunk, rowIdx - offset);
        }
        offset += chunk.size;
      }
      return null;
    };

    const groups = new Map();
    for (let i = 0; i < allRows.length; i++) {
      const key = partitionEvals.map(e => {
        const v = getVal(i, e);
        return typeof v === 'bigint' ? Number(v) : v;
      }).join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
    return [...groups.values()];
  }

  sameOrderKey(idxA, idxB, orderKeys, chunks) {
    const getVal = (rowIdx, evalFn) => {
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

  compareValues(a, b) {
    const na = typeof a === 'bigint' ? Number(a) : a;
    const nb = typeof b === 'bigint' ? Number(b) : b;
    if (na === null && nb === null) return 0;
    if (na === null) return 1;
    if (nb === null) return -1;
    if (na < nb) return -1;
    if (na > nb) return 1;
    return 0;
  }
}
