import { BoundExprKind } from '../binder/expression-binder.js';
import type {
  BoundBetweenNode,
  BoundBinaryNode,
  BoundColumnRefNode,
  BoundExpr,
  BoundInListNode,
  BoundIsNullNode,
  BoundLikeNode,
  BoundLiteralNode,
  BoundUnaryNode,
  LiteralValue,
} from '../binder/expression-binder.js';
import type { ChunkPruner, ChunkZoneMap, ColumnZoneMap, OrderedValue, ValueRange } from '../storage/zone-map.js';
import { UNRESOLVED_COLUMN } from './column-resolve.js';

const IS_TRUE = 1;
const IS_FALSE = 2;
const IS_UNKNOWN = 4;
const ANY_TRUTH = IS_TRUE | IS_FALSE | IS_UNKNOWN;
const NO_TRUTH = 0;

const MAX_CODE_UNIT = 0xffff;

type TruthSet = number;

type Comparable = number | string | boolean;

export type ColumnResolver = (ref: BoundColumnRefNode) => number;

type ZoneEvaluator = (zoneMap: ChunkZoneMap) => TruthSet;

type ExprCompilers = {
  [K in BoundExprKind]?: (expr: Extract<BoundExpr, { kind: K }>, resolve: ColumnResolver) => ZoneEvaluator;
};

interface RangeRule {
  possiblyTrue(minToLiteral: number, maxToLiteral: number): boolean;
  possiblyFalse(minToLiteral: number, maxToLiteral: number): boolean;
}

const anyTruth: ZoneEvaluator = () => ANY_TRUTH;

function comparableOf(value: OrderedValue): Comparable {
  return typeof value === 'bigint' ? Number(value) : value;
}

function literalComparable(value: LiteralValue | null): Comparable | null {
  return value === null || value === undefined ? null : comparableOf(value);
}

function rangeComparable(range: ValueRange): { min: Comparable; max: Comparable } {
  return { min: comparableOf(range.min), max: comparableOf(range.max) };
}

function compareComparable(left: Comparable, right: Comparable): number {
  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return left === right ? 0 : (left ? 1 : -1);
  }
  return NaN;
}

function truthOf(possiblyTrue: boolean, possiblyFalse: boolean, possiblyUnknown: boolean): TruthSet {
  return (possiblyTrue ? IS_TRUE : 0) | (possiblyFalse ? IS_FALSE : 0) | (possiblyUnknown ? IS_UNKNOWN : 0);
}

function kleeneNot(operand: TruthSet): TruthSet {
  return truthOf((operand & IS_FALSE) !== 0, (operand & IS_TRUE) !== 0, (operand & IS_UNKNOWN) !== 0);
}

function kleeneAnd(left: TruthSet, right: TruthSet): TruthSet {
  const unknown = ((left & IS_UNKNOWN) !== 0 && (right & (IS_TRUE | IS_UNKNOWN)) !== 0)
    || ((right & IS_UNKNOWN) !== 0 && (left & (IS_TRUE | IS_UNKNOWN)) !== 0);
  return truthOf(
    (left & IS_TRUE) !== 0 && (right & IS_TRUE) !== 0,
    (left & IS_FALSE) !== 0 || (right & IS_FALSE) !== 0,
    unknown,
  );
}

function kleeneOr(left: TruthSet, right: TruthSet): TruthSet {
  const unknown = ((left & IS_UNKNOWN) !== 0 && (right & (IS_FALSE | IS_UNKNOWN)) !== 0)
    || ((right & IS_UNKNOWN) !== 0 && (left & (IS_FALSE | IS_UNKNOWN)) !== 0);
  return truthOf(
    (left & IS_TRUE) !== 0 || (right & IS_TRUE) !== 0,
    (left & IS_FALSE) !== 0 && (right & IS_FALSE) !== 0,
    unknown,
  );
}

const RANGE_RULES: Record<string, RangeRule> = {
  '=': {
    possiblyTrue: (lo, hi) => lo <= 0 && hi >= 0,
    possiblyFalse: (lo, hi) => !(lo === 0 && hi === 0),
  },
  '<>': {
    possiblyTrue: (lo, hi) => !(lo === 0 && hi === 0),
    possiblyFalse: (lo, hi) => lo <= 0 && hi >= 0,
  },
  '<': {
    possiblyTrue: (lo) => lo < 0,
    possiblyFalse: (_lo, hi) => hi >= 0,
  },
  '<=': {
    possiblyTrue: (lo) => lo <= 0,
    possiblyFalse: (_lo, hi) => hi > 0,
  },
  '>': {
    possiblyTrue: (_lo, hi) => hi > 0,
    possiblyFalse: (lo) => lo <= 0,
  },
  '>=': {
    possiblyTrue: (_lo, hi) => hi >= 0,
    possiblyFalse: (lo) => lo < 0,
  },
};

