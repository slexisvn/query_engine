import { DataChunk } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';
import { JoinType } from '../../planner/logical-plan.js';
import { DataType } from '../../storage/data-type.js';

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
    const buildRows = this._flattenChunks(this.buildChunks);
    const probeRows = this._flattenChunks(this.probeChunks);

    const outputRows = [];
    const adapter = this.conditionEvaluator ? this.createAdapter() : null;

    let b = 0;
    let p = 0;

    while (b < buildRows.length && p < probeRows.length) {
      const bRow = buildRows[b];
      const pRow = probeRows[p];

      const bKey = this._extractKey(bRow.chunk, bRow.idx, this.buildKeyExtractors);
      const pKey = this._extractKey(pRow.chunk, pRow.idx, this.probeKeyExtractors);

      const cmp = this._compareKeys(bKey, pKey);

      if (cmp < 0) {
        if (this.joinType === JoinType.LEFT || this.joinType === JoinType.FULL || this.joinType === JoinType.ANTI) {
          if (this.joinType !== JoinType.ANTI) {
             const row = this._combineRowWithNulls(bRow, true);
             outputRows.push(row);
          }
        }
        b++;
      } else if (cmp > 0) {
        if (this.joinType === JoinType.RIGHT || this.joinType === JoinType.FULL) {
          const row = this._combineRowWithNulls(pRow, false);
          outputRows.push(row);
        }
        p++;
      } else {
        let bEnd = b;
        while (bEnd < buildRows.length && this._compareKeys(bKey, this._extractKey(buildRows[bEnd].chunk, buildRows[bEnd].idx, this.buildKeyExtractors)) === 0) {
          bEnd++;
        }
        let pEnd = p;
        while (pEnd < probeRows.length && this._compareKeys(pKey, this._extractKey(probeRows[pEnd].chunk, probeRows[pEnd].idx, this.probeKeyExtractors)) === 0) {
          pEnd++;
        }

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
      if (this.joinType === JoinType.RIGHT || this.joinType === JoinType.FULL) {
        outputRows.push(this._combineRowWithNulls(probeRows[p], false));
      }
      p++;
    }

    if (outputRows.length === 0) return [];

    return [this._buildOutputChunk(outputRows)];
  }

  _flattenChunks(chunks) {
    const rows = [];
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.size; i++) {
        rows.push({ chunk, idx: chunk.activeRowIndex(i) });
      }
    }
    return rows;
  }

  _extractKey(chunk, idx, extractors) {
    if (extractors.length === 1) return extractors[0](chunk, idx);
    return extractors.map(fn => fn(chunk, idx));
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
    const colCount = this.buildColCount + this.probeColCount;
    const columns = [];

        let dtSource = null;
    if (this.buildChunks.length > 0) dtSource = this.buildChunks[0].columns;
    else if (this.probeChunks.length > 0) dtSource = this.probeChunks[0].columns;

    for (let c = 0; c < colCount; c++) {
      let dt = DataType.VARCHAR;
      if (c < this.buildColCount && this.buildChunks.length > 0) dt = this.buildChunks[0].columns[c].dataType;
      else if (c >= this.buildColCount && this.probeChunks.length > 0) dt = this.probeChunks[0].columns[c - this.buildColCount].dataType;
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
