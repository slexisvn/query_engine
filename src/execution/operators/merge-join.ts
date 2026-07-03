import { DataChunk } from '../../storage/chunk.js';
import { Column } from '../../storage/column.js';
import { JoinType } from '../../planner/logical-plan.js';
import { DataType, type ColumnValue } from '../../storage/data-type.js';
import type { CompiledExpr, EvalValue } from '../execution-types.js';
import { materializeRow } from './join-core.js';

type JoinKey = EvalValue | EvalValue[];

interface JoinRow {
  chunk: DataChunk;
  idx: number;
  key: JoinKey;
}

interface RowAdapterColumn {
  get(): ColumnValue;
}

interface RowAdapter {
  row: ColumnValue[] | null;
  columns: RowAdapterColumn[];
  setRow(r: ColumnValue[]): void;
}

type RowEvaluator = (adapter: RowAdapter, rowIdx: number) => EvalValue;

function isNullKey(key: JoinKey): boolean {
  if (key === null || key === undefined) return true;
  return Array.isArray(key) && key.some((k) => k === null || k === undefined);
}

export class MergeJoinOperator {
  buildChunks: DataChunk[];
  probeChunks: DataChunk[];
  buildKeyExtractors: CompiledExpr[];
  probeKeyExtractors: CompiledExpr[];
  buildColCount: number;
  probeColCount: number;
  joinType: JoinType;
  conditionEvaluator: CompiledExpr | null;

  constructor(buildChunks: DataChunk[], probeChunks: DataChunk[], buildKeyExtractors: CompiledExpr[], probeKeyExtractors: CompiledExpr[], buildColCount: number, probeColCount: number, joinType: JoinType = JoinType.INNER, conditionEvaluator: CompiledExpr | null = null) {
    this.buildChunks = buildChunks;
    this.probeChunks = probeChunks;
    this.buildKeyExtractors = buildKeyExtractors;
    this.probeKeyExtractors = probeKeyExtractors;
    this.buildColCount = buildColCount;
    this.probeColCount = probeColCount;
    this.joinType = joinType;
    this.conditionEvaluator = conditionEvaluator;
  }

  async execute(): Promise<DataChunk[]> {
    const isSemiAnti = this.joinType === JoinType.SEMI || this.joinType === JoinType.ANTI;
    const isMark = this.joinType === JoinType.MARK;

    const buildAll = this._flattenAndExtractKeys(this.buildChunks, this.buildKeyExtractors);
    const probeAll = this._flattenAndExtractKeys(this.probeChunks, this.probeKeyExtractors);

    const buildRows = buildAll.filter((r) => !isNullKey(r.key));
    const probeRows = probeAll.filter((r) => !isNullKey(r.key));
    const buildNull = buildAll.filter((r) => isNullKey(r.key));
    const probeNull = probeAll.filter((r) => isNullKey(r.key));
    const markUnmatched = buildNull.length > 0 ? null : false;

    buildRows.sort((a, b) => this._compareKeys(a.key, b.key));
    probeRows.sort((a, b) => this._compareKeys(a.key, b.key));

    const outputRows: ColumnValue[][] = [];
    const adapter = this.conditionEvaluator ? this.createAdapter() : null;
    const evalCondition = this.conditionEvaluator as RowEvaluator | null;

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
                if (!evalCondition!(adapter, 0)) continue;
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
                if (!evalCondition!(adapter, 0)) continue;
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

    const chunk = this._buildOutputChunk(outputRows);
    return chunk ? [chunk] : [];
  }

  _flattenAndExtractKeys(chunks: DataChunk[], extractors: CompiledExpr[]): JoinRow[] {
    const rows: JoinRow[] = [];
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.size; i++) {
        const idx = chunk.activeRowIndex(i);
        const key: JoinKey = extractors.length === 1
          ? extractors[0](chunk, idx)
          : extractors.map((fn) => fn(chunk, idx));
        rows.push({ chunk, idx, key });
      }
    }
    return rows;
  }

  _compareKeys(k1: JoinKey, k2: JoinKey): number {
    if (Array.isArray(k1)) {
      const a1 = k1;
      const a2 = k2 as EvalValue[];
      for (let i = 0; i < a1.length; i++) {
        const c1 = typeof a1[i] === 'bigint' ? Number(a1[i]) : a1[i];
        const c2 = typeof a2[i] === 'bigint' ? Number(a2[i]) : a2[i];
        if ((c1 as number) < (c2 as number)) return -1;
        if ((c1 as number) > (c2 as number)) return 1;
      }
      return 0;
    }
    const c1 = typeof k1 === 'bigint' ? Number(k1) : k1;
    const c2 = typeof k2 === 'bigint' ? Number(k2) : k2;
    if ((c1 as number) < (c2 as number)) return -1;
    if ((c1 as number) > (c2 as number)) return 1;
    return 0;
  }

  _combineRow(bRow: JoinRow, pRow: JoinRow): ColumnValue[] {
    return materializeRow(bRow.chunk, bRow.idx).concat(materializeRow(pRow.chunk, pRow.idx));
  }

  _extractProbeRow(rowObj: JoinRow): ColumnValue[] {
    return materializeRow(rowObj.chunk, rowObj.idx);
  }

  _combineRowWithNulls(rowObj: JoinRow, isBuild: boolean): ColumnValue[] {
    if (isBuild) {
      const row = materializeRow(rowObj.chunk, rowObj.idx);
      for (let c = 0; c < this.probeColCount; c++) row.push(null);
      return row;
    }
    const row: ColumnValue[] = [];
    for (let c = 0; c < this.buildColCount; c++) row.push(null);
    return row.concat(materializeRow(rowObj.chunk, rowObj.idx));
  }

  _buildOutputChunk(outputRows: ColumnValue[][]): DataChunk | null {
    if (outputRows.length === 0) return null;
    const isSemiAnti = this.joinType === JoinType.SEMI || this.joinType === JoinType.ANTI;
    const isMark = this.joinType === JoinType.MARK;
    const colCount = isSemiAnti ? this.probeColCount
      : isMark ? this.probeColCount + 1
      : this.buildColCount + this.probeColCount;
    const columns: Column[] = [];

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

  createAdapter(): RowAdapter {
    const totalCols = this.buildColCount + this.probeColCount;
    const columns: RowAdapterColumn[] = new Array(totalCols);
    const adapter: RowAdapter = {
      row: null,
      columns,
      setRow(r: ColumnValue[]) { this.row = r; }
    };
    for (let c = 0; c < totalCols; c++) {
      columns[c] = { get: () => adapter.row![c] };
    }
    return adapter;
  }
}
