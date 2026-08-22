import { OptimizationPass } from '../pass.js';
import { PlanNodeType, LogicalJoin, LogicalFilter, getChildren, type LogicalPlanNode, type LogicalJoinNode, type LogicalScanNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { buildJoinHyperGraph, type Relation } from '../join-order/hypergraph.js';
import { enumerateJoinOrder } from '../join-order/enumerator.js';
import { BITMASK_RELATION_CAPACITY, popcount } from '../join-order/bitmask.js';
import {
  computeJoinConstraints,
  nullRejectedRelations,
  JOIN_TYPE_PROPERTIES,
  JoinTreeNodeKind,
  type JoinTreeNode,
  type JoinTreeOperator,
} from '../join-order/join-conflicts.js';
import { DefaultCostModel } from '../../planner/cost-model.js';
import { DefaultCardinalityEstimator, type TableStats } from '../../planner/cardinality.js';
import { collectTableRefs } from '../expr-walk.js';
import type { JoinPlan } from '../join-order/join-plan.js';
import { BoundExprKind, type BoundExpr } from '../../binder/expression-binder.js';
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

function isConjunctiveJoin(node: LogicalPlanNode): node is LogicalJoinNode {
  return node.type === PlanNodeType.JOIN && JOIN_TYPE_PROPERTIES[node.joinType].conjunctive;
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

class JoinBlock {
  relations: Relation[];
  relationNames: string[];
  relationIndex: Map<string, number>;
  residuals: BoundExpr[];
  operators: JoinTreeOperator[];
  conjunctiveOnly: boolean;
  overflowed: boolean;
  ambiguousAlias: boolean;
  syntheticCount: number;

  constructor(syntheticCount: number) {
    this.relations = [];
    this.relationNames = [];
    this.relationIndex = new Map();
    this.residuals = [];
    this.operators = [];
    this.conjunctiveOnly = true;
    this.overflowed = false;
    this.ambiguousAlias = false;
    this.syntheticCount = syntheticCount;
  }

  get edgeCount(): number {
    let total = 0;
    for (const operator of this.operators) total += operator.predicates.length;
    return total;
  }

  build(node: LogicalPlanNode): JoinTreeNode | null {
    if (node.type === PlanNodeType.JOIN) return this.buildOperator(node);
    if (node.type === PlanNodeType.FILTER && isConjunctiveJoin(node.children[0])) {
      const child = this.build(node.children[0]);
      if (!child || child.kind !== JoinTreeNodeKind.OPERATOR) return child;
      for (const conjunct of splitConjuncts(node.condition)) this.placePredicate(child, conjunct);
      return child;
    }
    return this.addRelation(node);
  }

  buildOperator(node: LogicalJoinNode): JoinTreeNode | null {
    const left = this.build(node.children[0]);
    if (!left) return null;
    const right = this.build(node.children[1]);
    if (!right) return null;

    const operator: JoinTreeOperator = {
      kind: JoinTreeNodeKind.OPERATOR,
      joinType: node.joinType,
      source: node,
      predicates: [],
      left,
      right,
      leftRels: relationsOf(left),
      rightRels: relationsOf(right),
      sesMask: 0,
      nullRejectedMask: 0,
    };
    this.operators.push(operator);

    if (JOIN_TYPE_PROPERTIES[node.joinType].conjunctive) {
      for (const conjunct of splitConjuncts(node.condition)) this.placePredicate(operator, conjunct);
    } else {
      this.conjunctiveOnly = false;
      this.addWholeCondition(operator);
    }

    return operator;
  }

  addRelation(node: LogicalPlanNode): JoinTreeNode | null {
    if (this.relations.length >= BITMASK_RELATION_CAPACITY) {
      this.overflowed = true;
      return null;
    }

    const id = this.relations.length;
    const scan = node.type === PlanNodeType.FILTER && node.children[0].type === PlanNodeType.SCAN
      ? node.children[0]
      : node.type === PlanNodeType.SCAN ? node : null;
    const alias = scan ? (scan.alias || scan.table) : this.inferAlias(node);
    const name = scan ? scan.table : alias;

    const key = alias.toUpperCase();
    this.relations.push({ name, alias, plan: node });
    this.relationNames.push(key);
    if (this.relationIndex.has(key)) this.ambiguousAlias = true;
    else this.relationIndex.set(key, id);

    return { kind: JoinTreeNodeKind.RELATION, mask: 1 << id };
  }

  inferAlias(node: LogicalPlanNode): string {
    const declared = declaredRelationName(node);
    if (declared) return declared;
    const scan = findFirstScan(node);
    return scan?.alias || scan?.table || `${SYNTHETIC_RELATION_PREFIX}${this.syntheticCount++}`;
  }

  addWholeCondition(operator: JoinTreeOperator): void {
    const condition = operator.source.condition;
    const refs = condition ? this.refsMask(condition) : 0;
    const sesMask = refs < 0 ? 0 : refs & (operator.leftRels | operator.rightRels);

    operator.sesMask = sesMask;
    operator.predicates.push({
      predicate: condition,
      sesMask,
      leftMask: (sesMask & operator.leftRels) || operator.leftRels,
      rightMask: (sesMask & operator.rightRels) || operator.rightRels,
    });
  }

  placePredicate(operator: JoinTreeOperator, predicate: BoundExpr): void {
    const sesMask = this.refsMask(predicate);
    const subtree = operator.leftRels | operator.rightRels;

    if (sesMask < 0 || popcount(sesMask) < 2 || (sesMask & ~subtree) !== 0) {
      this.residuals.push(predicate);
      return;
    }

    let target = operator;
    while ((sesMask & target.leftRels) === 0 || (sesMask & target.rightRels) === 0) {
      const next = (sesMask & target.leftRels) !== 0 ? target.left : target.right;
      if (next.kind !== JoinTreeNodeKind.OPERATOR || !JOIN_TYPE_PROPERTIES[next.joinType].conjunctive) {
        this.residuals.push(predicate);
        return;
      }
      target = next;
    }

    const sides = this.predicateSides(predicate, sesMask);
    target.predicates.push({ predicate, sesMask, leftMask: sides.leftMask, rightMask: sides.rightMask });
    target.sesMask |= sesMask;
  }

  predicateSides(predicate: BoundExpr, sesMask: number): { leftMask: number; rightMask: number } {
    if (predicate.kind === BoundExprKind.BINARY) {
      const leftMask = this.refsMask(predicate.left);
      const rightMask = this.refsMask(predicate.right);
      if (leftMask > 0 && rightMask > 0 && (leftMask & rightMask) === 0) return { leftMask, rightMask };
    }
    const anchor = sesMask & -sesMask;
    return { leftMask: anchor, rightMask: sesMask & ~anchor };
  }

  refsMask(expr: BoundExpr): number {
    let mask = 0;
    for (const ref of collectTableRefs(expr)) {
      const id = this.relationIndex.get(ref);
      if (id === undefined) return -1;
      mask |= 1 << id;
    }
    return mask;
  }

  annotateNullRejection(): void {
    for (const operator of this.operators) {
      operator.nullRejectedMask = nullRejectedRelations(
        operator.source.condition,
        operator.leftRels | operator.rightRels,
        this.relationNames,
      );
    }
  }
}

function relationsOf(node: JoinTreeNode): number {
  return node.kind === JoinTreeNodeKind.RELATION ? node.mask : node.leftRels | node.rightRels;
}

function findFirstScan(node: LogicalPlanNode | null): LogicalScanNode | null {
  if (!node) return null;
  if (node.type === PlanNodeType.SCAN) return node;
  for (const child of getChildren(node)) {
    const found = findFirstScan(child);
    if (found) return found;
  }
  return null;
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

  override rewriteJoin(node: LogicalJoinNode): LogicalPlanNode {
    const rewritten = this.rewriteChildren(node);
    return rewritten.type === PlanNodeType.JOIN ? this.reorderJoinTree(rewritten) : rewritten;
  }

  reorderJoinTree(root: LogicalJoinNode): LogicalPlanNode {
    const block = new JoinBlock(this.syntheticRelationCount);
    const tree = block.build(root);
    this.syntheticRelationCount = block.syntheticCount;

    if (!tree || block.overflowed || block.relations.length < 2) return root;
    if (block.ambiguousAlias) return root;
    if (!block.conjunctiveOnly && block.residuals.length > 0) return root;

    block.annotateNullRejection();

    const constraints = computeJoinConstraints(tree);
    const graph = buildJoinHyperGraph(block.relations, constraints, this.cardEstimator);
    if (graph.size !== block.relations.length || graph.edges.length !== block.edgeCount) return root;

    const result = enumerateJoinOrder(graph, this.costModel, this.cardEstimator);
    if (!result) return root;

    const plan = this.reconstructPlan(result.plan);
    return block.residuals.length > 0 ? LogicalFilter(combineConjuncts(block.residuals), plan) : plan;
  }

  reconstructPlan(dpPlan: JoinPlan | LogicalPlanNode): LogicalPlanNode {
    if (dpPlan.type === 'HashJoin') {
      const left = this.reconstructPlan(dpPlan.leftSide);
      const right = this.reconstructPlan(dpPlan.rightSide);
      if (!dpPlan.source) return LogicalJoin(dpPlan.joinType, dpPlan.condition, left, right);
      return { ...dpPlan.source, condition: dpPlan.condition, children: [left, right] };
    }
    return dpPlan;
  }
}
