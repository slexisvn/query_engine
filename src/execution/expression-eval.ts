import { BoundExprKind, getExprType } from '../binder/expression-binder.js';
import type {
  BoundExpr,
  BoundLiteralNode,
} from '../binder/expression-binder.js';
import { DataType, castToNumber, epochDaysToDate, dateToEpochDays, epochMsToTimestamp } from '../storage/data-type.js';
import type { ColumnValue } from '../storage/data-type.js';
import type { DataChunk } from '../storage/chunk.js';
import type {
  EvalValue,
  IntervalValue,
  CompiledExpr,
  ColumnMapping,
  ExecColumn,
} from './execution-types.js';
import { resolveColumnIndex, UnresolvedReferenceError } from './column-resolve.js';
import { exprKey } from '../binder/expr-key.js';
import { binaryValueOp, unaryValueOp, normalizeComparable } from './value-ops.js';

const LIKE_CACHE_MAX = 256;

interface MappingSchema {
  columns?: ExecColumn[];
  alias?: string;
  tableName?: string;
}

export function compileExpression(expr: BoundExpr | null, columnMapping: ColumnMapping | null): CompiledExpr {
  if (!expr) return () => null;

  const materialized = materializedColumnOf(expr, columnMapping);
  if (materialized !== null) {
    return (chunk: DataChunk, rowIdx: number) => chunk.columns[materialized]?.get(rowIdx) ?? null;
  }

  switch (expr.kind) {
    case BoundExprKind.COLUMN_REF: {
      const colIdx = resolveColumnIndex(expr, columnMapping);
      return (chunk: DataChunk, rowIdx: number) => chunk.columns[colIdx]?.get(rowIdx) ?? null;
    }

    case BoundExprKind.LITERAL:
      return () => expr.value;

    case BoundExprKind.BINARY: {
      const left = compileExpression(expr.left, columnMapping);
      const right = compileExpression(expr.right, columnMapping);
      const timestampOperand = getExprType(expr.left) === DataType.TIMESTAMP
        || getExprType(expr.right as BoundExpr) === DataType.TIMESTAMP;
      return compileBinaryOp(expr.op, left, right, timestampOperand);
    }

    case BoundExprKind.UNARY: {
      const operand = compileExpression(expr.operand, columnMapping);
      const apply = unaryValueOp(expr.op);
      if (!apply) return operand;
      return (c: DataChunk, r: number) => apply(operand(c, r));
    }

    case BoundExprKind.BETWEEN: {
      const e = compileExpression(expr.expr, columnMapping);
      const lo = compileExpression(expr.low, columnMapping);
      const hi = compileExpression(expr.high, columnMapping);
      const negated = expr.negated;
      return (c: DataChunk, r: number) => {
        const v = e(c, r);
        if (v == null) return null;
        const loV = lo(c, r), hiV = hi(c, r);
        const ge = loV == null ? null : (v as number) >= (loV as number);
        const le = hiV == null ? null : (v as number) <= (hiV as number);
        let res;
        if (ge === false || le === false) res = false;
        else if (ge === null || le === null) res = null;
        else res = true;
        return negated ? (res === null ? null : !res) : res;
      };
    }

    case BoundExprKind.IN_LIST: {
      const e = compileExpression(expr.expr, columnMapping);
      const negated = expr.negated;
      if (Array.isArray(expr.list)) {
        const list = expr.list;
        const test = (v: EvalValue, has: (v: EvalValue) => boolean | null) => {
          if (v == null) return null;
          const found = has(v);
          return found ? true : (found === null ? null : false);
        };
        if (list.every((i) => i.kind === BoundExprKind.LITERAL)) {
          const litHasNull = list.some((i) => (i as BoundLiteralNode).value === null || (i as BoundLiteralNode).value === undefined);
          const values = new Set(list.filter((i) => (i as BoundLiteralNode).value != null).map((i) => normalizeComparable((i as BoundLiteralNode).value)));
          const has = (v: EvalValue) => values.has(normalizeComparable(v)) ? true : (litHasNull ? null : false);
          return (c: DataChunk, r: number) => { const res = test(e(c, r), has); return negated ? (res === null ? null : !res) : res; };
        }
        const items = list.map((i) => compileExpression(i, columnMapping));
        const has = (v: EvalValue, c: DataChunk, r: number) => {
          let anyNull = false;
          for (const i of items) { const iv = i(c, r); if (iv == null) { anyNull = true; continue; } if (iv == v) return true; }
          return anyNull ? null : false;
        };
        return (c: DataChunk, r: number) => { const v = e(c, r); if (v == null) return null; const found = has(v, c, r); const res = found ? true : (found === null ? null : false); return negated ? (res === null ? null : !res) : res; };
      }
      return () => true;
    }

    case BoundExprKind.LIKE: {
      const e = compileExpression(expr.expr, columnMapping);
      const p = compileExpression(expr.pattern, columnMapping);
      const negated = expr.negated;
      const regexCache: Map<string, RegExp> = new Map();
      const regexKeys: string[] = [];
      return (c: DataChunk, r: number) => {
        const val = e(c, r);
        const pattern = p(c, r);
        if (val === null || val === undefined || pattern === null || pattern === undefined) return null;
        const patternKey = String(pattern);
        let regex = regexCache.get(patternKey);
        if (!regex) {
          regex = likeToRegex(patternKey);
          if (regexCache.size >= LIKE_CACHE_MAX) {
            regexCache.delete(regexKeys.shift()!);
          }
          regexCache.set(patternKey, regex);
          regexKeys.push(patternKey);
        }
        const result = regex.test(String(val));
        return negated ? !result : result;
      };
    }

    case BoundExprKind.IS_NULL: {
      const e = compileExpression(expr.expr, columnMapping);
      if (expr.negated) return (c: DataChunk, r: number) => e(c, r) !== null && e(c, r) !== undefined;
      return (c: DataChunk, r: number) => e(c, r) === null || e(c, r) === undefined;
    }

    case BoundExprKind.CASE: {
      const whenClauses = expr.whenClauses.map((wc) => ({
        cond: compileExpression(wc.condition, columnMapping),
        result: compileExpression(wc.result, columnMapping),
      }));
      const elseExpr = expr.elseExpr ? compileExpression(expr.elseExpr, columnMapping) : () => null;
      return (c: DataChunk, r: number) => {
        for (const wc of whenClauses) {
          if (wc.cond(c, r)) return wc.result(c, r);
        }
        return elseExpr(c, r);
      };
    }

    case BoundExprKind.CAST: {
      const e = compileExpression(expr.expr, columnMapping);
      const targetType = expr.targetType as DataType;
      return (c: DataChunk, r: number) => castValue(e(c, r), targetType);
    }

    case BoundExprKind.EXTRACT: {
      const source = compileExpression(expr.source, columnMapping);
      const srcType = getExprType(expr.source);
      const field = expr.field;
      return (c: DataChunk, r: number) => {
        const val = source(c, r);
        if (val === null) return null;
        if (srcType === DataType.TIMESTAMP || typeof val === 'bigint' || (val as number) > 100000) {
          const ts = epochMsToTimestamp(typeof val === 'bigint' ? Number(val) : (val as number));
          switch (field) {
            case 'YEAR': return ts.year;
            case 'MONTH': return ts.month;
            case 'DAY': return ts.day;
            case 'HOUR': return ts.hour;
            case 'MINUTE': return ts.minute;
            case 'SECOND': return ts.second;
            default: return null;
          }
        }
        const d = epochDaysToDate(val as number);
        switch (field) {
          case 'YEAR': return d.year;
          case 'MONTH': return d.month;
          case 'DAY': return d.day;
          default: return null;
        }
      };
    }

    case BoundExprKind.FUNCTION: {
      const args = expr.args.map((a) => compileExpression(a, columnMapping));
      return compileFunction(expr.name, args);
    }

    case BoundExprKind.AGGREGATE:
      throw new UnresolvedReferenceError(`aggregate ${describeAggregate(expr)}`, columnMapping);

    case BoundExprKind.INTERVAL:
      return () => ({ value: expr.value, unit: expr.unit, _isInterval: true });

    case BoundExprKind.WINDOW:
      throw new UnresolvedReferenceError(`window function ${describeWindow(expr)}`, columnMapping);

    default:
      return () => null;
  }
}

