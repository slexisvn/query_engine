import { getGlobalLoader } from '../loader.js';

let _coreInstance = null;

async function getCoreInstance() {
  if (_coreInstance) return _coreInstance;
  const loader = await getGlobalLoader();
  _coreInstance = { loader, instance: await loader.loadModule('core') };
  return _coreInstance;
}

export async function wasmFilterEqI32(data, value) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 4);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = instance.exports.filterEqI32(dataPtr, selVecPtr, count, value);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmFilterLtI32(data, value) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 4);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = instance.exports.filterLtI32(dataPtr, selVecPtr, count, value);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmFilterGtI32(data, value) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 4);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = instance.exports.filterGtI32(dataPtr, selVecPtr, count, value);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmFilterBetweenI32(data, low, high) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.resolveDataPtr(data, 4);
  const selVecPtr = loader.alloc(count * 4);

  const matchCount = instance.exports.filterBetweenI32(dataPtr, selVecPtr, count, low, high);
  return loader.readU32Array(selVecPtr, matchCount);
}

export async function wasmSumF64(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const dataPtr = loader.resolveDataPtr(data, 8);
  return instance.exports.sumF64(dataPtr, data.length);
}
