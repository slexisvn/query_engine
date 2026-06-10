import { DataChunk } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';
import { JoinType } from '../../planner/logical-plan.js';
import { DataType } from '../../storage/data-type.js';

function isNullKey(key) {
  if (key === null || key === undefined) return true;
  return Array.isArray(key) && key.some(k => k === null || k === undefined);
}

export class MergeJoinOperator {
  constructor(buildChunks, probeChunks, buildKeyExtractors, probeKeyExtractors, buildColCount, probeColCount, joinType = JoinType.INNER, conditionEvaluator = null) {
    this.buildChunks = buildChunks;
    this.probeChunks = probeChunks;
    this.buildKeyExtractors = buildKeyExtractors;
    this.probeKeyExtractors = probeKeyExtractors;
    this.buildColCount = buildColCount;
    this.probeColCount = probeColCount;
    this.joinType = joinType;
    this.conditionEvaluator = conditionEvaluator;
  }

  async execute() {
    const isSemiAnti = this.joinType === JoinType.SEMI || this.joinType === JoinType.ANTI;
    const isMark = this.joinType === JoinType.MARK;

    const buildAll = this._flattenAndExtractKeys(this.buildChunks, this.buildKeyExtractors);
    const probeAll = this._flattenAndExtractKeys(this.probeChunks, this.probeKeyExtractors);

    const buildRows = buildAll.filter(r => !isNullKey(r.key));
    const probeRows = probeAll.filter(r => !isNullKey(r.key));
    const buildNull = buildAll.filter(r => isNullKey(r.key));
    const probeNull = probeAll.filter(r => isNullKey(r.key));
    const markUnmatched = buildNull.length > 0 ? null : false;

    buildRows.sort((a, b) => this._compareKeys(a.key, b.key));
    probeRows.sort((a, b) => this._compareKeys(a.key, b.key));

    const outputRows = [];
    const adapter = this.conditionEvaluator ? this.createAdapter() : null;

    let b = 0;
    let p = 0;

    while (b < buildRows.length && p < probeRows.length) {
      const bRow = buildRows[b];
      const pRow = probeRows[p];

      const cmp = this._compareKeys(bRow.key, pRow.key);

      if (cmp < 0) {
        if (this.joinType === JoinType.LEFT || this.joinType === JoinType.FULL) {
          outputRows.push(this._combineRowWithNulls(bRow, true));
        }
        b++;
      } else if (cmp > 0) {
        if (isSemiAnti && this.joinType === JoinType.ANTI) {
          outputRows.push(this._extractProbeRow(pRow));
        } else if (isMark) {
          outputRows.push(this._extractProbeRow(pRow).concat([markUnmatched]));
        } else if (this.joinType === JoinType.RIGHT || this.joinType === JoinType.FULL) {
          outputRows.push(this._combineRowWithNulls(pRow, false));
        }
        p++;
      } else {
        let bEnd = b;
        while (bEnd < buildRows.length && this._compareKeys(bRow.key, buildRows[bEnd].key) === 0) {
          bEnd++;
        }
        let pEnd = p;
        while (pEnd < probeRows.length && this._compareKeys(pRow.key, probeRows[pEnd].key) === 0) {
          pEnd++;
        }

        if (isSemiAnti || isMark) {
          for (let j = p; j < pEnd; j++) {
            let matched = false;
            for (let i = b; i < bEnd; i++) {
              if (adapter) {
                const row = this._combineRow(buildRows[i], probeRows[j]);
                adapter.setRow(row);
                if (!this.conditionEvaluator(adapter, 0)) continue;
              }
              matched = true;
              break;
            }
            if (this.joinType === JoinType.SEMI && matched) {
              outputRows.push(this._extractProbeRow(probeRows[j]));
            } else if (this.joinType === JoinType.ANTI && !matched) {
              outputRows.push(this._extractProbeRow(probeRows[j]));
            } else if (isMark) {
              outputRows.push(this._extractProbeRow(probeRows[j]).concat([matched ? true : markUnmatched]));
            }
          }
        } else {
          for (let i = b; i < bEnd; i++) {
            let matchedAny = false;
            for (let j = p; j < pEnd; j++) {
              const row = this._combineRow(buildRows[i], probeRows[j]);
              if (adapter) {
                adapter.setRow(row);
                if (!this.conditionEvaluator(adapter, 0)) continue;
              }
              outputRows.push(row);
              matchedAny = true;
            }
            if (!matchedAny && (this.joinType === JoinType.LEFT || this.joinType === JoinType.FULL)) {
              outputRows.push(this._combineRowWithNulls(buildRows[i], true));
            }
          }
        }

        b = bEnd;
        p = pEnd;
      }
    }

    while (b < buildRows.length) {
      if (this.joinType === JoinType.LEFT || this.joinType === JoinType.FULL) {
        outputRows.push(this._combineRowWithNulls(buildRows[b], true));
      }
      b++;
    }

    while (p < probeRows.length) {
      if (isSemiAnti && this.joinType === JoinType.ANTI) {
        outputRows.push(this._extractProbeRow(probeRows[p]));
      } else if (isMark) {
        outputRows.push(this._extractProbeRow(probeRows[p]).concat([markUnmatched]));
      } else if (this.joinType === JoinType.RIGHT || this.joinType === JoinType.FULL) {
        outputRows.push(this._combineRowWithNulls(probeRows[p], false));
      }
      p++;
    }

    for (const bRow of buildNull) {
      if (this.joinType === JoinType.LEFT || this.joinType === JoinType.FULL) {
        outputRows.push(this._combineRowWithNulls(bRow, true));
      }
    }
    for (const pRow of probeNull) {
      if (isSemiAnti && this.joinType === JoinType.ANTI) {
        outputRows.push(this._extractProbeRow(pRow));
      } else if (isMark) {
        outputRows.push(this._extractProbeRow(pRow).concat([null]));
      } else if (this.joinType === JoinType.RIGHT || this.joinType === JoinType.FULL) {
        outputRows.push(this._combineRowWithNulls(pRow, false));
      }
    }

    if (outputRows.length === 0) return [];

    return [this._buildOutputChunk(outputRows)];
  }

