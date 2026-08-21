import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, LogicalJoin, LogicalFilter, getChildren, type LogicalPlanNode, type LogicalScanNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { buildHyperGraph } from '../join-order/hypergraph.js';
import { enumerateJoinOrder } from '../join-order/enumerator.js';
import { DefaultCostModel } from '../../planner/cost-model.js';
import { DefaultCardinalityEstimator, type TableStats } from '../../planner/cardinality.js';
import { collectTableRefs } from '../expr-walk.js';
import type { JoinPlan } from '../join-order/join-plan.js';
import type { Relation } from '../join-order/hypergraph.js';
import type { BoundExpr } from '../../binder/expression-binder.js';
import { splitConjuncts, combineConjuncts } from '../../binder/conjuncts.js';

const SYNTHETIC_RELATION_PREFIX = '_rel_';

function declaredRelationName(node: LogicalPlanNode): string | null {
  switch (node.type) {
    case PlanNodeType.SCAN:
    case PlanNodeType.INDEX_SCAN:
      return node.alias || node.table;
    case PlanNodeType.CTE_SCAN:
      return node.alias;
    case PlanNodeType.PROJECT:
      return node.outputAlias || null;
    case PlanNodeType.FILTER:
      return declaredRelationName(node.children[0]);
    default:
      return null;
  }
}

export class JoinReorder extends OptimizationPass {
  statisticsMap: Map<string, TableStats>;
  costModel: DefaultCostModel;
  cardEstimator: DefaultCardinalityEstimator;

  constructor(statisticsMap: Map<string, TableStats> = new Map(), costModel: DefaultCostModel | null = null, cardEstimator: DefaultCardinalityEstimator | null = null) {
    super();
    this.statisticsMap = statisticsMap;
    this.costModel = costModel || new DefaultCostModel();
    this.cardEstimator = cardEstimator || new DefaultCardinalityEstimator(this.statisticsMap);
  }

  override get name() { return 'JoinReorder'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new JoinReorderRewriter(this.costModel, this.cardEstimator);
    return rewriter.rewrite(plan);
  }
}

class JoinReorderRewriter extends PlanRewriter {
  costModel: DefaultCostModel;
  cardEstimator: DefaultCardinalityEstimator;
  syntheticRelationCount: number;

  constructor(costModel: DefaultCostModel, cardEstimator: DefaultCardinalityEstimator) {
    super();
    this.costModel = costModel;
    this.cardEstimator = cardEstimator;
    this.syntheticRelationCount = 0;
  }

  override rewriteJoin(node: LogicalPlanNode): LogicalPlanNode {
    const rewritten = this.rewriteChildren(node);
    if (this.isInnerJoinTree(rewritten)) {
      return this.reorderJoinTree(rewritten);
    }
    if (this.isNonInnerJoin(rewritten)) {
      return this.reorderNonInnerJoin(rewritten);
    }
    return rewritten;
  }

  override rewriteDefault(node: LogicalPlanNode): LogicalPlanNode {
    const rewritten = this.rewriteChildren(node);
    if (this.isInnerJoinTree(rewritten)) {
      return this.reorderJoinTree(rewritten);
    }
    return rewritten;
  }

  isInnerJoinTree(node: LogicalPlanNode): boolean {
    if (node.type !== PlanNodeType.JOIN) return false;
    if (node.joinType !== JoinType.INNER && node.joinType !== JoinType.CROSS) return false;
    return true;
  }

  isNonInnerJoin(node: LogicalPlanNode): boolean {
    if (node.type !== PlanNodeType.JOIN) return false;
    return node.joinType === JoinType.SEMI
      || node.joinType === JoinType.ANTI
      || node.joinType === JoinType.LEFT
      || node.joinType === JoinType.MARK;
  }

