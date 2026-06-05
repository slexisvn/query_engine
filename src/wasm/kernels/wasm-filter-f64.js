import { getGlobalLoader } from '../loader.js';

let _coreInstance = null;

async function getCoreInstance() {
  if (_coreInstance) return _coreInstance;
  const loader = await getGlobalLoader();
  _coreInstance = { loader, instance: await loader.loadModule('core') };
  return _coreInstance;
}

export async function wasmFilterEqF64(data, value) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const selVecPtr = loader.alloc(count * 4);

  loader.writeF64Array(data, dataPtr);

  const matchCount = instance.exports.filterEqF64(dataPtr, selVecPtr, count, value);
  const selView = loader.readU32Array(selVecPtr, matchCount);
  return selView;
}

export async function wasmFilterLtF64(data, value) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const selVecPtr = loader.alloc(count * 4);

  loader.writeF64Array(data, dataPtr);

  const matchCount = instance.exports.filterLtF64(dataPtr, selVecPtr, count, value);
  const selView = loader.readU32Array(selVecPtr, matchCount);
  return selView;
}

export async function wasmFilterGtF64(data, value) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const selVecPtr = loader.alloc(count * 4);

  loader.writeF64Array(data, dataPtr);

  const matchCount = instance.exports.filterGtF64(dataPtr, selVecPtr, count, value);
  const selView = loader.readU32Array(selVecPtr, matchCount);
  return selView;
}

export async function wasmFilterLeF64(data, value) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const selVecPtr = loader.alloc(count * 4);

  loader.writeF64Array(data, dataPtr);

  const matchCount = instance.exports.filterLeF64(dataPtr, selVecPtr, count, value);
  const selView = loader.readU32Array(selVecPtr, matchCount);
  return selView;
}

export async function wasmFilterGeF64(data, value) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const selVecPtr = loader.alloc(count * 4);

  loader.writeF64Array(data, dataPtr);

  const matchCount = instance.exports.filterGeF64(dataPtr, selVecPtr, count, value);
  const selView = loader.readU32Array(selVecPtr, matchCount);
  return selView;
}

export async function wasmFilterBetweenF64(data, low, high) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const selVecPtr = loader.alloc(count * 4);

  loader.writeF64Array(data, dataPtr);

  const matchCount = instance.exports.filterBetweenF64(dataPtr, selVecPtr, count, low, high);
  const selView = loader.readU32Array(selVecPtr, matchCount);
  return selView;
}

export async function wasmFilterLeI32(data, value) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 4);
  const selVecPtr = loader.alloc(count * 4);

  loader.writeI32Array(data, dataPtr);

  const matchCount = instance.exports.filterLeI32(dataPtr, selVecPtr, count, value);
  const selView = loader.readU32Array(selVecPtr, matchCount);
  return selView;
}

export async function wasmFilterGeI32(data, value) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 4);
  const selVecPtr = loader.alloc(count * 4);

  loader.writeI32Array(data, dataPtr);

  const matchCount = instance.exports.filterGeI32(dataPtr, selVecPtr, count, value);
  const selView = loader.readU32Array(selVecPtr, matchCount);
  return selView;
}
