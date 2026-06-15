import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, LogicalJoin, LogicalFilter, getChildren, setChildren, type LogicalPlanNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { buildHyperGraph } from '../dphyp/hypergraph.js';
import { runDPhyp } from '../dphyp/dphyp.js';
import { DefaultCostModel } from '../dphyp/cost-model.js';
import { DefaultCardinalityEstimator } from '../dphyp/cardinality.js';
import { BoundExprKind } from '../../binder/expression-binder.js';
import { splitConjuncts, combineConjuncts } from './predicate-pushdown.js';

export class JoinReorder extends OptimizationPass {
  statisticsMap: Map<string, any>;
  costModel: DefaultCostModel;
  cardEstimator: DefaultCardinalityEstimator;

  constructor(statisticsMap: Map<string, any> = new Map(), costModel: DefaultCostModel | null = null, cardEstimator: DefaultCardinalityEstimator | null = null) {
    super();
    this.statisticsMap = statisticsMap;
    this.costModel = costModel || new DefaultCostModel();
    this.cardEstimator = cardEstimator || new DefaultCardinalityEstimator(this.statisticsMap);
  }

  get name() { return 'JoinReorder'; }

  apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new JoinReorderRewriter(this.costModel, this.cardEstimator);
    return rewriter.rewrite(plan);
  }
}

class JoinReorderRewriter extends PlanRewriter {
  costModel: DefaultCostModel;
  cardEstimator: DefaultCardinalityEstimator;

  constructor(costModel: DefaultCostModel, cardEstimator: DefaultCardinalityEstimator) {
    super();
    this.costModel = costModel;
    this.cardEstimator = cardEstimator;
  }

  rewriteJoin(node: any): any {
    const rewritten: any = this.rewriteChildren(node);
    if (this.isInnerJoinTree(rewritten)) {
      return this.reorderJoinTree(rewritten);
    }
    if (this.isNonInnerJoin(rewritten)) {
      return this.reorderNonInnerJoin(rewritten);
    }
    return rewritten;
  }

  rewriteDefault(node: LogicalPlanNode): LogicalPlanNode {
    const rewritten: any = this.rewriteChildren(node);
    if (this.isInnerJoinTree(rewritten)) {
      return this.reorderJoinTree(rewritten);
    }
    return rewritten;
  }

  isInnerJoinTree(node: any): boolean {
    if (node.type !== PlanNodeType.JOIN) return false;
    if (node.joinType !== JoinType.INNER && node.joinType !== JoinType.CROSS) return false;
    return true;
  }

  isNonInnerJoin(node: any): boolean {
    if (node.type !== PlanNodeType.JOIN) return false;
    return node.joinType === JoinType.SEMI
      || node.joinType === JoinType.ANTI
      || node.joinType === JoinType.LEFT
      || node.joinType === JoinType.MARK;
  }

  reorderNonInnerJoin(node: any): any {
    let left = node.children[0];
    let right = node.children[1];

    if (this.isInnerJoinTree(left)) left = this.reorderJoinTree(left);
    if (this.isInnerJoinTree(right)) right = this.reorderJoinTree(right);

    return { ...node, children: [left, right] };
  }

  reorderJoinTree(root: any): any {
    const relations: any[] = [];
    const joinPredicates: any[] = [];
    const nonJoinFilters: any[] = [];

    this.flattenJoinTree(root, relations, joinPredicates, nonJoinFilters);

    if (relations.length < 2) return root;

    const graph = buildHyperGraph(relations, joinPredicates, this.cardEstimator);

    if (graph.size < 2) return root;

    const result = runDPhyp(graph, this.costModel, this.cardEstimator);
    if (!result) return root;

    let plan = this.reconstructPlan(result.plan);

    if (nonJoinFilters.length > 0) {
      plan = LogicalFilter(combineConjuncts(nonJoinFilters), plan);
    }

    return plan;
  }

  flattenJoinTree(node: any, relations: any[], joinPredicates: any[], nonJoinFilters: any[]): void {
    if (node.type === PlanNodeType.JOIN
        && (node.joinType === JoinType.INNER || node.joinType === JoinType.CROSS)) {
      this.flattenJoinTree(node.children[0], relations, joinPredicates, nonJoinFilters);
      this.flattenJoinTree(node.children[1], relations, joinPredicates, nonJoinFilters);

      if (node.condition) {
        const preds = splitConjuncts(node.condition);
        for (const pred of preds) {
          const refs = this.collectTableRefs(pred);
          if (refs.size >= 2) {
            joinPredicates.push(pred);
          } else if (refs.size === 1) {
            nonJoinFilters.push(pred);
          } else {
            nonJoinFilters.push(pred);
          }
        }
      }
      return;
    }

    if (node.type === PlanNodeType.FILTER) {
      const preds = splitConjuncts(node.condition);
      const child = node.children[0];

      if (child.type === PlanNodeType.JOIN
          && (child.joinType === JoinType.INNER || child.joinType === JoinType.CROSS)) {
        for (const pred of preds) {
          const refs = this.collectTableRefs(pred);
          if (refs.size >= 2) {
            joinPredicates.push(pred);
          } else {
            nonJoinFilters.push(pred);
          }
        }
        this.flattenJoinTree(child, relations, joinPredicates, nonJoinFilters);
        return;
      }
    }

    if (node.type === PlanNodeType.FILTER && node.children[0].type === PlanNodeType.SCAN) {
      const scan = node.children[0];
      relations.push({
        name: scan.table,
        alias: scan.alias || scan.table,
        plan: node,
      });
      return;
    }

    if (node.type === PlanNodeType.SCAN) {
      relations.push({
        name: node.table,
        alias: node.alias || node.table,
        plan: node,
      });
      return;
    }

    const alias = this.inferAlias(node);
    relations.push({
      name: alias,
      alias,
      plan: node,
    });
  }

  collectTableRefs(expr: any): Set<string> {
    const refs = new Set<string>();
    this._walkExpr(expr, (e: any) => {
      if (e.kind === BoundExprKind.COLUMN_REF && e.tableAlias) {
        refs.add(e.tableAlias.toUpperCase());
      }
    });
    return refs;
  }

  _walkExpr(expr: any, fn: (e: any) => void): void {
    if (!expr || typeof expr !== 'object') return;
    fn(expr);
    if (expr.left) this._walkExpr(expr.left, fn);
    if (expr.right) this._walkExpr(expr.right, fn);
    if (expr.operand) this._walkExpr(expr.operand, fn);
    if (expr.args) for (const a of expr.args) this._walkExpr(a, fn);
  }

  reconstructPlan(dpPlan: any): any {
    if (!dpPlan) return dpPlan;
    if (dpPlan.type === 'HashJoin') {
      const left = this.reconstructPlan(dpPlan.buildSide);
      const right = this.reconstructPlan(dpPlan.probeSide);
      return LogicalJoin(JoinType.INNER, dpPlan.condition, left, right);
    }
    return dpPlan;
  }

  inferAlias(node: any): string {
    if (node.alias) return node.alias;
    if (node.table) return node.table;
    const scan = this.findFirstScan(node);
    return scan?.alias || scan?.table || `_rel_${Math.random().toString(36).slice(2, 6)}`;
  }

  findFirstScan(node: any): any {
    if (!node) return null;
    if (node.type === PlanNodeType.SCAN) return node;
    for (const child of getChildren(node)) {
      const found = this.findFirstScan(child);
      if (found) return found;
    }
    return null;
  }
}