  reorderNonInnerJoin(node: LogicalPlanNode): LogicalPlanNode {
    let left = node.children![0];
    let right = node.children![1];

    if (this.isInnerJoinTree(left)) left = this.reorderJoinTree(left);
    if (this.isInnerJoinTree(right)) right = this.reorderJoinTree(right);

    return { ...node, children: [left, right] };
  }

  reorderJoinTree(root: LogicalPlanNode): LogicalPlanNode {
    const relations: Relation[] = [];
    const joinPredicates: BoundExpr[] = [];
    const nonJoinFilters: BoundExpr[] = [];

    this.flattenJoinTree(root, relations, joinPredicates, nonJoinFilters);

    if (relations.length < 2) return root;

    const graph = buildHyperGraph(relations, joinPredicates, this.cardEstimator);

    if (graph.size < 2) return root;

    const result = enumerateJoinOrder(graph, this.costModel, this.cardEstimator);
    if (!result) return root;

    let plan = this.reconstructPlan(result.plan);

    const residualFilters = [...graph.unrepresentedPredicates, ...nonJoinFilters];
    if (residualFilters.length > 0) {
      plan = LogicalFilter(combineConjuncts(residualFilters), plan);
    }

    return plan;
  }

  flattenJoinTree(node: LogicalPlanNode, relations: Relation[], joinPredicates: BoundExpr[], nonJoinFilters: BoundExpr[]): void {
    if (node.type === PlanNodeType.JOIN
        && (node.joinType === JoinType.INNER || node.joinType === JoinType.CROSS)) {
      this.flattenJoinTree(node.children[0], relations, joinPredicates, nonJoinFilters);
      this.flattenJoinTree(node.children[1], relations, joinPredicates, nonJoinFilters);
      this.classifyPredicates(node.condition, joinPredicates, nonJoinFilters);
      return;
    }

    if (node.type === PlanNodeType.FILTER) {
      const child = node.children[0];

      if (child.type === PlanNodeType.JOIN
          && (child.joinType === JoinType.INNER || child.joinType === JoinType.CROSS)) {
        this.classifyPredicates(node.condition, joinPredicates, nonJoinFilters);
        this.flattenJoinTree(child, relations, joinPredicates, nonJoinFilters);
        return;
      }

      if (child.type === PlanNodeType.SCAN) {
        relations.push({ name: child.table, alias: child.alias || child.table, plan: node });
        return;
      }
    }

    if (node.type === PlanNodeType.SCAN) {
      relations.push({ name: node.table, alias: node.alias || node.table, plan: node });
      return;
    }

    const alias = this.inferAlias(node);
    relations.push({ name: alias, alias, plan: node });
  }

  classifyPredicates(condition: BoundExpr | null, joinPredicates: BoundExpr[], nonJoinFilters: BoundExpr[]): void {
    if (!condition) return;
    for (const pred of splitConjuncts(condition)) {
      if (collectTableRefs(pred).size >= 2) joinPredicates.push(pred);
      else nonJoinFilters.push(pred);
    }
  }

  reconstructPlan(dpPlan: JoinPlan | LogicalPlanNode): LogicalPlanNode {
    if (!dpPlan) return dpPlan;
    if (dpPlan.type === 'HashJoin') {
      const left = this.reconstructPlan(dpPlan.buildSide);
      const right = this.reconstructPlan(dpPlan.probeSide);
      return LogicalJoin(JoinType.INNER, dpPlan.condition, left, right);
    }
    return dpPlan;
  }

  inferAlias(node: LogicalPlanNode): string {
    const declared = declaredRelationName(node);
    if (declared) return declared;
    const scan = this.findFirstScan(node);
    return scan?.alias || scan?.table || `${SYNTHETIC_RELATION_PREFIX}${this.syntheticRelationCount++}`;
  }

  findFirstScan(node: LogicalPlanNode | null): LogicalScanNode | null {
    if (!node) return null;
    if (node.type === PlanNodeType.SCAN) return node;
    for (const child of getChildren(node)) {
      const found = this.findFirstScan(child);
      if (found) return found;
    }
    return null;
  }
}
