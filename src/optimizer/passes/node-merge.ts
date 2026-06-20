import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType, type LogicalPlanNode, type LogicalFilterNode, type LogicalProjectNode, type LogicalLimitNode, type ProjectedExpr } from '../../planner/logical-plan.js';
import { BoundExprKind, type BoundBinaryNode } from '../../binder/expression-binder.js';

type EqualityValue = string | number | boolean | bigint | null | undefined | object;

export class NodeMerge extends OptimizationPass {
  override get name() { return 'NodeMerge'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new NodeMergeRewriter();
    return rewriter.rewrite(plan);
  }
}

class NodeMergeRewriter extends PlanRewriter {
  override rewriteFilter(node: LogicalFilterNode): LogicalPlanNode {
    let child: LogicalPlanNode = this.rewrite(node.children[0]);

    if (child.type === PlanNodeType.FILTER) {
      const mergedCond = {
        kind: BoundExprKind.BINARY,
        op: 'AND',
        left: node.condition,
        right: child.condition,
        resultType: 'BOOLEAN'
      } as BoundBinaryNode;

      child = child.children[0];
      return { ...node, condition: mergedCond, children: [child] };
    }

    if (child !== node.children[0]) {
      return { ...node, children: [child] };
    }
    return node;
  }

  override rewriteProject(node: LogicalProjectNode): LogicalPlanNode {
    const child: LogicalPlanNode = this.rewrite(node.children[0]);

    if (child.type === PlanNodeType.PROJECT && sameProjectExpressions(node.expressions, child.expressions)) {
      return { ...node, children: [child.children[0]] };
    }

    if (child !== node.children[0]) {
      return { ...node, children: [child] };
    }
    return node;
  }

  override rewriteLimit(node: LogicalLimitNode): LogicalPlanNode {
    const child: LogicalPlanNode = this.rewrite(node.children[0]);

    if (child.type === PlanNodeType.LIMIT) {
      const mergedCount = Math.min(node.count, child.count);
      return { ...node, count: mergedCount, children: [child.children[0]] };
    }

    if (child !== node.children[0]) {
      return { ...node, children: [child] };
    }
    return node;
  }
}

function sameProjectExpressions(left: ProjectedExpr[], right: ProjectedExpr[]): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((expr, i) => exprEqualsIgnoringOutput(expr, right[i]));
}

function exprEqualsIgnoringOutput(left: EqualityValue, right: EqualityValue): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, i) => exprEqualsIgnoringOutput(item, right[i]));
  }

  const leftRecord = left as Record<string, EqualityValue>;
  const rightRecord = right as Record<string, EqualityValue>;
  const leftKeys = Object.keys(leftRecord).filter(isSemanticKey).sort();
  const rightKeys = Object.keys(rightRecord).filter(isSemanticKey).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let i = 0; i < leftKeys.length; i++) {
    if (leftKeys[i] !== rightKeys[i]) return false;
    if (!exprEqualsIgnoringOutput(leftRecord[leftKeys[i]], rightRecord[rightKeys[i]])) return false;
  }
  return true;
}

function isSemanticKey(key: string): boolean {
  return key !== 'outputName' && key !== 'alias';
}
