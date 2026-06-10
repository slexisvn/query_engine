import { Worker } from 'worker_threads';
import { DataType } from '../storage/data-type.js';

const I32_TYPES = new Set([DataType.INT32, DataType.DATE]);

function colKind(dt) {
  if (I32_TYPES.has(dt)) return 'i32';
  if (dt === DataType.FLOAT64) return 'f64';
  return null;
}

function finalize(fn, st) {
  if (fn === 'count' || fn === 'countStar') return st.c;
  if (fn === 'sum') return st.n === 0 ? null : st.s;
  if (fn === 'avg') return st.n === 0 ? null : st.s / st.n;
  return st.m;
}

function emptyAggRow(spec) {
  const o = {};
  for (const a of spec.aggs) o[a.out] = (a.fn === 'count' || a.fn === 'countStar') ? 0 : null;
  return o;
}

function mergeState(fn, a, b) {
  if (fn === 'count' || fn === 'countStar') a.c += b.c;
  else if (fn === 'sum' || fn === 'avg') { a.s += b.s; a.n += b.n; }
  else if (fn === 'min') { if (b.m !== null && (a.m === null || b.m < a.m)) a.m = b.m; }
  else if (fn === 'max') { if (b.m !== null && (a.m === null || b.m > a.m)) a.m = b.m; }
}

export class MorselAggregate {
  constructor(workerCount, morselRows = 64 * 1024) {
    this.workerCount = Math.max(1, workerCount);
    this.morselRows = morselRows;
    this.workers = null;
    this.pending = new Map();
    this.nextReqId = 1;
  }

  _ensure() {
    if (this.workers) return;
    this.workers = [];
    for (let w = 0; w < this.workerCount; w++) {
      const wk = new Worker(new URL('./morsel-agg-worker.js', import.meta.url));
      wk.on('message', (m) => {
        const entry = this.pending.get(m.reqId);
        if (!entry) return;
        entry.parts.push(m);
        if (entry.parts.length === this.workerCount) {
          this.pending.delete(m.reqId);
          entry.resolve(entry.parts);
        }
      });
      wk.on('error', (e) => {
        for (const [id, entry] of this.pending) {
          this.pending.delete(id);
          entry.reject(e);
        }
      });
      this.workers.push(wk);
    }
  }

  async close() {
    if (this.workers) {
      const ws = this.workers;
      this.workers = null;
      await Promise.all(ws.map(w => w.terminate()));
    }
  }

  async run(rawChunks, schema, spec) {
    const chunks = rawChunks.map(c => c.selectionVector ? c.flatten() : c);
    const nRows = chunks.reduce((s, c) => s + c.size, 0);
    if (nRows === 0) return spec.groupCols.length === 0 ? [emptyAggRow(spec)] : [];

    const resolve = (name) => {
      const up = name.toUpperCase();
      const idx = schema.findIndex(s => s.name.toUpperCase() === up);
      return idx < 0 ? null : { idx, dt: schema[idx].dataType };
    };

    const needed = new Map();
    const colIdx = {};
    const groupVarchar = {};
    const addCol = (name, allowVarchar) => {
      const c = resolve(name);
      if (!c) return false;
      let kind = colKind(c.dt);
      if (!kind) {
        if (allowVarchar && c.dt === DataType.VARCHAR) { kind = 'i32'; groupVarchar[name] = true; }
        else return false;
      }
      needed.set(name, kind);
      colIdx[name] = c.idx;
      return true;
    };

    for (const f of spec.filter) if (!addCol(f.col, false)) return null;
    for (const g of spec.groupCols) if (!addCol(g.col, true)) return null;
    for (const a of spec.aggs) if (a.col != null && !addCol(a.col, false)) return null;

    const hasNulls = {};
    for (const [name] of needed) hasNulls[name] = false;
    for (const chunk of chunks) for (const [name] of needed) if (chunk.columns[colIdx[name]].hasNulls) hasNulls[name] = true;

    const cols = {};
    let off = 0;
    for (const [name, kind] of needed) {
      cols[name] = { kind, dataByteOffset: off, nullByteOffset: -1 };
      off += (kind === 'i32' ? 4 : 8) * nRows;
      off = (off + 7) & ~7;
    }
    for (const [name] of needed) if (hasNulls[name]) { cols[name].nullByteOffset = off; off += nRows; off = (off + 7) & ~7; }

    const dataSab = new SharedArrayBuffer(off);
    const views = {}, nullViews = {}, dicts = {};
    for (const [name, kind] of needed) {
      views[name] = kind === 'i32' ? new Int32Array(dataSab, cols[name].dataByteOffset, nRows) : new Float64Array(dataSab, cols[name].dataByteOffset, nRows);
      if (cols[name].nullByteOffset >= 0) nullViews[name] = new Uint8Array(dataSab, cols[name].nullByteOffset, nRows);
      if (groupVarchar[name]) dicts[name] = { map: new Map(), rev: [] };
    }

    for (const [name] of needed) {
      const view = views[name];
      const nv = nullViews[name];
      const isVarchar = !!groupVarchar[name];
      let base = 0;
      for (const chunk of chunks) {
        const size = chunk.size;
        const col = chunk.columns[colIdx[name]];
        if (isVarchar) {
          const d = dicts[name];
          for (let i = 0; i < size; i++) {
            const v = col.get(i);
            if (v === null || v === undefined) { if (nv) nv[base + i] = 1; continue; }
            let id = d.map.get(v);
            if (id === undefined) { id = d.rev.length; d.map.set(v, id); d.rev.push(v); }
            view[base + i] = id;
          }
        } else {
          view.set(col.data.subarray(0, size), base);
          if (nv && col.hasNulls) {
            for (let i = 0; i < size; i++) if (col.isNull(i)) nv[base + i] = 1;
          }
        }
        base += size;
      }
    }

    this._ensure();
    const counterSab = new SharedArrayBuffer(4);
    Atomics.store(new Int32Array(counterSab, 0, 1), 0, 0);
    const reqId = this.nextReqId++;
    const msg = {
      reqId, dataSab, counterSab, nRows, layout: { cols },
      filter: spec.filter.map(f => ({ col: f.col, op: f.op, value: f.value })),
      groupCols: spec.groupCols.map(g => g.col),
      aggs: spec.aggs.map(a => ({ fn: a.fn, col: a.col })),
      morselRows: this.morselRows,
    };
    const partials = await new Promise((resolve, reject) => {
      this.pending.set(reqId, { parts: [], resolve, reject });
      for (const wk of this.workers) wk.postMessage(msg);
    });

    const merged = new Map();
    for (const p of partials) for (const part of p.partials) {
      let g = merged.get(part.k);
      if (!g) merged.set(part.k, { gv: part.gv, st: part.st });
      else for (let ai = 0; ai < g.st.length; ai++) mergeState(spec.aggs[ai].fn, g.st[ai], part.st[ai]);
    }

    const out = [];
    for (const g of merged.values()) {
      const o = {};
      for (let gi = 0; gi < spec.groupCols.length; gi++) {
        const gc = spec.groupCols[gi];
        let val = g.gv[gi];
        if (groupVarchar[gc.col] && val !== null) val = dicts[gc.col].rev[val];
        o[gc.out] = val === undefined ? null : val;
      }
      for (let ai = 0; ai < spec.aggs.length; ai++) o[spec.aggs[ai].out] = finalize(spec.aggs[ai].fn, g.st[ai]);
      out.push(o);
    }
    if (out.length === 0 && spec.groupCols.length === 0) out.push(emptyAggRow(spec));
    return out;
  }
}
