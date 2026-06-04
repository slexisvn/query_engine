import { getGlobalLoader } from '../loader.js';

let _filterInstance = null;

async function getFilterInstance() {
  if (_filterInstance) return _filterInstance;
  const loader = await getGlobalLoader();
  _filterInstance = { loader, instance: await loader.loadModule('filter') };
  return _filterInstance;
}

export async function wasmFilterEqI32(data, value) {
  const { loader, instance } = await getFilterInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 4);
  const selVecPtr = loader.alloc(count * 4);

  loader.writeI32Array(data, dataPtr);

  const matchCount = instance.exports.filterEqI32(dataPtr, selVecPtr, count, value);
  const result = new Uint32Array(matchCount);
  const selView = loader.readI32Array(selVecPtr, matchCount);
  for (let i = 0; i < matchCount; i++) result[i] = selView[i];

  return result;
}

export async function wasmFilterLtI32(data, value) {
  const { loader, instance } = await getFilterInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 4);
  const selVecPtr = loader.alloc(count * 4);

  loader.writeI32Array(data, dataPtr);

  const matchCount = instance.exports.filterLtI32(dataPtr, selVecPtr, count, value);
  const result = new Uint32Array(matchCount);
  const selView = loader.readI32Array(selVecPtr, matchCount);
  for (let i = 0; i < matchCount; i++) result[i] = selView[i];

  return result;
}

export async function wasmFilterGtI32(data, value) {
  const { loader, instance } = await getFilterInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 4);
  const selVecPtr = loader.alloc(count * 4);

  loader.writeI32Array(data, dataPtr);

  const matchCount = instance.exports.filterGtI32(dataPtr, selVecPtr, count, value);
  const result = new Uint32Array(matchCount);
  const selView = loader.readI32Array(selVecPtr, matchCount);
  for (let i = 0; i < matchCount; i++) result[i] = selView[i];

  return result;
}

export async function wasmFilterBetweenI32(data, low, high) {
  const { loader, instance } = await getFilterInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 4);
  const selVecPtr = loader.alloc(count * 4);

  loader.writeI32Array(data, dataPtr);

  const matchCount = instance.exports.filterBetweenI32(dataPtr, selVecPtr, count, low, high);
  const result = new Uint32Array(matchCount);
  const selView = loader.readI32Array(selVecPtr, matchCount);
  for (let i = 0; i < matchCount; i++) result[i] = selView[i];

  return result;
}

export async function wasmSumF64(data) {
  const { loader, instance } = await getFilterInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);

  return instance.exports.sumF64(dataPtr, count);
}
