import { getGlobalLoader } from '../loader.js';

let _coreInstance = null;

async function getCoreInstance() {
  if (_coreInstance) return _coreInstance;
  const loader = await getGlobalLoader();
  _coreInstance = { loader, instance: await loader.loadModule('core') };
  return _coreInstance;
}

export async function wasmSumI32(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 4);
  loader.writeI32Array(data, dataPtr);

  return instance.exports.sumI32(dataPtr, count);
}

export async function wasmSumF64(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);

  return instance.exports.sumF64(dataPtr, count);
}

export async function wasmMinI32(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 4);
  loader.writeI32Array(data, dataPtr);

  return instance.exports.minI32(dataPtr, count);
}

export async function wasmMaxI32(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 4);
  loader.writeI32Array(data, dataPtr);

  return instance.exports.maxI32(dataPtr, count);
}

export async function wasmMinF64(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);

  return instance.exports.minF64(dataPtr, count);
}

export async function wasmMaxF64(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);

  return instance.exports.maxF64(dataPtr, count);
}
