
import { BoundExprKind } from '../../binder/expression-binder.js';
import { PlanNodeType, JoinType } from '../../planner/logical-plan.js';

const MIN_SELECTIVITY = 0.0001;

export class DefaultCardinalityEstimator {
  constructor(statisticsProvider) {
    this.stats = statisticsProvider;
  }

  estimateScan(tableName) {
    const tableStats = this.stats.get(tableName.toUpperCase());
    return tableStats ? tableStats.rowCount : 1000;
  }

  estimatePlan(node) {
    if (!node) return 1000;

    switch (node.type) {
      case PlanNodeType.SCAN:
        return this.estimateScan(node.table);
      case PlanNodeType.FILTER:
        return this.estimateFilter(this.estimatePlan(node.children[0]), node.condition);
      case PlanNodeType.PROJECT:
      case PlanNodeType.SORT:
      case PlanNodeType.DISTINCT:
      case PlanNodeType.MATERIALIZE:
        return this.estimatePlan(node.children?.[0]);
      case PlanNodeType.LIMIT: {
        const childCard = this.estimatePlan(node.children?.[0]);
        return Math.min(node.count || childCard, childCard);
      }
      case PlanNodeType.JOIN: {
        const leftCard = this.estimatePlan(node.children[0]);
        const rightCard = this.estimatePlan(node.children[1]);
        if (node.joinType === JoinType.SEMI) return this.estimateSemiJoin(leftCard, rightCard, node.condition);
        if (node.joinType === JoinType.ANTI) return this.estimateAntiJoin(leftCard, rightCard, node.condition);
        if (node.joinType === JoinType.MARK) return leftCard;
        if (node.joinType === JoinType.LEFT) return this.estimateLeftJoin(leftCard, rightCard, node.condition);
        if (node.joinType === JoinType.CROSS) return leftCard * rightCard;
        return this.estimateJoin(leftCard, rightCard, node.condition);
      }
      case PlanNodeType.AGGREGATE:
        return this.estimateAggregate(this.estimatePlan(node.children[0]), node.groupBy?.length || 0, node.groupBy);
      case PlanNodeType.EMPTY:
        return 0;
      default:
        return node.children?.length ? this.estimatePlan(node.children[0]) : 1000;
    }
  }


  estimateFilter(inputCard, predicate) {
    const sel = this.estimateSelectivity(predicate);
    return Math.max(1, Math.round(inputCard * sel));
  }


  estimateJoin(leftCard, rightCard, condition) {
    if (!condition) return leftCard * rightCard;

    const equiPreds = this.extractEquiPredicates(condition);
    if (equiPreds.length === 0) {
      const sel = this.estimateSelectivity(condition);
      return Math.max(1, Math.round(leftCard * rightCard * sel));
    }

    let card = leftCard * rightCard;
    let appliedCount = 0;
    for (const pred of equiPreds) {
      const leftNdv = this.getColumnNdv(pred.left);
      const rightNdv = this.getColumnNdv(pred.right);
      const maxNdv = Math.max(leftNdv, rightNdv, 1);

      if (appliedCount === 0) {
        card = card / maxNdv;
      } else {
        card = card / Math.sqrt(maxNdv);
      }
      appliedCount++;
    }

    return Math.max(1, Math.round(card));
  }

  estimateLeftJoin(leftCard, rightCard, condition) {
    const innerCard = this.estimateJoin(leftCard, rightCard, condition);
    return Math.max(leftCard, innerCard);
  }

  estimateSemiJoin(leftCard, rightCard, condition) {
    if (!condition) return Math.round(leftCard * 0.5);
    const equiPreds = this.extractEquiPredicates(condition);
    if (equiPreds.length > 0) {
      let selectivity = 1.0;
      for (const pred of equiPreds) {
        const leftNdv = this.getColumnNdv(pred.left);
        const rightNdv = this.getColumnNdv(pred.right);
        selectivity = Math.min(selectivity, Math.min(1.0, rightNdv / Math.max(leftNdv, 1)));
      }
      return Math.max(1, Math.round(leftCard * selectivity));
    }
    return Math.max(1, Math.round(leftCard * 0.5));
  }

  estimateAntiJoin(leftCard, rightCard, condition) {
    const semiCard = this.estimateSemiJoin(leftCard, rightCard, condition);
    return Math.max(1, leftCard - semiCard);
  }


  estimateAggregate(inputCard, groupByCount, groupByExprs = []) {
    if (groupByCount === 0) return 1;

    let ndvProduct = 1;
    const ndvs = (groupByExprs || []).map(expr => this.getColumnNdv(expr)).sort((a, b) => b - a);

    for (let i = 0; i < ndvs.length; i++) {
      if (i === 0) {
        ndvProduct = ndvs[i];
      } else {
        ndvProduct *= Math.max(1, Math.sqrt(ndvs[i]));
      }
    }

    if (ndvProduct > 1) {
      return Math.max(1, Math.min(inputCard, Math.round(ndvProduct)));
    }
    return Math.min(inputCard, Math.pow(10, groupByCount));
  }


