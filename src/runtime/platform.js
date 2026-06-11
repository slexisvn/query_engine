const SINGLE_THREADED = 1;

const processEnv = typeof process !== 'undefined' && process.env ? process.env : null;

export function getEnvInt(key, fallback) {
  const val = processEnv?.[key];
  return val !== undefined ? parseInt(val, 10) : fallback;
}

export function getEnvFloat(key, fallback) {
  const val = processEnv?.[key];
  return val !== undefined ? parseFloat(val) : fallback;
}

export function getEnvFlag(key, fallback) {
  const val = processEnv?.[key];
  if (val === undefined) return fallback;
  return val === '1' || val.toLowerCase() === 'true';
}

export function getCpuCount() {
  return globalThis.navigator?.hardwareConcurrency ?? SINGLE_THREADED;
}
