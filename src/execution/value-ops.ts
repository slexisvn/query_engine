import { epochDaysToDate, dateToEpochDays, epochMsToTimestamp, timestampToEpochMs } from '../storage/data-type.js';
import type { EvalValue, IntervalValue } from './execution-types.js';

export type BinaryValueOp = (left: EvalValue, right: EvalValue) => EvalValue;

export type UnaryValueOp = (operand: EvalValue) => EvalValue;

export function toNum(value: EvalValue): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

export function normalizeComparable(value: EvalValue): EvalValue {
  return typeof value === 'bigint' ? Number(value) : value;
}

export function numOp(left: EvalValue, right: EvalValue, fn: (a: number, b: number) => number): number {
  return fn(toNum(left), toNum(right));
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

const MS_PER_UNIT: ReadonlyMap<string, number> = new Map([
  ['DAY', 86400000],
  ['HOUR', 3600000],
  ['MINUTE', 60000],
  ['SECOND', 1000],
]);

function shiftMonths(year: number, month: number, day: number, months: number): { year: number; month: number; day: number } {
  let shifted = month + months;
  let shiftedYear = year;
  while (shifted > 12) { shifted -= 12; shiftedYear++; }
  while (shifted < 1) { shifted += 12; shiftedYear--; }
  return { year: shiftedYear, month: shifted, day: Math.min(day, daysInMonth(shiftedYear, shifted)) };
}

export function addInterval(epochDays: number, amount: number, unit: string): number {
  if (unit !== 'YEAR' && unit !== 'MONTH') return epochDays + amount;

  const date = epochDaysToDate(epochDays);
  const months = unit === 'YEAR' ? amount * 12 : amount;
  const shifted = shiftMonths(date.year, date.month, date.day, months);
  return dateToEpochDays(shifted.year, shifted.month, shifted.day);
}

export function addIntervalMs(epochMs: number, amount: number, unit: string): number {
  const msPerUnit = MS_PER_UNIT.get(unit);
  if (msPerUnit !== undefined) return epochMs + amount * msPerUnit;
  if (unit !== 'YEAR' && unit !== 'MONTH') return epochMs + amount;

  const parts = epochMsToTimestamp(epochMs);
  const months = unit === 'YEAR' ? amount * 12 : amount;
  const shifted = shiftMonths(parts.year, parts.month, parts.day, months);
  return timestampToEpochMs(shifted.year, shifted.month, shifted.day, parts.hour, parts.minute, parts.second, parts.ms);
}

function isInterval(value: EvalValue): value is IntervalValue {
  return !!(value as IntervalValue)?._isInterval;
}

function comparison(compare: (left: number, right: number) => boolean): BinaryValueOp {
  return (left, right) => (left == null || right == null) ? null : compare(toNum(left), toNum(right));
}

function arithmetic(fn: (a: number, b: number) => number): BinaryValueOp {
  return (left, right) => (left === null || right === null || left === undefined || right === undefined)
    ? null
    : numOp(left, right, fn);
}

const BINARY_VALUE_OPS: Record<string, BinaryValueOp> = {
  '=': comparison((a, b) => a === b),
  '<>': comparison((a, b) => a !== b),
  '<': comparison((a, b) => a < b),
  '>': comparison((a, b) => a > b),
  '<=': comparison((a, b) => a <= b),
  '>=': comparison((a, b) => a >= b),

  'AND': (left, right) => {
    if (left === false || right === false) return false;
    if (left == null || right == null) return null;
    return true;
  },
  'OR': (left, right) => {
    if (left === true || right === true) return true;
    if (left == null || right == null) return null;
    return false;
  },

  '+': (left, right) => {
    if (left === null || right === null || left === undefined || right === undefined) return null;
    if (isInterval(right)) return addInterval(toNum(left), right.value, right.unit);
    if (isInterval(left)) return addInterval(toNum(right), left.value, left.unit);
    return numOp(left, right, (a, b) => a + b);
  },
  '-': (left, right) => {
    if (left === null || right === null || left === undefined || right === undefined) return null;
    if (isInterval(right)) return addInterval(toNum(left), -right.value, right.unit);
    return numOp(left, right, (a, b) => a - b);
  },
  '+ts': (left, right) => {
    if (left === null || right === null || left === undefined || right === undefined) return null;
    if (isInterval(right)) return addIntervalMs(toNum(left), right.value, right.unit);
    if (isInterval(left)) return addIntervalMs(toNum(right), left.value, left.unit);
    return numOp(left, right, (a, b) => a + b);
  },
  '-ts': (left, right) => {
    if (left === null || right === null || left === undefined || right === undefined) return null;
    if (isInterval(right)) return addIntervalMs(toNum(left), -right.value, right.unit);
    return numOp(left, right, (a, b) => a - b);
  },
  '*': arithmetic((a, b) => a * b),
  '%': arithmetic((a, b) => a % b),
  '/': (left, right) => {
    if (left === null || right === null || left === undefined || right === undefined) return null;
    return toNum(right) === 0 ? null : numOp(left, right, (a, b) => a / b);
  },
  '||': (left, right) => (left === null || right === null || left === undefined || right === undefined)
    ? null
    : String(left) + String(right),
};

const UNARY_VALUE_OPS: Record<string, UnaryValueOp> = {
  '-': operand => operand == null ? null : -(operand as number),
  'NOT': operand => operand == null ? null : !(operand as boolean),
};

export function binaryValueOp(op: string, timestampOperand: boolean = false): BinaryValueOp | null {
  if (timestampOperand && (op === '+' || op === '-')) {
    return BINARY_VALUE_OPS[`${op}ts`] ?? null;
  }
  return BINARY_VALUE_OPS[op] ?? null;
}

export function unaryValueOp(op: string): UnaryValueOp | null {
  return UNARY_VALUE_OPS[op] ?? null;
}
