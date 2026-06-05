import { getGlobalLoader } from '../loader.js';

let _coreInstance = null;

async function getCoreInstance() {
  if (_coreInstance) return _coreInstance;
  const loader = await getGlobalLoader();
  _coreInstance = { loader, instance: await loader.loadModule('core') };
  return _coreInstance;
}

export async function wasmVecAddF64(a, b) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = a.length;
  const aPtr = loader.alloc(count * 8);
  const bPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(a, aPtr);
  loader.writeF64Array(b, bPtr);
  instance.exports.vecAddF64(aPtr, bPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmVecSubF64(a, b) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = a.length;
  const aPtr = loader.alloc(count * 8);
  const bPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(a, aPtr);
  loader.writeF64Array(b, bPtr);
  instance.exports.vecSubF64(aPtr, bPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmVecMulF64(a, b) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = a.length;
  const aPtr = loader.alloc(count * 8);
  const bPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(a, aPtr);
  loader.writeF64Array(b, bPtr);
  instance.exports.vecMulF64(aPtr, bPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmVecDivF64(a, b) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = a.length;
  const aPtr = loader.alloc(count * 8);
  const bPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(a, aPtr);
  loader.writeF64Array(b, bPtr);
  instance.exports.vecDivF64(aPtr, bPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmScalarAddF64(data, scalar) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  instance.exports.scalarAddF64(dataPtr, scalar, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmScalarSubF64(data, scalar) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  instance.exports.scalarSubF64(dataPtr, scalar, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmScalarMulF64(data, scalar) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  instance.exports.scalarMulF64(dataPtr, scalar, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmScalarDivF64(data, scalar) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  instance.exports.scalarDivF64(dataPtr, scalar, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmScalarSubRevF64(scalar, data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  instance.exports.scalarSubRevF64(scalar, dataPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmScalarDivRevF64(scalar, data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  instance.exports.scalarDivRevF64(scalar, dataPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmWidenI32ToF64(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 4);
  const outPtr = loader.alloc(count * 8);
  loader.writeI32Array(data, dataPtr);
  instance.exports.widenI32ToF64(dataPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmNegF64(data) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const count = data.length;
  const dataPtr = loader.alloc(count * 8);
  const outPtr = loader.alloc(count * 8);
  loader.writeF64Array(data, dataPtr);
  instance.exports.negF64(dataPtr, outPtr, count);
  return loader.readF64Array(outPtr, count);
}

export async function wasmCountBits(bitmap, bitCount) {
  const { loader, instance } = await getCoreInstance();
  loader.reset();
  const wordCount = Math.ceil(bitCount / 32);
  const byteCount = wordCount * 4;
  const bitmapPtr = loader.alloc(byteCount);
  new Uint8Array(loader.getBuffer(), bitmapPtr, byteCount).set(
    new Uint8Array(bitmap.buffer, bitmap.byteOffset, byteCount)
  );
  return instance.exports.countBitmapBits(bitmapPtr, bitCount);
}