  _flattenAndExtractKeys(chunks, extractors) {
    const rows = [];
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.size; i++) {
        const idx = chunk.activeRowIndex(i);
        const key = extractors.length === 1
          ? extractors[0](chunk, idx)
          : extractors.map(fn => fn(chunk, idx));
        rows.push({ chunk, idx, key });
      }
    }
    return rows;
  }

  _compareKeys(k1, k2) {
    if (Array.isArray(k1)) {
      for (let i = 0; i < k1.length; i++) {
        const c1 = typeof k1[i] === 'bigint' ? Number(k1[i]) : k1[i];
        const c2 = typeof k2[i] === 'bigint' ? Number(k2[i]) : k2[i];
        if (c1 < c2) return -1;
        if (c1 > c2) return 1;
      }
      return 0;
    }
    const c1 = typeof k1 === 'bigint' ? Number(k1) : k1;
    const c2 = typeof k2 === 'bigint' ? Number(k2) : k2;
    if (c1 < c2) return -1;
    if (c1 > c2) return 1;
    return 0;
  }

  _combineRow(bRow, pRow) {
    const row = [];
    for (let c = 0; c < bRow.chunk.columns.length; c++) {
      row.push(bRow.chunk.columns[c].get(bRow.idx));
    }
    for (let c = 0; c < pRow.chunk.columns.length; c++) {
      row.push(pRow.chunk.columns[c].get(pRow.idx));
    }
    return row;
  }

  _extractProbeRow(rowObj) {
    const row = [];
    for (let c = 0; c < rowObj.chunk.columns.length; c++) {
      row.push(rowObj.chunk.columns[c].get(rowObj.idx));
    }
    return row;
  }

  _combineRowWithNulls(rowObj, isBuild) {
    const row = [];
    if (isBuild) {
      for (let c = 0; c < rowObj.chunk.columns.length; c++) {
        row.push(rowObj.chunk.columns[c].get(rowObj.idx));
      }
      for (let c = 0; c < this.probeColCount; c++) row.push(null);
    } else {
      for (let c = 0; c < this.buildColCount; c++) row.push(null);
      for (let c = 0; c < rowObj.chunk.columns.length; c++) {
        row.push(rowObj.chunk.columns[c].get(rowObj.idx));
      }
    }
    return row;
  }

  _buildOutputChunk(outputRows) {
    if (outputRows.length === 0) return null;
    const isSemiAnti = this.joinType === JoinType.SEMI || this.joinType === JoinType.ANTI;
    const isMark = this.joinType === JoinType.MARK;
    const colCount = isSemiAnti ? this.probeColCount
      : isMark ? this.probeColCount + 1
      : this.buildColCount + this.probeColCount;
    const columns = [];

    for (let c = 0; c < colCount; c++) {
      let dt = DataType.VARCHAR;
      if (isSemiAnti) {
        if (this.probeChunks.length > 0 && c < this.probeChunks[0].columns.length) dt = this.probeChunks[0].columns[c].dataType;
      } else if (isMark) {
        if (c < this.probeColCount && this.probeChunks.length > 0 && c < this.probeChunks[0].columns.length) dt = this.probeChunks[0].columns[c].dataType;
        else if (c === this.probeColCount) dt = DataType.BOOLEAN;
      } else {
        if (c < this.buildColCount && this.buildChunks.length > 0) dt = this.buildChunks[0].columns[c].dataType;
        else if (c >= this.buildColCount && this.probeChunks.length > 0) dt = this.probeChunks[0].columns[c - this.buildColCount].dataType;
      }
      columns.push(new Column(dt, outputRows.length));
    }

    for (let r = 0; r < outputRows.length; r++) {
      const row = outputRows[r];
      for (let c = 0; c < colCount; c++) {
        columns[c].set(r, row[c]);
      }
    }

    for (const col of columns) col.length = outputRows.length;
    return new DataChunk(columns, outputRows.length);
  }

  createAdapter() {
    const totalCols = this.buildColCount + this.probeColCount;
    const columns = new Array(totalCols);
    const adapter = {
      row: null,
      columns,
      setRow(r) { this.row = r; }
    };
    for (let c = 0; c < totalCols; c++) {
      columns[c] = { get: () => adapter.row[c] };
    }
    return adapter;
  }
}
