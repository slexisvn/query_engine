import { epochDaysToDate, dateToEpochDays } from '../storage/data-type.js';
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

export function addInterval(epochDays: number, amount: number, unit: string): number {
  if (unit === 'DAY') return epochDays + amount;

  const date = epochDaysToDate(epochDays);
  if (unit === 'YEAR') {
    const year = date.year + amount;
    return dateToEpochDays(year, date.month, Math.min(date.day, daysInMonth(year, date.month)));
  }
  if (unit === 'MONTH') {
    let month = date.month + amount;
    let year = date.year;
    while (month > 12) { month -= 12; year++; }
    while (month < 1) { month += 12; year--; }
    return dateToEpochDays(year, month, Math.min(date.day, daysInMonth(year, month)));
  }
  return epochDays + amount;
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

export function binaryValueOp(op: string): BinaryValueOp | null {
  return BINARY_VALUE_OPS[op] ?? null;
}

export function unaryValueOp(op: string): UnaryValueOp | null {
  return UNARY_VALUE_OPS[op] ?? null;
}
