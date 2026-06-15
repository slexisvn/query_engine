import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, LogicalAggregate, type LogicalPlanNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

const DECOMPOSABLE_FUNCTIONS = new Map<string, { partial: string; final: string }>([
  ['SUM', { partial: 'SUM', final: 'SUM' }],
  ['COUNT', { partial: 'COUNT', final: 'SUM' }],
  ['MIN', { partial: 'MIN', final: 'MIN' }],
  ['MAX', { partial: 'MAX', final: 'MAX' }],
]);

export class AggregatePushdown extends OptimizationPass {
  get name() { return 'AggregatePushdown'; }

  apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new AggregatePushdownRewriter();
    return rewriter.rewrite(plan);
  }
}

class AggregatePushdownRewriter extends PlanRewriter {
  rewriteAggregate(node: any): any {
    const rewritten: any = this.rewriteChildren(node);
    const child = rewritten.children[0];

    if (child.type !== PlanNodeType.JOIN || child.joinType !== JoinType.INNER) return rewritten;
    if (!rewritten.groupBy || rewritten.groupBy.length === 0) return rewritten;
    if (!rewritten.aggregates || rewritten.aggregates.length === 0) return rewritten;

    if (!this.allAggregatesDecomposable(rewritten.aggregates)) return rewritten;

    const leftRefs = this.collectPlanTableRefs(child.children[0]);
    const rightRefs = this.collectPlanTableRefs(child.children[1]);

    const groupBySide = this.classifyColumns(rewritten.groupBy, leftRefs, rightRefs);
    if (groupBySide === 'both' || groupBySide === 'none') return rewritten;

    const aggColumnSide = this.classifyAggInputs(rewritten.aggregates, leftRefs, rightRefs);
    if (aggColumnSide === 'both') return rewritten;
    if (aggColumnSide !== groupBySide && aggColumnSide !== 'none') return rewritten;

    const pushSide = groupBySide;
    const pushChildIdx = pushSide === 'left' ? 0 : 1;

    const partialAggregates = this.buildPartialAggregates(rewritten.aggregates);
    const partialAgg = LogicalAggregate(
      [...rewritten.groupBy],
      partialAggregates,
      child.children[pushChildIdx]
    );

    const newJoinChildren = [...child.children];
    newJoinChildren[pushChildIdx] = partialAgg;
    const newJoin = { ...child, children: newJoinChildren };

    const finalAggregates = this.buildFinalAggregates(rewritten.aggregates, partialAggregates);
    return LogicalAggregate(rewritten.groupBy, finalAggregates, newJoin);
  }

  allAggregatesDecomposable(aggregates: any[]): boolean {
    return aggregates.every(agg => {
      if (agg.distinct) return false;
      const funcName = (agg.func || agg.functionName || '').toUpperCase();
      return DECOMPOSABLE_FUNCTIONS.has(funcName);
    });
  }

  buildPartialAggregates(aggregates: any[]): any[] {
    return aggregates.map((agg, idx) => {
      const funcName = (agg.func || agg.functionName || '').toUpperCase();
      const rule = DECOMPOSABLE_FUNCTIONS.get(funcName)!;
      return {
        ...agg,
        func: rule.partial,
        functionName: rule.partial,
        outputName: agg.outputName || `_partial_${idx}`,
        _isPartial: true,
      };
    });
  }

  buildFinalAggregates(originalAggs: any[], partialAggs: any[]): any[] {
    return originalAggs.map((agg, idx) => {
      const funcName = (agg.func || agg.functionName || '').toUpperCase();
      const rule = DECOMPOSABLE_FUNCTIONS.get(funcName)!;
      const partialRef = {
        kind: BoundExprKind.COLUMN_REF,
        columnName: partialAggs[idx].outputName,
        tableAlias: null,
      };
      return {
        ...agg,
        func: rule.final,
        functionName: rule.final,
        args: [partialRef],
        _isFinal: true,
      };
    });
  }

  classifyColumns(columns: any[], leftRefs: Set<string>, rightRefs: Set<string>): string {
    let hasLeft = false, hasRight = false;
    for (const col of columns) {
      if (col.kind !== BoundExprKind.COLUMN_REF) return 'both';
      const table = (col.tableAlias || '').toUpperCase();
      if (leftRefs.has(table)) hasLeft = true;
      else if (rightRefs.has(table)) hasRight = true;
      else return 'none';
    }
    if (hasLeft && hasRight) return 'both';
    if (hasLeft) return 'left';
    if (hasRight) return 'right';
    return 'none';
  }

  classifyAggInputs(aggregates: any[], leftRefs: Set<string>, rightRefs: Set<string>): string {
    let hasLeft = false, hasRight = false;
    for (const agg of aggregates) {
      const funcName = (agg.func || agg.functionName || '').toUpperCase();
      if (funcName === 'COUNT' && (!agg.args || agg.args.length === 0 || this.isCountStar(agg))) continue;
      for (const arg of agg.args || []) {
        this.walkExprRefs(arg, (table: string) => {
          if (leftRefs.has(table)) hasLeft = true;
          else if (rightRefs.has(table)) hasRight = true;
        });
      }
    }
    if (hasLeft && hasRight) return 'both';
    if (hasLeft) return 'left';
    if (hasRight) return 'right';
    return 'none';
  }

  isCountStar(agg: any): boolean {
    if (!agg.args || agg.args.length === 0) return true;
    return agg.args.length === 1 && agg.args[0]?.kind === BoundExprKind.LITERAL;
  }

  walkExprRefs(expr: any, callback: (table: string) => void): void {
    if (!expr || typeof expr !== 'object') return;
    if (expr.kind === BoundExprKind.COLUMN_REF && expr.tableAlias) {
      callback(expr.tableAlias.toUpperCase());
    }
    if (expr.left) this.walkExprRefs(expr.left, callback);
    if (expr.right) this.walkExprRefs(expr.right, callback);
    if (expr.operand) this.walkExprRefs(expr.operand, callback);
    if (expr.args) for (const a of expr.args) this.walkExprRefs(a, callback);
  }

  collectPlanTableRefs(node: any): Set<string> {
    const refs = new Set<string>();
    this._collectRefs(node, refs);
    return refs;
  }

  _collectRefs(node: any, refs: Set<string>): void {
    if (!node) return;
    if (node.type === PlanNodeType.SCAN) {
      refs.add((node.alias || node.table || '').toUpperCase());
      return;
    }
    if (node.children) {
      for (const child of node.children) this._collectRefs(child, refs);
    }
  }
}
