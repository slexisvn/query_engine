import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType, LogicalIndexScan, LogicalFilter, type LogicalPlanNode, type LogicalFilterNode, type IndexScanValue } from '../../planner/logical-plan.js';
import { BoundExprKind, type BoundExpr, type LiteralValue } from '../../binder/expression-binder.js';
import { splitConjuncts, combineConjuncts } from './predicate-pushdown.js';
import { Config } from '../../config.js';

interface ColumnStatsLike {
  ndv: number;
  min: IndexScanValue;
  max: IndexScanValue;
}

interface TableStatsLike {
  getColumnStats(column: string): ColumnStatsLike | null;
}

interface StatisticsLike {
  get(name: string): TableStatsLike | undefined;
}

interface CatalogLike {
  getIndexForColumn(table: string, column: string): object | null;
}

interface ColumnBounds {
  point: IndexScanValue;
  low: IndexScanValue;
  high: IndexScanValue;
  lowInc: boolean;
  highInc: boolean;
  conjunctIndices: number[];
}

interface ConjunctMapping {
  idx: number;
  indexed: boolean;
  column?: string;
}

interface ConjunctInfo {
  column: string;
  value: IndexScanValue;
  type: 'eq' | 'gt' | 'gte' | 'lt' | 'lte';
}

export class IndexSelection extends OptimizationPass {
  catalog: CatalogLike;
  statistics: StatisticsLike | null;
  constructor(catalog: CatalogLike, statistics: StatisticsLike | null) {
    super();
    this.catalog = catalog;
    this.statistics = statistics;
  }
  override get name() { return 'IndexSelection'; }
  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new IndexSelectionRewriter(this.catalog, this.statistics);
    return rewriter.rewrite(plan);
  }
}

class IndexSelectionRewriter extends PlanRewriter {
  catalog: CatalogLike;
  statistics: StatisticsLike | null;
  constructor(catalog: CatalogLike, statistics: StatisticsLike | null) {
    super();
    this.catalog = catalog;
    this.statistics = statistics;
  }

  override rewriteFilter(node: LogicalFilterNode): LogicalPlanNode {
    const child = this.rewrite(node.children[0]);
    if (child.type !== PlanNodeType.SCAN) {
      const newNode = { ...node, children: [child] };
      return newNode;
    }

    const tableName = child.table;
    const alias = child.alias || tableName;
    const conjuncts = splitConjuncts(node.condition);

    const columnBounds = new Map<string, ColumnBounds>();
    const conjunctMapping: ConjunctMapping[] = [];

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

    let bestColumn: string | null = null;
    let bestBounds: ColumnBounds | null = null;

    for (const [col, bounds] of columnBounds) {
      const btree = this.catalog.getIndexForColumn(tableName, col);
      if (!btree) continue;

      if (this.statistics) {
        const tableStats = this.statistics.get(tableName.toUpperCase());
        if (tableStats) {
          const colStats = tableStats.getColumnStats(col);
          if (colStats && colStats.ndv > 0) {
            let selectivity: number;
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

    if (!bestColumn || !bestBounds) {
      return { ...node, children: [child] };
    }

    const indexedIndices = new Set(bestBounds.conjunctIndices);
    const residualConjuncts = conjuncts.filter((_: BoundExpr, i: number) => !indexedIndices.has(i));

    let scanType: string, scanKey: IndexScanValue, scanLow: IndexScanValue, scanHigh: IndexScanValue, lowInc: boolean, highInc: boolean;
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

  _estimateRangeSelectivity(colStats: ColumnStatsLike, bounds: ColumnBounds): number {
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

  _analyzeConjunct(expr: BoundExpr, alias: string): ConjunctInfo | null {
    if (expr.kind !== BoundExprKind.BINARY) return null;

    const op = expr.op;
    if (op !== '=' && op !== '>' && op !== '>=' && op !== '<' && op !== '<=') return null;

    let colExpr: BoundExpr;
    let litExpr: BoundExpr;
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

    if (colExpr.kind !== BoundExprKind.COLUMN_REF || litExpr.kind !== BoundExprKind.LITERAL) return null;
    if (colExpr.tableAlias && colExpr.tableAlias.toUpperCase() !== alias.toUpperCase()) return null;

    const column = colExpr.columnName.toUpperCase();
    const value = litExpr.value as IndexScanValue;

    let type: ConjunctInfo['type'];
    if (op === '=') {
      type = 'eq';
    } else if (op === '>') {
      type = flipped ? 'lt' : 'gt';
    } else if (op === '>=') {
      type = flipped ? 'lte' : 'gte';
    } else if (op === '<') {
      type = flipped ? 'gt' : 'lt';
    } else {
      type = flipped ? 'gte' : 'lte';
    }

    return { column, value, type };
  }
}

function toNumber(value: IndexScanValue): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return null;
}
