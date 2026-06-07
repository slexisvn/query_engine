import { BoundExprKind } from '../binder/expression-binder.js';
import { DataType, epochDaysToDate, dateToEpochDays, epochMsToTimestamp } from '../storage/data-type.js';

const LIKE_CACHE_MAX = 256;

export function compileExpression(expr, columnMapping) {
  if (!expr) return () => null;

  switch (expr.kind) {
    case BoundExprKind.COLUMN_REF: {
      const colIdx = resolveColumnIndex(expr, columnMapping);
      return (chunk, rowIdx) => chunk.columns[colIdx]?.get(rowIdx) ?? null;
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
      if (expr.op === '-') return (c, r) => -operand(c, r);
      if (expr.op === 'NOT') return (c, r) => !operand(c, r);
      return operand;
    }

    case BoundExprKind.BETWEEN: {
      const e = compileExpression(expr.expr, columnMapping);
      const lo = compileExpression(expr.low, columnMapping);
      const hi = compileExpression(expr.high, columnMapping);
      if (expr.negated) return (c, r) => { const v = e(c, r); return v < lo(c, r) || v > hi(c, r); };
      return (c, r) => { const v = e(c, r); return v >= lo(c, r) && v <= hi(c, r); };
    }

    case BoundExprKind.IN_LIST: {
      const e = compileExpression(expr.expr, columnMapping);
      if (Array.isArray(expr.list)) {
        if (expr.list.every(i => i.kind === BoundExprKind.LITERAL)) {
          const values = new Set(expr.list.map(i => normalizeComparable(i.value)));
          if (expr.negated) return (c, r) => !values.has(normalizeComparable(e(c, r)));
          return (c, r) => values.has(normalizeComparable(e(c, r)));
        }
        const items = expr.list.map(i => compileExpression(i, columnMapping));
        if (expr.negated) return (c, r) => { const v = e(c, r); return !items.some(i => i(c, r) == v); };
        return (c, r) => { const v = e(c, r); return items.some(i => i(c, r) == v); };
      }
      return () => true;
    }

    case BoundExprKind.LIKE: {
      const e = compileExpression(expr.expr, columnMapping);
      const p = compileExpression(expr.pattern, columnMapping);
      const regexCache = new Map();
      const regexKeys = [];
      return (c, r) => {
        const val = e(c, r);
        const pattern = p(c, r);
        if (val === null || pattern === null) return false;
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
      if (expr.negated) return (c, r) => e(c, r) !== null && e(c, r) !== undefined;
      return (c, r) => e(c, r) === null || e(c, r) === undefined;
    }

    case BoundExprKind.CASE: {
      const whenClauses = expr.whenClauses.map(wc => ({
        cond: compileExpression(wc.condition, columnMapping),
        result: compileExpression(wc.result, columnMapping),
      }));
      const elseExpr = expr.elseExpr ? compileExpression(expr.elseExpr, columnMapping) : () => null;
      return (c, r) => {
        for (const wc of whenClauses) {
          if (wc.cond(c, r)) return wc.result(c, r);
        }
        return elseExpr(c, r);
      };
    }

    case BoundExprKind.CAST: {
      const e = compileExpression(expr.expr, columnMapping);
      return (c, r) => castValue(e(c, r), expr.targetType);
    }

    case BoundExprKind.EXTRACT: {
      const source = compileExpression(expr.source, columnMapping);
      const srcType = expr.source?.dataType || expr.source?.resultType;
      return (c, r) => {
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
      const args = expr.args.map(a => compileExpression(a, columnMapping));
      return compileFunction(expr.name, args);
    }

    case BoundExprKind.AGGREGATE: {
      const aggKey = aggExprKey(expr);
      if (columnMapping && columnMapping.has(aggKey)) {
        const colIdx = columnMapping.get(aggKey);
        return (chunk, rowIdx) => chunk.columns[colIdx]?.get(rowIdx) ?? null;
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
        return (chunk, rowIdx) => chunk.columns[colIdx]?.get(rowIdx) ?? null;
      }
      return () => null;
    }

    default:
      return () => null;
  }
}

function addInterval(epochDays, amount, unit) {
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

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function toNum(val) {
  return typeof val === 'bigint' ? Number(val) : val;
}

function normalizeComparable(val) {
  return typeof val === 'bigint' ? Number(val) : val;
}

function numOp(a, b, fn) {
  return fn(toNum(a), toNum(b));
}

function compileBinaryOp(op, left, right) {
  switch (op) {
    case '=': return (c, r) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null && toNum(l) == toNum(rv); };
    case '<>': return (c, r) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null && toNum(l) != toNum(rv); };
    case '<': return (c, r) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null && toNum(l) < toNum(rv); };
    case '>': return (c, r) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null && toNum(l) > toNum(rv); };
    case '<=': return (c, r) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null && toNum(l) <= toNum(rv); };
    case '>=': return (c, r) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null && toNum(l) >= toNum(rv); };
    case 'AND': return (c, r) => left(c, r) && right(c, r);
    case 'OR': return (c, r) => left(c, r) || right(c, r);
    case '+': return (c, r) => {
      const l = left(c, r), rv = right(c, r);
      if (l === null || rv === null) return null;
      if (rv?._isInterval) return addInterval(toNum(l), rv.value, rv.unit);
      if (l?._isInterval) return addInterval(toNum(rv), l.value, l.unit);
      return numOp(l, rv, (a, b) => a + b);
    };
    case '-': return (c, r) => {
      const l = left(c, r), rv = right(c, r);
      if (l === null || rv === null) return null;
      if (rv?._isInterval) return addInterval(toNum(l), -rv.value, rv.unit);
      return numOp(l, rv, (a, b) => a - b);
    };
    case '*': return (c, r) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null ? numOp(l, rv, (a, b) => a * b) : null; };
    case '/': return (c, r) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null && rv !== 0 ? numOp(l, rv, (a, b) => a / b) : null; };
    case '%': return (c, r) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null ? numOp(l, rv, (a, b) => a % b) : null; };
    case '||': return (c, r) => { const l = left(c, r), rv = right(c, r); return l !== null && rv !== null ? String(l) + String(rv) : null; };
    default: return () => null;
  }
}