  estimateSelectivity(predicate) {
    if (!predicate) return 1.0;

    switch (predicate.kind) {
      case BoundExprKind.BINARY: {
        if (predicate.op === 'AND') {
          const sl = this.estimateSelectivity(predicate.left);
          const sr = this.estimateSelectivity(predicate.right);
          const independent = sl * sr;
          const correlated = Math.min(sl, sr);
          return Math.max(MIN_SELECTIVITY, Math.min(correlated, independent * 0.7 + correlated * 0.3));
        }
        if (predicate.op === 'OR') {
          const sl = this.estimateSelectivity(predicate.left);
          const sr = this.estimateSelectivity(predicate.right);
          return Math.min(1.0, sl + sr - sl * sr);
        }
        if (predicate.op === '=') return this.estimateEqualitySelectivity(predicate);
        if (['<', '>', '<=', '>='].includes(predicate.op)) return this.estimateRangeSelectivity(predicate);
        if (predicate.op === '<>') {
          const eqSel = this.estimateEqualitySelectivity({ ...predicate, op: '=' });
          return Math.max(MIN_SELECTIVITY, 1.0 - eqSel);
        }
        return 0.5;
      }
      case BoundExprKind.BETWEEN:
        return this.estimateBetweenSelectivity(predicate);
      case BoundExprKind.LIKE:
        return this.estimateLikeSelectivity(predicate);
      case BoundExprKind.IN_LIST:
        return this.estimateInListSelectivity(predicate);
      case BoundExprKind.IS_NULL:
        return this.estimateIsNullSelectivity(predicate);
      case BoundExprKind.UNARY:
        if (predicate.op === 'NOT') return Math.max(MIN_SELECTIVITY, 1.0 - this.estimateSelectivity(predicate.operand));
        return 0.5;
      case BoundExprKind.EXISTS:
        return 0.5;
      default:
        return 0.5;
    }
  }

  estimateEqualitySelectivity(predicate) {
    let column = null, literal = null;
    if (predicate.left?.kind === BoundExprKind.COLUMN_REF && predicate.right?.kind === BoundExprKind.LITERAL) {
      column = predicate.left; literal = predicate.right;
    } else if (predicate.right?.kind === BoundExprKind.COLUMN_REF && predicate.left?.kind === BoundExprKind.LITERAL) {
      column = predicate.right; literal = predicate.left;
    } else if (predicate.left?.kind === BoundExprKind.COLUMN_REF && predicate.right?.kind === BoundExprKind.COLUMN_REF) {
      const leftNdv = this.getColumnNdv(predicate.left);
      const rightNdv = this.getColumnNdv(predicate.right);
      return 1.0 / Math.max(leftNdv, rightNdv, 1);
    } else {
      return 0.1;
    }

    const stats = this.getColumnStats(column);
    if (!stats) {
      return 0.1;
    }

    if (stats.mcv) {
      const litStr = String(literal.value);
      const mcvIdx = stats.mcv.values.indexOf(litStr);
      if (mcvIdx >= 0) {
        return stats.mcv.frequencies[mcvIdx] * (1 - stats.nullFraction);
      }
    }

    const ndv = stats.ndv || 100;
    const nullFrac = stats.nullFraction || 0;
    return Math.max(MIN_SELECTIVITY, (1.0 - nullFrac) / ndv);
  }

  estimateRangeSelectivity(predicate) {
    const column = predicate.left?.kind === BoundExprKind.COLUMN_REF ? predicate.left : predicate.right;
    const literal = predicate.left?.kind === BoundExprKind.LITERAL ? predicate.left : predicate.right;
    if (column?.kind !== BoundExprKind.COLUMN_REF || literal?.kind !== BoundExprKind.LITERAL) {
      return 0.33;
    }

    const stats = this.getColumnStats(column);
    if (!stats) return 0.33;

    if (stats.histogram) {
      const isLessThan = predicate.left === column
        ? ['<', '<='].includes(predicate.op)
        : ['>', '>='].includes(predicate.op);
      const frac = stats.histogram.estimateLessThan(literal.value);
      const sel = isLessThan ? frac : (1.0 - frac);
      return Math.max(MIN_SELECTIVITY, sel * (1 - (stats.nullFraction || 0)));
    }

    const min = toNumber(stats.min);
    const max = toNumber(stats.max);
    const value = toNumber(literal.value);
    if (min === null || max === null || value === null || max <= min) return 0.33;

    const ratio = (value - min) / (max - min);
    const clamped = Math.max(0, Math.min(1, ratio));
    const lessThan = predicate.left === column
      ? ['<', '<='].includes(predicate.op)
      : ['>', '>='].includes(predicate.op);
    return Math.max(MIN_SELECTIVITY, (lessThan ? clamped : 1 - clamped) * (1 - (stats.nullFraction || 0)));
  }