function describeArgs(args: readonly BoundExpr[]): string {
  return args.map((arg) => exprKey(arg)).join(', ');
}

function describeAggregate(expr: Extract<BoundExpr, { kind: BoundExprKind.AGGREGATE }>): string {
  return `${expr.name.toUpperCase()}(${expr.distinct ? 'DISTINCT ' : ''}${describeArgs(expr.args)})`;
}

function describeWindow(expr: Extract<BoundExpr, { kind: BoundExprKind.WINDOW }>): string {
  return `${expr.name.toUpperCase()}(${describeArgs(expr.args)})`;
}

function compileBinaryOp(op: string, left: CompiledExpr, right: CompiledExpr, timestampOperand: boolean): CompiledExpr {
  const apply = binaryValueOp(op, timestampOperand);
  if (!apply) return () => null;
  return (c: DataChunk, r: number) => apply(left(c, r), right(c, r));
}

function compileFunction(name: string, args: CompiledExpr[]): CompiledExpr {
  switch (name.toUpperCase()) {
    case 'SUBSTRING': {
      const [str, from, len] = args;
      return (c: DataChunk, r: number) => {
        const s = str(c, r);
        if (s === null) return null;
        const start = (from(c, r) as number) - 1;
        if (len) return String(s).substring(start, start + (len(c, r) as number));
        return String(s).substring(start);
      };
    }
    case 'TRIM': return (c: DataChunk, r: number) => { const v = args[0](c, r); return v !== null ? String(v).trim() : null; };
    case 'UPPER': return (c: DataChunk, r: number) => { const v = args[0](c, r); return v !== null ? String(v).toUpperCase() : null; };
    case 'LOWER': return (c: DataChunk, r: number) => { const v = args[0](c, r); return v !== null ? String(v).toLowerCase() : null; };
    case 'ABS': return (c: DataChunk, r: number) => { const v = args[0](c, r); return v !== null ? Math.abs(v as number) : null; };
    case 'ROUND': return (c: DataChunk, r: number) => {
      const v = args[0](c, r);
      const d = args[1] ? args[1](c, r) : 0;
      if (v === null) return null;
      const factor = Math.pow(10, d as number);
      return Math.round((v as number) * factor) / factor;
    };
    case 'COALESCE': return (c: DataChunk, r: number) => {
      for (const a of args) {
        const v = a(c, r);
        if (v !== null && v !== undefined) return v;
      }
      return null;
    };
    case 'NULLIF': return (c: DataChunk, r: number) => {
      const v1 = args[0](c, r), v2 = args[1](c, r);
      return v1 == v2 ? null : v1;
    };
    case 'IS_TRUE': return (c: DataChunk, r: number) => args[0](c, r) === true;
    case 'IS_FALSE': return (c: DataChunk, r: number) => args[0](c, r) === false;
    case 'SQRT': return (c: DataChunk, r: number) => { const v = args[0](c, r); return v !== null ? Math.sqrt(v as number) : null; };
    case 'LENGTH': return (c: DataChunk, r: number) => { const v = args[0](c, r); return v !== null ? String(v).length : null; };
    case 'REPLACE': return (c: DataChunk, r: number) => {
      const s = args[0](c, r), from = args[1](c, r), to = args[2](c, r);
      if (s === null || from === null || to === null) return null;
      if (from === '') return String(s);
      return String(s).split(String(from)).join(String(to));
    };
    default: return () => null;
  }
}