function compileFunction(name, args) {
  switch (name.toUpperCase()) {
    case 'SUBSTRING': {
      const [str, from, len] = args;
      return (c, r) => {
        const s = str(c, r);
        if (s === null) return null;
        const start = from(c, r) - 1;
        if (len) return String(s).substring(start, start + len(c, r));
        return String(s).substring(start);
      };
    }
    case 'TRIM': return (c, r) => { const v = args[0](c, r); return v !== null ? String(v).trim() : null; };
    case 'UPPER': return (c, r) => { const v = args[0](c, r); return v !== null ? String(v).toUpperCase() : null; };
    case 'LOWER': return (c, r) => { const v = args[0](c, r); return v !== null ? String(v).toLowerCase() : null; };
    case 'ABS': return (c, r) => { const v = args[0](c, r); return v !== null ? Math.abs(v) : null; };
    case 'ROUND': return (c, r) => {
      const v = args[0](c, r);
      const d = args[1] ? args[1](c, r) : 0;
      if (v === null) return null;
      const factor = Math.pow(10, d);
      return Math.round(v * factor) / factor;
    };
    case 'COALESCE': return (c, r) => {
      for (const a of args) {
        const v = a(c, r);
        if (v !== null && v !== undefined) return v;
      }
      return null;
    };
    case 'NULLIF': return (c, r) => {
      const v1 = args[0](c, r), v2 = args[1](c, r);
      return v1 == v2 ? null : v1;
    };
    case 'SQRT': return (c, r) => { const v = args[0](c, r); return v !== null ? Math.sqrt(v) : null; };
    case 'LENGTH': return (c, r) => { const v = args[0](c, r); return v !== null ? String(v).length : null; };
    case 'REPLACE': return (c, r) => {
      const s = args[0](c, r), from = args[1](c, r), to = args[2](c, r);
      if (s === null || from === null || to === null) return null;
      return String(s).split(String(from)).join(String(to));
    };
    default: return () => null;
  }
}

function resolveColumnIndex(expr, columnMapping) {
  if (columnMapping) {
    const key = `${expr.tableAlias}.${expr.columnName}`.toUpperCase();
    if (columnMapping.has(key)) return columnMapping.get(key);

    const byName = `${expr.columnName}`.toUpperCase();
    if (columnMapping.has(byName)) return columnMapping.get(byName);
  }
  return expr.columnIndex;
}

function likeToRegex(pattern) {
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

function aggExprKey(expr) {
  const name = expr.name?.toUpperCase() || 'AGG';
  const distinctTag = expr.distinct ? '_DISTINCT' : '';
  if (expr.args.length === 0) return `__AGG__${name}${distinctTag}`;
  const argKey = expr.args.map(a => {
    if (a.kind === BoundExprKind.COLUMN_REF) return `${a.tableAlias}.${a.columnName}`.toUpperCase();
    return JSON.stringify(a).slice(0, 30);
  }).join(',');
  return `__AGG__${name}${distinctTag}(${argKey})`;
}

export { aggExprKey };

function windowExprKey(expr) {
  const name = expr.name?.toUpperCase() || 'WIN';
  const argKey = (expr.args || []).map(a => {
    if (a.kind === BoundExprKind.COLUMN_REF) return `${a.tableAlias}.${a.columnName}`.toUpperCase();
    return JSON.stringify(a).slice(0, 30);
  }).join(',');
  const partKey = (expr.partitionBy || []).map(p => {
    if (p.kind === BoundExprKind.COLUMN_REF) return `${p.tableAlias}.${p.columnName}`.toUpperCase();
    return '';
  }).join(',');
  return `__WIN__${name}(${argKey})[${partKey}]`;
}

export { windowExprKey };

function castValue(val, targetType) {
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

export function buildColumnMapping(schemas) {
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
