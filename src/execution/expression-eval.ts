import { BoundExprKind } from '../binder/expression-binder.js';
import { DataType, epochDaysToDate, dateToEpochDays, epochMsToTimestamp } from '../storage/data-type.js';

const LIKE_CACHE_MAX = 256;

export function compileExpression(expr: any, columnMapping: any): any {
  if (!expr) return () => null;

  switch (expr.kind) {
    case BoundExprKind.COLUMN_REF: {
      const colIdx = resolveColumnIndex(expr, columnMapping);
      return (chunk: any, rowIdx: any) => chunk.columns[colIdx]?.get(rowIdx) ?? null;
    }

    case BoundExprKind.LITERAL:
      return () => expr.value;

    case BoundExprKind.BINARY: {
      const left = compileExpression(expr.left, columnMapping);
      const right = compileExpression(expr.right, columnMapping);
      return compileBinaryOp(expr.op, left, right);
    }

    case BoundExprKind.UNARY: {
      const operand = compileExpression(expr.operand, columnMapping);
      if (expr.op === '-') return (c: any, r: any) => { const v = operand(c, r); return v == null ? null : -v; };
      if (expr.op === 'NOT') return (c: any, r: any) => { const v = operand(c, r); return v == null ? null : !v; };
      return operand;
    }

    case BoundExprKind.BETWEEN: {
      const e = compileExpression(expr.expr, columnMapping);
      const lo = compileExpression(expr.low, columnMapping);
      const hi = compileExpression(expr.high, columnMapping);
      return (c: any, r: any) => {
        const v = e(c, r);
        if (v == null) return null;
        const loV = lo(c, r), hiV = hi(c, r);
        const ge = loV == null ? null : v >= loV;
        const le = hiV == null ? null : v <= hiV;
        let res;
        if (ge === false || le === false) res = false;
        else if (ge === null || le === null) res = null;
        else res = true;
        return expr.negated ? (res === null ? null : !res) : res;
      };
    }

    case BoundExprKind.IN_LIST: {
      const e = compileExpression(expr.expr, columnMapping);
      if (Array.isArray(expr.list)) {
        const test = (v: any, has: any) => {
          if (v == null) return null;
          const found = has(v);
          return found ? true : (found === null ? null : false);
        };
        if (expr.list.every((i: any) => i.kind === BoundExprKind.LITERAL)) {
          const litHasNull = expr.list.some((i: any) => i.value === null || i.value === undefined);
          const values = new Set(expr.list.filter((i: any) => i.value != null).map((i: any) => normalizeComparable(i.value)));
          const has = (v: any) => values.has(normalizeComparable(v)) ? true : (litHasNull ? null : false);
          return (c: any, r: any) => { const res = test(e(c, r), has); return expr.negated ? (res === null ? null : !res) : res; };
        }
        const items = expr.list.map((i: any) => compileExpression(i, columnMapping));
        const has = (v: any, c: any, r: any) => {
          let anyNull = false;
          for (const i of items) { const iv = i(c, r); if (iv == null) { anyNull = true; continue; } if (iv == v) return true; }
          return anyNull ? null : false;
        };
        return (c: any, r: any) => { const v = e(c, r); if (v == null) return null; const found = has(v, c, r); const res = found ? true : (found === null ? null : false); return expr.negated ? (res === null ? null : !res) : res; };
      }
      return () => true;
    }

    case BoundExprKind.LIKE: {
      const e = compileExpression(expr.expr, columnMapping);
      const p = compileExpression(expr.pattern, columnMapping);
      const regexCache = new Map();
      const regexKeys: any[] = [];
      return (c: any, r: any) => {
        const val = e(c, r);
        const pattern = p(c, r);
        if (val === null || val === undefined || pattern === null || pattern === undefined) return null;
        const patternKey = String(pattern);
        let regex = regexCache.get(patternKey);
        if (!regex) {
          regex = likeToRegex(patternKey);
          if (regexCache.size >= LIKE_CACHE_MAX) {
            regexCache.delete(regexKeys.shift());
          }
          regexCache.set(patternKey, regex);
          regexKeys.push(patternKey);
        }
        const result = regex.test(String(val));
        return expr.negated ? !result : result;
      };
    }

    case BoundExprKind.IS_NULL: {
      const e = compileExpression(expr.expr, columnMapping);
      if (expr.negated) return (c: any, r: any) => e(c, r) !== null && e(c, r) !== undefined;
      return (c: any, r: any) => e(c, r) === null || e(c, r) === undefined;
    }

    case BoundExprKind.CASE: {
      const whenClauses = expr.whenClauses.map((wc: any) => ({
        cond: compileExpression(wc.condition, columnMapping),
        result: compileExpression(wc.result, columnMapping),
      }));
      const elseExpr = expr.elseExpr ? compileExpression(expr.elseExpr, columnMapping) : () => null;
      return (c: any, r: any) => {
        for (const wc of whenClauses) {
          if (wc.cond(c, r)) return wc.result(c, r);
        }
        return elseExpr(c, r);
      };
    }

    case BoundExprKind.CAST: {
      const e = compileExpression(expr.expr, columnMapping);
      return (c: any, r: any) => castValue(e(c, r), expr.targetType);
    }

    case BoundExprKind.EXTRACT: {
      const source = compileExpression(expr.source, columnMapping);
      const srcType = expr.source?.dataType || expr.source?.resultType;
      return (c: any, r: any) => {
        const val = source(c, r);
        if (val === null) return null;
        if (srcType === DataType.TIMESTAMP || typeof val === 'bigint' || val > 100000) {
          const ts = epochMsToTimestamp(typeof val === 'bigint' ? Number(val) : val);
          switch (expr.field) {
            case 'YEAR': return ts.year;
            case 'MONTH': return ts.month;
            case 'DAY': return ts.day;
            case 'HOUR': return ts.hour;
            case 'MINUTE': return ts.minute;
            case 'SECOND': return ts.second;
            default: return null;
          }
        }
        const d = epochDaysToDate(val);
        switch (expr.field) {
          case 'YEAR': return d.year;
          case 'MONTH': return d.month;
          case 'DAY': return d.day;
          default: return null;
        }
      };
    }

    case BoundExprKind.FUNCTION: {
      const args = expr.args.map((a: any) => compileExpression(a, columnMapping));
      return compileFunction(expr.name, args);
    }

    case BoundExprKind.AGGREGATE: {
      const aggKey = aggExprKey(expr);
      if (columnMapping && columnMapping.has(aggKey)) {
        const colIdx = columnMapping.get(aggKey);
        return (chunk: any, rowIdx: any) => chunk.columns[colIdx]?.get(rowIdx) ?? null;
      }
      return expr.args.length > 0
        ? compileExpression(expr.args[0], columnMapping)
        : () => null;
    }

    case BoundExprKind.INTERVAL:
      return () => ({ value: expr.value, unit: expr.unit, _isInterval: true });

    case BoundExprKind.WINDOW: {
      const wKey = windowExprKey(expr);
      if (columnMapping && columnMapping.has(wKey)) {
        const colIdx = columnMapping.get(wKey);
        return (chunk: any, rowIdx: any) => chunk.columns[colIdx]?.get(rowIdx) ?? null;
      }
      return () => null;
    }

    default:
      return () => null;
  }
}