const FLIPPED_OPS: Record<string, string> = {
  '=': '=',
  '<>': '<>',
  '<': '>',
  '<=': '>=',
  '>': '<',
  '>=': '<=',
};

const LOGICAL_COMBINERS: Record<string, (left: TruthSet, right: TruthSet) => TruthSet> = {
  AND: kleeneAnd,
  OR: kleeneOr,
};

function columnZoneOf(zoneMap: ChunkZoneMap, columnIndex: number): ColumnZoneMap | null {
  return zoneMap.columns[columnIndex] ?? null;
}

function nullOnlyTruth(zone: ColumnZoneMap): TruthSet {
  return zone.hasNulls ? IS_UNKNOWN : NO_TRUTH;
}

function literalValueOf(expr: BoundExpr): LiteralValue | null {
  return expr.kind === BoundExprKind.LITERAL ? (expr as BoundLiteralNode).value : null;
}

function columnIndexOf(expr: BoundExpr, resolve: ColumnResolver): number {
  return expr.kind === BoundExprKind.COLUMN_REF ? resolve(expr as BoundColumnRefNode) : UNRESOLVED_COLUMN;
}

function compareEvaluator(columnIndex: number, literal: Comparable, rule: RangeRule): ZoneEvaluator {
  return (zoneMap) => {
    const zone = columnZoneOf(zoneMap, columnIndex);
    if (!zone) return ANY_TRUTH;
    if (!zone.range) return nullOnlyTruth(zone);

    const bounds = rangeComparable(zone.range);
    const lo = compareComparable(bounds.min, literal);
    const hi = compareComparable(bounds.max, literal);
    if (Number.isNaN(lo) || Number.isNaN(hi)) return ANY_TRUTH;

    return truthOf(rule.possiblyTrue(lo, hi), rule.possiblyFalse(lo, hi), zone.hasNulls);
  };
}

function compileComparison(op: string, left: BoundExpr, right: BoundExpr, resolve: ColumnResolver): ZoneEvaluator {
  let columnIndex = columnIndexOf(left, resolve);
  let literal = literalValueOf(right);
  let effectiveOp = op;

  if (columnIndex === UNRESOLVED_COLUMN || literal === null) {
    columnIndex = columnIndexOf(right, resolve);
    literal = literalValueOf(left);
    effectiveOp = FLIPPED_OPS[op] ?? op;
  }

  const rule = RANGE_RULES[effectiveOp];
  const comparable = literalComparable(literal);
  if (columnIndex === UNRESOLVED_COLUMN || comparable === null || !rule) return anyTruth;

  return compareEvaluator(columnIndex, comparable, rule);
}

function compileBinary(expr: BoundBinaryNode, resolve: ColumnResolver): ZoneEvaluator {
  const combiner = LOGICAL_COMBINERS[expr.op.toUpperCase()];
  if (!combiner) return compileComparison(expr.op, expr.left, expr.right, resolve);

  const left = compileZoneEvaluator(expr.left, resolve);
  const right = compileZoneEvaluator(expr.right, resolve);
  if (left === anyTruth && right === anyTruth) return anyTruth;
  return (zoneMap) => combiner(left(zoneMap), right(zoneMap));
}

function compileUnary(expr: BoundUnaryNode, resolve: ColumnResolver): ZoneEvaluator {
  if (expr.op?.toUpperCase() !== 'NOT') return anyTruth;
  const operand = compileZoneEvaluator(expr.operand, resolve);
  if (operand === anyTruth) return anyTruth;
  return (zoneMap) => kleeneNot(operand(zoneMap));
}

function compileBetween(expr: BoundBetweenNode, resolve: ColumnResolver): ZoneEvaluator {
  const lower = compileComparison('>=', expr.expr, expr.low, resolve);
  const upper = compileComparison('<=', expr.expr, expr.high, resolve);
  if (lower === anyTruth && upper === anyTruth) return anyTruth;

  const inclusive: ZoneEvaluator = (zoneMap) => kleeneAnd(lower(zoneMap), upper(zoneMap));
  return expr.negated ? (zoneMap) => kleeneNot(inclusive(zoneMap)) : inclusive;
}

function compileIsNull(expr: BoundIsNullNode, resolve: ColumnResolver): ZoneEvaluator {
  const columnIndex = columnIndexOf(expr.expr, resolve);
  if (columnIndex === UNRESOLVED_COLUMN) return anyTruth;

  const negated = expr.negated;
  return (zoneMap) => {
    const zone = columnZoneOf(zoneMap, columnIndex);
    if (!zone) return ANY_TRUTH;
    const hasValues = zone.range !== null;
    return negated
      ? truthOf(hasValues, zone.hasNulls, false)
      : truthOf(zone.hasNulls, hasValues, false);
  };
}

