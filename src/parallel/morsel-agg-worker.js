import { parentPort } from 'worker_threads';

const SEP = '|';
const NUL = 'Nul';

function newState(fn) {
  if (fn === 'count' || fn === 'countStar') return { c: 0 };
  if (fn === 'sum' || fn === 'avg') return { s: 0, n: 0 };
  return { m: null };
}

function updateState(fn, st, v) {
  if (fn === 'count') st.c++;
  else if (fn === 'sum' || fn === 'avg') { st.s += v; st.n++; }
  else if (fn === 'min') { if (st.m === null || v < st.m) st.m = v; }
  else if (fn === 'max') { if (st.m === null || v > st.m) st.m = v; }
}

parentPort.on('message', (msg) => {
  const { reqId, dataSab, counterSab, nRows, layout, filter, groupCols, aggs, morselRows } = msg;
  const counter = new Int32Array(counterSab, 0, 1);

  const acc = {};
  for (const name in layout.cols) {
    const c = layout.cols[name];
    const view = c.kind === 'i32'
      ? new Int32Array(dataSab, c.dataByteOffset, nRows)
      : new Float64Array(dataSab, c.dataByteOffset, nRows);
    const nulls = c.nullByteOffset >= 0 ? new Uint8Array(dataSab, c.nullByteOffset, nRows) : null;
    acc[name] = { view, nulls };
  }
  const getVal = (name, i) => { const a = acc[name]; return (a.nulls && a.nulls[i]) ? null : a.view[i]; };

  const ng = groupCols.length;
  const na = aggs.length;
  const groups = new Map();

  while (true) {
    const start = Atomics.add(counter, 0, morselRows);
    if (start >= nRows) break;
    const end = Math.min(start + morselRows, nRows);

    for (let i = start; i < end; i++) {
      let pass = true;
      for (let fi = 0; fi < filter.length; fi++) {
        const f = filter[fi];
        const v = getVal(f.col, i);
        if (v === null) { pass = false; break; }
        const r = f.op === '>' ? v > f.value : f.op === '<' ? v < f.value
          : f.op === '>=' ? v >= f.value : f.op === '<=' ? v <= f.value
          : f.op === '=' ? v === f.value : v !== f.value;
        if (!r) { pass = false; break; }
      }
      if (!pass) continue;

      let key = '';
      const gv = new Array(ng);
      for (let gi = 0; gi < ng; gi++) {
        const val = getVal(groupCols[gi], i);
        gv[gi] = val;
        key += SEP + (val === null ? NUL : val);
      }
      let g = groups.get(key);
      if (!g) {
        g = { gv, st: new Array(na) };
        for (let ai = 0; ai < na; ai++) g.st[ai] = newState(aggs[ai].fn);
        groups.set(key, g);
      }
      for (let ai = 0; ai < na; ai++) {
        const ag = aggs[ai];
        if (ag.fn === 'countStar') { g.st[ai].c++; continue; }
        const v = getVal(ag.col, i);
        if (v === null) continue;
        updateState(ag.fn, g.st[ai], v);
      }
    }
  }

  const out = [];
  for (const [k, g] of groups) out.push({ k, gv: g.gv, st: g.st });
  parentPort.postMessage({ reqId, partials: out });
});