function likeToRegex(pattern: string): RegExp {
  let regex = '^';
  for (const ch of pattern) {
    if (ch === '%') regex += '.*';
    else if (ch === '_') regex += '.';
    else if ('.+*?^${}()|[]\\'.includes(ch)) regex += '\\' + ch;
    else regex += ch;
  }
  regex += '$';
  return new RegExp(regex);
}

const MATERIALIZABLE_KINDS: ReadonlySet<BoundExprKind> = new Set([
  BoundExprKind.BINARY,
  BoundExprKind.UNARY,
  BoundExprKind.FUNCTION,
  BoundExprKind.AGGREGATE,
  BoundExprKind.CASE,
  BoundExprKind.CAST,
  BoundExprKind.EXTRACT,
  BoundExprKind.WINDOW,
]);

function materializedColumnOf(expr: BoundExpr, columnMapping: ColumnMapping | null): number | null {
  if (!columnMapping || !MATERIALIZABLE_KINDS.has(expr.kind)) return null;
  const index = columnMapping.get(exprKey(expr));
  return index === undefined ? null : index;
}

function castValue(val: EvalValue, targetType: DataType): EvalValue {
  if (val === null) return null;
  switch (targetType) {
    case DataType.INT32: {
      const numeric = castToNumber(val as ColumnValue);
      return numeric === null ? null : Math.trunc(numeric);
    }
    case DataType.INT64: {
      const numeric = castToNumber(val as ColumnValue);
      return numeric === null ? null : BigInt(Math.trunc(numeric));
    }
    case DataType.FLOAT64: return castToNumber(val as ColumnValue);
    case DataType.VARCHAR: {
      if (typeof val === 'bigint') return String(Number(val));
      return String(val);
    }
    case DataType.BOOLEAN: return !!val;
    case DataType.TIMESTAMP: {
      if (typeof val === 'string') {
        return new Date(val).getTime();
      }
      return Number(val);
    }
    case DataType.DATE: {
      if (typeof val === 'string') {
        const [y, m, d] = val.split('-').map(Number);
        return dateToEpochDays(y, m, d);
      }
      return val;
    }
    default: return val;
  }
}

export function buildColumnMapping(schemas: MappingSchema[] | ExecColumn[][]): ColumnMapping {
  const mapping: ColumnMapping = new Map();
  let idx = 0;
  for (const schema of schemas as MappingSchema[]) {
    const cols = (schema.columns || schema) as ExecColumn[];
    for (const col of cols) {
      const alias = schema.alias || schema.tableName || '';
      const key = `${alias}.${col.name}`.toUpperCase();
      mapping.set(key, idx);
      mapping.set(col.name.toUpperCase(), idx);
      idx++;
    }
  }
  return mapping;
}
