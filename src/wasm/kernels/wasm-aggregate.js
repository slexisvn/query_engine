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

  const dataPtr = loader.resolveDataPtr(data, 4);
  return instance.exports.sumI32(dataPtr, data.length);
}

export async function wasmSumF64(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const dataPtr = loader.resolveDataPtr(data, 8);
  return instance.exports.sumF64(dataPtr, data.length);
}

export async function wasmMinI32(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const dataPtr = loader.resolveDataPtr(data, 4);
  return instance.exports.minI32(dataPtr, data.length);
}

export async function wasmMaxI32(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const dataPtr = loader.resolveDataPtr(data, 4);
  return instance.exports.maxI32(dataPtr, data.length);
}

export async function wasmMinF64(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const dataPtr = loader.resolveDataPtr(data, 8);
  return instance.exports.minF64(dataPtr, data.length);
}

export async function wasmMaxF64(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();

  const dataPtr = loader.resolveDataPtr(data, 8);
  return instance.exports.maxF64(dataPtr, data.length);
}