function compileInList(expr: BoundInListNode, resolve: ColumnResolver): ZoneEvaluator {
  const columnIndex = columnIndexOf(expr.expr, resolve);
  if (columnIndex === UNRESOLVED_COLUMN || !Array.isArray(expr.list)) return anyTruth;
  if (!expr.list.every((item) => item.kind === BoundExprKind.LITERAL)) return anyTruth;

  const rawValues = expr.list.map((item) => (item as BoundLiteralNode).value);
  const listHasNull = rawValues.some((value) => value === null || value === undefined);
  const values: Comparable[] = [];
  for (const raw of rawValues) {
    const comparable = literalComparable(raw);
    if (comparable !== null) values.push(comparable);
  }

  const negated = expr.negated;
  return (zoneMap) => {
    const zone = columnZoneOf(zoneMap, columnIndex);
    if (!zone) return ANY_TRUTH;
    if (!zone.range) return negated ? kleeneNot(nullOnlyTruth(zone)) : nullOnlyTruth(zone);

    const bounds = rangeComparable(zone.range);
    const singleton = compareComparable(bounds.min, bounds.max) === 0;
    let matchesRange = false;
    let coversRange = false;
    for (const value of values) {
      const lo = compareComparable(bounds.min, value);
      const hi = compareComparable(bounds.max, value);
      if (Number.isNaN(lo) || Number.isNaN(hi)) return ANY_TRUTH;
      if (lo <= 0 && hi >= 0) matchesRange = true;
      if (singleton && lo === 0) coversRange = true;
    }

    const truth = truthOf(
      matchesRange,
      !listHasNull && !coversRange,
      zone.hasNulls || (listHasNull && !coversRange),
    );
    return negated ? kleeneNot(truth) : truth;
  };
}

function literalPrefixOf(pattern: string): string | null {
  let end = 0;
  while (end < pattern.length && pattern[end] !== '%' && pattern[end] !== '_') end++;
  if (end === 0) return null;
  const prefix = pattern.slice(0, end);
  return prefix.charCodeAt(prefix.length - 1) >= MAX_CODE_UNIT ? null : prefix;
}

function nextPrefix(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

function compileLike(expr: BoundLikeNode, resolve: ColumnResolver): ZoneEvaluator {
  const columnIndex = columnIndexOf(expr.expr, resolve);
  const pattern = literalValueOf(expr.pattern);
  if (columnIndex === UNRESOLVED_COLUMN || typeof pattern !== 'string') return anyTruth;

  const prefix = literalPrefixOf(pattern);
  if (prefix === null) return anyTruth;
  const upperBound = nextPrefix(prefix);

  const negated = expr.negated;
  return (zoneMap) => {
    const zone = columnZoneOf(zoneMap, columnIndex);
    if (!zone) return ANY_TRUTH;
    if (!zone.range) return negated ? kleeneNot(nullOnlyTruth(zone)) : nullOnlyTruth(zone);

    const bounds = rangeComparable(zone.range);
    if (typeof bounds.min !== 'string' || typeof bounds.max !== 'string') return ANY_TRUTH;

    const matchesRange = bounds.max >= prefix && bounds.min < upperBound;
    const truth = truthOf(matchesRange, true, zone.hasNulls);
    return negated ? kleeneNot(truth) : truth;
  };
}

const EXPR_COMPILERS: ExprCompilers = {
  [BoundExprKind.BINARY]: compileBinary,
  [BoundExprKind.UNARY]: compileUnary,
  [BoundExprKind.BETWEEN]: compileBetween,
  [BoundExprKind.IS_NULL]: compileIsNull,
  [BoundExprKind.IN_LIST]: compileInList,
  [BoundExprKind.LIKE]: compileLike,
};

function compileZoneEvaluator(expr: BoundExpr, resolve: ColumnResolver): ZoneEvaluator {
  const compiler = EXPR_COMPILERS[expr.kind] as ((e: BoundExpr, r: ColumnResolver) => ZoneEvaluator) | undefined;
  return compiler ? compiler(expr, resolve) : anyTruth;
}

export function schemaColumnResolver(schema: ReadonlyArray<{ name: string }>, alias: string): ColumnResolver {
  const scanAlias = alias.toUpperCase();
  const indexByName = new Map<string, number>();
  for (let i = 0; i < schema.length; i++) {
    const key = schema[i].name.toUpperCase();
    if (!indexByName.has(key)) indexByName.set(key, i);
  }

  return (ref) => {
    if (ref.depth !== 0 || ref.isCorrelated) return UNRESOLVED_COLUMN;
    if (ref.tableAlias && ref.tableAlias.toUpperCase() !== scanAlias) return UNRESOLVED_COLUMN;
    return indexByName.get(ref.columnName.toUpperCase()) ?? UNRESOLVED_COLUMN;
  };
}

export function compileChunkPruner(predicate: BoundExpr | null, resolve: ColumnResolver): ChunkPruner | null {
  if (!predicate) return null;
  const evaluate = compileZoneEvaluator(predicate, resolve);
  if (evaluate === anyTruth) return null;
  return { canSkip: (zoneMap) => zoneMap.rowCount === 0 || (evaluate(zoneMap) & IS_TRUE) === 0 };
}
