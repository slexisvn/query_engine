import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, LogicalAggregate, type LogicalPlanNode, type LogicalAggregateNode, type LogicalJoinNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { BoundExprKind, type BoundExpr } from '../../binder/expression-binder.js';

type Side = 'left' | 'right' | 'both' | 'none';

interface ColumnRefLike {
  kind: BoundExprKind;
  columnName: string | undefined;
  tableAlias: string | null;
}

interface ExprWalkFields {
  left?: BoundExpr;
  right?: BoundExpr;
  operand?: BoundExpr;
  args?: BoundExpr[];
}

interface AggDescriptor {
  kind?: BoundExprKind;
  func?: string;
  functionName?: string;
  outputName?: string;
  args?: Array<BoundExpr | ColumnRefLike>;
  distinct?: boolean;
  tableAlias?: string;
  _isPartial?: boolean;
  _isFinal?: boolean;
}

const DECOMPOSABLE_FUNCTIONS = new Map<string, { partial: string; final: string }>([
  ['SUM', { partial: 'SUM', final: 'SUM' }],
  ['COUNT', { partial: 'COUNT', final: 'SUM' }],
  ['MIN', { partial: 'MIN', final: 'MIN' }],
  ['MAX', { partial: 'MAX', final: 'MAX' }],
]);

export class AggregatePushdown extends OptimizationPass {
  override get name() { return 'AggregatePushdown'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new AggregatePushdownRewriter();
    return rewriter.rewrite(plan);
  }
}

class AggregatePushdownRewriter extends PlanRewriter {
  override rewriteAggregate(node: LogicalAggregateNode): LogicalPlanNode {
    const rewritten = this.rewriteChildren(node);
    const child = rewritten.children[0];

    if (child.type !== PlanNodeType.JOIN || child.joinType !== JoinType.INNER) return rewritten;
    if (!rewritten.groupBy || rewritten.groupBy.length === 0) return rewritten;
    if (!rewritten.aggregates || rewritten.aggregates.length === 0) return rewritten;

    const aggDescriptors = rewritten.aggregates as AggDescriptor[];
    if (!this.allAggregatesDecomposable(aggDescriptors)) return rewritten;

    const leftRefs = this.collectPlanTableRefs(child.children[0]);
    const rightRefs = this.collectPlanTableRefs(child.children[1]);

    const groupBySide = this.classifyColumns(rewritten.groupBy, leftRefs, rightRefs);
    if (groupBySide === 'both' || groupBySide === 'none') return rewritten;

    const aggColumnSide = this.classifyAggInputs(aggDescriptors, leftRefs, rightRefs);
    if (aggColumnSide === 'both') return rewritten;
    if (aggColumnSide !== groupBySide && aggColumnSide !== 'none') return rewritten;

    const pushSide = groupBySide;
    const pushChildIdx = pushSide === 'left' ? 0 : 1;

    const partialAggregates = this.buildPartialAggregates(aggDescriptors);
    const partialAgg = LogicalAggregate(
      [...rewritten.groupBy],
      partialAggregates as BoundExpr[],
      child.children[pushChildIdx]
    );

    const newJoinChildren = [...child.children];
    newJoinChildren[pushChildIdx] = partialAgg;
    const newJoin = { ...child, children: newJoinChildren } as LogicalJoinNode;

    const finalAggregates = this.buildFinalAggregates(aggDescriptors, partialAggregates);
    return LogicalAggregate(rewritten.groupBy, finalAggregates as BoundExpr[], newJoin);
  }

  allAggregatesDecomposable(aggregates: AggDescriptor[]): boolean {
    return aggregates.every(agg => {
      if (agg.distinct) return false;
      const funcName = (agg.func || agg.functionName || '').toUpperCase();
      return DECOMPOSABLE_FUNCTIONS.has(funcName);
    });
  }

  buildPartialAggregates(aggregates: AggDescriptor[]): AggDescriptor[] {
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

  buildFinalAggregates(originalAggs: AggDescriptor[], partialAggs: AggDescriptor[]): AggDescriptor[] {
    return originalAggs.map((agg, idx) => {
      const funcName = (agg.func || agg.functionName || '').toUpperCase();
      const rule = DECOMPOSABLE_FUNCTIONS.get(funcName)!;
      const partialRef: ColumnRefLike = {
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

  classifyColumns(columns: BoundExpr[], leftRefs: Set<string>, rightRefs: Set<string>): Side {
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

  classifyAggInputs(aggregates: AggDescriptor[], leftRefs: Set<string>, rightRefs: Set<string>): Side {
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

  isCountStar(agg: AggDescriptor): boolean {
    if (!agg.args || agg.args.length === 0) return true;
    return agg.args.length === 1 && agg.args[0]?.kind === BoundExprKind.LITERAL;
  }

  walkExprRefs(expr: BoundExpr | ColumnRefLike, callback: (table: string) => void): void {
    if (!expr || typeof expr !== 'object') return;
    if (expr.kind === BoundExprKind.COLUMN_REF && expr.tableAlias) {
      callback(expr.tableAlias.toUpperCase());
    }
    const e = expr as ExprWalkFields;
    if (e.left) this.walkExprRefs(e.left, callback);
    if (e.right) this.walkExprRefs(e.right, callback);
    if (e.operand) this.walkExprRefs(e.operand, callback);
    if (e.args) for (const a of e.args) this.walkExprRefs(a, callback);
  }

  collectPlanTableRefs(node: LogicalPlanNode): Set<string> {
    const refs = new Set<string>();
    this._collectRefs(node, refs);
    return refs;
  }

  _collectRefs(node: LogicalPlanNode, refs: Set<string>): void {
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
