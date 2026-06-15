import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType, type LogicalPlanNode } from '../../planner/logical-plan.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class NodeMerge extends OptimizationPass {
  get name() { return 'NodeMerge'; }

  apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new NodeMergeRewriter();
    return rewriter.rewrite(plan);
  }
}

class NodeMergeRewriter extends PlanRewriter {
  rewriteFilter(node: any): any {
    let child: any = this.rewrite(node.children[0]);

    if (child.type === PlanNodeType.FILTER) {
      const mergedCond = {
        kind: BoundExprKind.BINARY,
        op: 'AND',
        left: node.condition,
        right: child.condition,
        resultType: 'BOOLEAN'
      };

      child = child.children[0];
      return { ...node, condition: mergedCond, children: [child] };
    }

    if (child !== node.children[0]) {
      return { ...node, children: [child] };
    }
    return node;
  }

  rewriteProject(node: any): any {
    const child: any = this.rewrite(node.children[0]);

    if (child.type === PlanNodeType.PROJECT && sameProjectExpressions(node.expressions, child.expressions)) {
      return { ...node, children: [child.children[0]] };
    }

    if (child !== node.children[0]) {
      return { ...node, children: [child] };
    }
    return node;
  }

  rewriteLimit(node: any): any {
    const child: any = this.rewrite(node.children[0]);

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

function sameProjectExpressions(left: any, right: any): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((expr, i) => exprEqualsIgnoringOutput(expr, right[i]));
}

function exprEqualsIgnoringOutput(left: any, right: any): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, i) => exprEqualsIgnoringOutput(item, right[i]));
  }

  const leftKeys = Object.keys(left).filter(isSemanticKey).sort();
  const rightKeys = Object.keys(right).filter(isSemanticKey).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let i = 0; i < leftKeys.length; i++) {
    if (leftKeys[i] !== rightKeys[i]) return false;
    if (!exprEqualsIgnoringOutput(left[leftKeys[i]], right[rightKeys[i]])) return false;
  }
  return true;
}

function isSemanticKey(key: string): boolean {
  return key !== 'outputName' && key !== 'alias';
}