function addInterval(epochDays: any, amount: any, unit: any): any {
  if (unit === 'DAY') return epochDays + amount;
  const d = epochDaysToDate(epochDays);
  if (unit === 'YEAR') {
    return dateToEpochDays(d.year + amount, d.month, Math.min(d.day, daysInMonth(d.year + amount, d.month)));
  }
  if (unit === 'MONTH') {
    let newMonth = d.month + amount;
    let newYear = d.year;
    while (newMonth > 12) { newMonth -= 12; newYear++; }
    while (newMonth < 1) { newMonth += 12; newYear--; }
    return dateToEpochDays(newYear, newMonth, Math.min(d.day, daysInMonth(newYear, newMonth)));
  }
  return epochDays + amount;
}

function daysInMonth(year: any, month: any): any {
  return new Date(year, month, 0).getDate();
}

function toNum(val: any): any {
  return typeof val === 'bigint' ? Number(val) : val;
}

function normalizeComparable(val: any): any {
  return typeof val === 'bigint' ? Number(val) : val;
}

function numOp(a: any, b: any, fn: any): any {
  return fn(toNum(a), toNum(b));
}

function compileBinaryOp(op: any, left: any, right: any): any {
  switch (op) {
    case '=': return (c: any, r: any) => { const l = left(c, r), rv = right(c, r); return (l == null || rv == null) ? null : toNum(l) == toNum(rv); };
    case '<>': return (c: any, r: any) => { const l = left(c, r), rv = right(c, r); return (l == null || rv == null) ? null : toNum(l) != toNum(rv); };
    case '<': return (c: any, r: any) => { const l = left(c, r), rv = right(c, r); return (l == null || rv == null) ? null : toNum(l) < toNum(rv); };
    case '>': return (c: any, r: any) => { const l = left(c, r), rv = right(c, r); return (l == null || rv == null) ? null : toNum(l) > toNum(rv); };
    case '<=': return (c: any, r: any) => { const l = left(c, r), rv = right(c, r); return (l == null || rv == null) ? null : toNum(l) <= toNum(rv); };
    case '>=': return (c: any, r: any) => { const l = left(c, r), rv = right(c, r); return (l == null || rv == null) ? null : toNum(l) >= toNum(rv); };
    case 'AND': return (c: any, r: any) => { const l = left(c, r), rv = right(c, r); if (l === false || rv === false) return false; if (l == null || rv == null) return null; return true; };
    case 'OR': return (c: any, r: any) => { const l = left(c, r), rv = right(c, r); if (l === true || rv === true) return true; if (l == null || rv == null) return null; return false; };
    case '+': return (c: any, r: any) => {
      const l = left(c, r), rv = right(c, r);
      if (l === null || rv === null) return null;
      if (rv?._isInterval) return addInterval(toNum(l), rv.value, rv.unit);
      if (l?._isInterval) return addInterval(toNum(rv), l.value, l.unit);
      return numOp(l, rv, (a: any, b: any) => a + b);
    };
    case '-': return (c: any, r: any) => {
      const l = left(c, r), rv = right(c, r);
      if (l === null || rv === null) return null;
      if (rv?._isInterval) return addInterval(toNum(l), -rv.value, rv.unit);
      return numOp(l, rv, (a: any, b: any) => a - b);
    };
    case '*': return (c: any, r: any) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null ? numOp(l, rv, (a: any, b: any) => a * b) : null; };
    case '/': return (c: any, r: any) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null && rv !== 0 ? numOp(l, rv, (a: any, b: any) => a / b) : null; };
    case '%': return (c: any, r: any) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null ? numOp(l, rv, (a: any, b: any) => a % b) : null; };
    case '||': return (c: any, r: any) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null ? String(l) + String(rv) : null; };
    default: return () => null;
  }
}

