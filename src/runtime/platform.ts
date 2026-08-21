const SINGLE_THREADED = 1;

const processEnv: NodeJS.ProcessEnv | null =
  typeof process !== 'undefined' && process.env ? process.env : null;

export function getEnvInt(key: string, fallback: number): number {
  const val: string | undefined = processEnv?.[key];
  return val !== undefined ? parseInt(val, 10) : fallback;
}

export function getEnvFloat(key: string, fallback: number): number {
  const val: string | undefined = processEnv?.[key];
  return val !== undefined ? parseFloat(val) : fallback;
}

export function getEnvString(key: string, fallback: string): string {
  const val: string | undefined = processEnv?.[key];
  return val !== undefined ? val : fallback;
}

export function getEnvFlag(key: string, fallback: boolean): boolean {
  const val: string | undefined = processEnv?.[key];
  if (val === undefined) return fallback;
  return val === '1' || val.toLowerCase() === 'true';
}

export function getCpuCount(): number {
  return globalThis.navigator?.hardwareConcurrency ?? SINGLE_THREADED;
}