  estimateBetweenSelectivity(predicate) {
    const stats = this.getColumnStats(predicate.expr);
    if (!stats) return 0.25;

    if (stats.histogram && predicate.low?.kind === BoundExprKind.LITERAL && predicate.high?.kind === BoundExprKind.LITERAL) {
      const sel = stats.histogram.estimateRange(predicate.low.value, predicate.high.value);
      const result = predicate.negated ? 1.0 - sel : sel;
      return Math.max(MIN_SELECTIVITY, result * (1 - (stats.nullFraction || 0)));
    }

    const min = toNumber(stats.min);
    const max = toNumber(stats.max);
    const low = toNumber(predicate.low?.value);
    const high = toNumber(predicate.high?.value);
    if (min === null || max === null || low === null || high === null || max <= min) return 0.25;

    const covered = Math.max(0, Math.min(max, high) - Math.max(min, low));
    const sel = covered / (max - min);
    return Math.max(MIN_SELECTIVITY, Math.min(1, predicate.negated ? 1 - sel : sel));
  }

  estimateInListSelectivity(predicate) {
    if (Array.isArray(predicate.list)) {
      const ndv = this.getColumnNdv(predicate.expr);
      const stats = this.getColumnStats(predicate.expr);
      const nullFrac = stats?.nullFraction ?? 0;

      if (stats?.mcv) {
        let mcvHits = 0;
        let mcvFreq = 0;
        for (const item of predicate.list) {
          if (item.kind === BoundExprKind.LITERAL) {
            const idx = stats.mcv.values.indexOf(String(item.value));
            if (idx >= 0) {
              mcvHits++;
              mcvFreq += stats.mcv.frequencies[idx];
            }
          }
        }
        const nonMcvItems = predicate.list.length - mcvHits;
        const nonMcvNdv = Math.max(1, ndv - stats.mcv.values.length);
        const nonMcvFreq = nonMcvItems / nonMcvNdv;
        const totalSel = Math.min(1.0, (mcvFreq + nonMcvFreq) * (1 - nullFrac));
        return predicate.negated ? Math.max(MIN_SELECTIVITY, 1 - totalSel) : Math.max(MIN_SELECTIVITY, totalSel);
      }

      const sel = Math.min(1.0, predicate.list.length / Math.max(ndv, 1)) * (1 - nullFrac);
      return predicate.negated ? Math.max(MIN_SELECTIVITY, 1 - sel) : Math.max(MIN_SELECTIVITY, sel);
    }
    return predicate.negated ? 0.7 : 0.3;
  }

  estimateIsNullSelectivity(predicate) {
    const stats = this.getColumnStats(predicate.expr);
    const nullFrac = stats?.nullFraction || 0.05;
    return predicate.negated ? Math.max(MIN_SELECTIVITY, 1 - nullFrac) : Math.max(MIN_SELECTIVITY, nullFrac);
  }

  estimateLikeSelectivity(predicate) {
    const pattern = predicate.pattern?.value;
    if (typeof pattern !== 'string') return 0.1;

    if (!pattern.includes('%') && !pattern.includes('_')) {
      const ndv = this.getColumnNdv(predicate.expr);
      return ndv > 0 ? 1 / ndv : 0.1;
    }

    if (pattern.endsWith('%') && !pattern.slice(0, -1).includes('%') && !pattern.includes('_')) {
      const prefixLen = pattern.length - 1;
      return Math.max(MIN_SELECTIVITY, 0.1 / Math.max(1, prefixLen / 3));
    }

    if (pattern.startsWith('%') && !pattern.slice(1).includes('%')) {
      return 0.05;
    }

    if (pattern.startsWith('%') && pattern.endsWith('%')) {
      return 0.1;
    }

    return 0.15;
  }


  getColumnNdv(expr) {
    if (expr?.kind !== BoundExprKind.COLUMN_REF) return 100;
    const colStats = this.getColumnStats(expr);
    return colStats?.ndv || 100;
  }

  getColumnStats(expr) {
    if (!expr) return null;
    if (expr.kind !== BoundExprKind.COLUMN_REF) return null;

    const columnName = expr.columnName?.toUpperCase();
    const tableStats = this.stats.get(expr.tableAlias?.toUpperCase());
    if (tableStats?.columnStats?.has(columnName)) {
      return tableStats.columnStats.get(columnName);
    }

    for (const stats of this.stats.values()) {
      if (stats.columnStats?.has(columnName)) {
        return stats.columnStats.get(columnName);
      }
    }
    return null;
  }


  extractEquiPredicates(condition) {
    const result = [];
    this._collectEqui(condition, result);
    return result;
  }

  _collectEqui(expr, result) {
    if (!expr) return;
    if (expr.kind === BoundExprKind.BINARY && expr.op === 'AND') {
      this._collectEqui(expr.left, result);
      this._collectEqui(expr.right, result);
      return;
    }
    if (expr.kind === BoundExprKind.BINARY && expr.op === '='
        && expr.left?.kind === BoundExprKind.COLUMN_REF
        && expr.right?.kind === BoundExprKind.COLUMN_REF) {
      result.push({ left: expr.left, right: expr.right });
    }
  }
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return null;
}