function compileFunction(name: any, args: any): any {
  switch (name.toUpperCase()) {
    case 'SUBSTRING': {
      const [str, from, len] = args;
      return (c: any, r: any) => {
        const s = str(c, r);
        if (s === null) return null;
        const start = from(c, r) - 1;
        if (len) return String(s).substring(start, start + len(c, r));
        return String(s).substring(start);
      };
    }
    case 'TRIM': return (c: any, r: any) => { const v = args[0](c, r); return v !== null ? String(v).trim() : null; };
    case 'UPPER': return (c: any, r: any) => { const v = args[0](c, r); return v !== null ? String(v).toUpperCase() : null; };
    case 'LOWER': return (c: any, r: any) => { const v = args[0](c, r); return v !== null ? String(v).toLowerCase() : null; };
    case 'ABS': return (c: any, r: any) => { const v = args[0](c, r); return v !== null ? Math.abs(v) : null; };
    case 'ROUND': return (c: any, r: any) => {
      const v = args[0](c, r);
      const d = args[1] ? args[1](c, r) : 0;
      if (v === null) return null;
      const factor = Math.pow(10, d);
      return Math.round(v * factor) / factor;
    };
    case 'COALESCE': return (c: any, r: any) => {
      for (const a of args) {
        const v = a(c, r);
        if (v !== null && v !== undefined) return v;
      }
      return null;
    };
    case 'NULLIF': return (c: any, r: any) => {
      const v1 = args[0](c, r), v2 = args[1](c, r);
      return v1 == v2 ? null : v1;
    };
    case 'SQRT': return (c: any, r: any) => { const v = args[0](c, r); return v !== null ? Math.sqrt(v) : null; };
    case 'LENGTH': return (c: any, r: any) => { const v = args[0](c, r); return v !== null ? String(v).length : null; };
    case 'REPLACE': return (c: any, r: any) => {
      const s = args[0](c, r), from = args[1](c, r), to = args[2](c, r);
      if (s === null || from === null || to === null) return null;
      return String(s).split(String(from)).join(String(to));
    };
    default: return () => null;
  }
}

