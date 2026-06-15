import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType, LogicalIndexScan, LogicalFilter, type LogicalPlanNode } from '../../planner/logical-plan.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import { splitConjuncts, combineConjuncts } from './predicate-pushdown.js';
import { Config } from '../../config.js';

export class IndexSelection extends OptimizationPass {
  catalog: any;
  statistics: any;
  constructor(catalog: any, statistics: any) {
    super();
    this.catalog = catalog;
    this.statistics = statistics;
  }
  get name() { return 'IndexSelection'; }
  apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new IndexSelectionRewriter(this.catalog, this.statistics);
    return rewriter.rewrite(plan);
  }
}

class IndexSelectionRewriter extends PlanRewriter {
  catalog: any;
  statistics: any;
  constructor(catalog: any, statistics: any) {
    super();
    this.catalog = catalog;
    this.statistics = statistics;
  }

  rewriteFilter(node: any): any {
    const child: any = this.rewrite(node.children[0]);
    if (child.type !== PlanNodeType.SCAN) {
      const newNode = { ...node, children: [child] };
      return newNode;
    }

    const tableName = child.table;
    const alias = child.alias || tableName;
    const conjuncts = splitConjuncts(node.condition);

    const columnBounds = new Map<string, any>();
    const conjunctMapping: any[] = [];

    for (let i = 0; i < conjuncts.length; i++) {
      const info = this._analyzeConjunct(conjuncts[i], alias);
      if (!info) {
        conjunctMapping.push({ idx: i, indexed: false });
        continue;
      }
      conjunctMapping.push({ idx: i, indexed: true, column: info.column });
      if (!columnBounds.has(info.column)) {
        columnBounds.set(info.column, { point: null, low: null, high: null, lowInc: false, highInc: false, conjunctIndices: [] });
      }
      const bounds = columnBounds.get(info.column)!;
      bounds.conjunctIndices.push(i);
      if (info.type === 'eq') {
        bounds.point = info.value;
      } else if (info.type === 'gt' || info.type === 'gte') {
        bounds.low = info.value;
        bounds.lowInc = info.type === 'gte';
      } else if (info.type === 'lt' || info.type === 'lte') {
        bounds.high = info.value;
        bounds.highInc = info.type === 'lte';
      }
    }

    let bestColumn: any = null;
    let bestBounds: any = null;

    for (const [col, bounds] of columnBounds) {
      const btree = this.catalog.getIndexForColumn(tableName, col);
      if (!btree) continue;

      if (this.statistics) {
        const tableStats = this.statistics.get(tableName.toUpperCase());
        if (tableStats) {
          const colStats = tableStats.getColumnStats(col);
          if (colStats && colStats.ndv > 0) {
            let selectivity: any;
            if (bounds.point !== null) {
              selectivity = 1 / colStats.ndv;
            } else {
              selectivity = this._estimateRangeSelectivity(colStats, bounds);
            }
            if (selectivity > Config.indexScanSelectivityThreshold) continue;
          }
        }
      }

      bestColumn = col;
      bestBounds = bounds;
      break;
    }

    if (!bestColumn) {
      return { ...node, children: [child] };
    }

    const indexedIndices = new Set(bestBounds.conjunctIndices);
    const residualConjuncts = conjuncts.filter((_: any, i: number) => !indexedIndices.has(i));

    let scanType: any, scanKey: any, scanLow: any, scanHigh: any, lowInc: any, highInc: any;
    const indexName = `idx_${tableName}_${bestColumn}`.toUpperCase();

    if (bestBounds.point !== null) {
      scanType = 'point';
      scanKey = bestBounds.point;
      scanLow = null;
      scanHigh = null;
      lowInc = true;
      highInc = true;
    } else {
      scanType = 'range';
      scanKey = null;
      scanLow = bestBounds.low;
      scanHigh = bestBounds.high;
      lowInc = bestBounds.lowInc;
      highInc = bestBounds.highInc;
    }

    const indexScan = LogicalIndexScan(
      tableName, alias, indexName, bestColumn,
      scanType, scanKey, scanLow, scanHigh, lowInc, highInc,
      child.columns
    );

    if (residualConjuncts.length > 0) {
      return LogicalFilter(combineConjuncts(residualConjuncts), indexScan);
    }
    return indexScan;
  }

  _estimateRangeSelectivity(colStats: any, bounds: any): number {
    const min = toNumber(colStats.min);
    const max = toNumber(colStats.max);
    if (min === null || max === null || max <= min) return 0.33;

    let low = bounds.low !== null ? toNumber(bounds.low) : min;
    let high = bounds.high !== null ? toNumber(bounds.high) : max;
    if (low === null) low = min;
    if (high === null) high = max;

    const covered = Math.max(0, Math.min(max, high) - Math.max(min, low));
    return Math.max(0.0001, covered / (max - min));
  }

  _analyzeConjunct(expr: any, alias: any): any {
    if (expr.kind !== BoundExprKind.BINARY) return null;

    const op = expr.op;
    if (op !== '=' && op !== '>' && op !== '>=' && op !== '<' && op !== '<=') return null;

    let colExpr: any = null;
    let litExpr: any = null;
    let flipped = false;

    if (expr.left.kind === BoundExprKind.COLUMN_REF && expr.right.kind === BoundExprKind.LITERAL) {
      colExpr = expr.left;
      litExpr = expr.right;
    } else if (expr.right.kind === BoundExprKind.COLUMN_REF && expr.left.kind === BoundExprKind.LITERAL) {
      colExpr = expr.right;
      litExpr = expr.left;
      flipped = true;
    } else {
      return null;
    }

    if (colExpr.tableAlias && colExpr.tableAlias.toUpperCase() !== alias.toUpperCase()) return null;

    const column = colExpr.columnName.toUpperCase();
    const value = litExpr.value;

    let type: any;
    if (op === '=') {
      type = 'eq';
    } else if (op === '>') {
      type = flipped ? 'lt' : 'gt';
    } else if (op === '>=') {
      type = flipped ? 'lte' : 'gte';
    } else if (op === '<') {
      type = flipped ? 'gt' : 'lt';
    } else if (op === '<=') {
      type = flipped ? 'gte' : 'lte';
    }

    return { column, value, type };
  }
}

function toNumber(value: any): any {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return null;
}