function resolveColumnIndex(expr: any, columnMapping: any): any {
  if (columnMapping) {
    const key = `${expr.tableAlias}.${expr.columnName}`.toUpperCase();
    if (columnMapping.has(key)) return columnMapping.get(key);

    const byName = `${expr.columnName}`.toUpperCase();
    if (columnMapping.has(byName)) return columnMapping.get(byName);
  }
  return expr.columnIndex;
}

function likeToRegex(pattern: any): any {
  let regex = '^';
  for (const ch of pattern) {
    if (ch === '%') regex += '.*';
    else if (ch === '_') regex += '.';
    else if ('.+*?^${}()|[]\\'.includes(ch)) regex += '\\' + ch;
    else regex += ch;
  }
  regex += '$';
  return new RegExp(regex, 'i');
}

function aggExprKey(expr: any): any {
  const name = expr.name?.toUpperCase() || 'AGG';
  const distinctTag = expr.distinct ? '_DISTINCT' : '';
  if (expr.args.length === 0) return `__AGG__${name}${distinctTag}`;
  const argKey = expr.args.map((a: any) => {
    if (a.kind === BoundExprKind.COLUMN_REF) return `${a.tableAlias}.${a.columnName}`.toUpperCase();
    return JSON.stringify(a).slice(0, 30);
  }).join(',');
  return `__AGG__${name}${distinctTag}(${argKey})`;
}

export { aggExprKey };

function windowExprKey(expr: any): any {
  const name = expr.name?.toUpperCase() || 'WIN';
  const argKey = (expr.args || []).map((a: any) => {
    if (a.kind === BoundExprKind.COLUMN_REF) return `${a.tableAlias}.${a.columnName}`.toUpperCase();
    return JSON.stringify(a).slice(0, 30);
  }).join(',');
  const partKey = (expr.partitionBy || []).map((p: any) => {
    if (p.kind === BoundExprKind.COLUMN_REF) return `${p.tableAlias}.${p.columnName}`.toUpperCase();
    return '';
  }).join(',');
  return `__WIN__${name}(${argKey})[${partKey}]`;
}

export { windowExprKey };

function castValue(val: any, targetType: any): any {
  if (val === null) return null;
  switch (targetType) {
    case DataType.INT32: return parseInt(val, 10) | 0;
    case DataType.INT64: return BigInt(parseInt(val, 10));
    case DataType.FLOAT64: return parseFloat(val);
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

export function buildColumnMapping(schemas: any): any {
  const mapping = new Map();
  let idx = 0;
  for (const schema of schemas) {
    for (const col of schema.columns || schema) {
      const alias = schema.alias || schema.tableName || '';
      const key = `${alias}.${col.name}`.toUpperCase();
      mapping.set(key, idx);
      mapping.set(col.name.toUpperCase(), idx);
      idx++;
    }
  }
  return mapping;
}
