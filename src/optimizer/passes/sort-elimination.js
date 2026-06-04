import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType } from '../../planner/logical-plan.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class SortElimination extends OptimizationPass {
  get name() { return 'SortElimination'; }

  apply(plan) {
    const rewriter = new SortEliminationRewriter();
    return rewriter.rewrite(plan);
  }
}

class SortEliminationRewriter extends PlanRewriter {
  rewriteSort(node) {
    const child = this.rewrite(node.children[0]);

    if (!child._sortedBy || child._sortedBy.length === 0) {
      if (child !== node.children[0]) {
        return { ...node, children: [child] };
      }
      return node;
    }

    const requiredKeys = node.orderKeys.map(ok => ({
      key: getColumnKey(ok.expr),
      direction: ok.direction || 'ASC',
    }));

    if (requiredKeys.some(k => !k.key)) {
      if (child !== node.children[0]) {
        return { ...node, children: [child] };
      }
      return node;
    }

    const childSorted = child._sortedBy;
    let match = true;
    for (let i = 0; i < requiredKeys.length; i++) {
      if (i >= childSorted.length) { match = false; break; }
      if (!columnMatches(childSorted[i], requiredKeys[i].key)) { match = false; break; }
    }

    if (match) {
      return child;
    }

    if (child !== node.children[0]) {
      return { ...node, children: [child] };
    }
    return node;
  }
}

function getColumnKey(expr) {
  if (!expr) return null;
  if (expr.kind === BoundExprKind.COLUMN_REF) {
    return `${expr.tableAlias || ''}.${expr.columnName}`.toUpperCase();
  }
  return null;
}

function columnMatches(sortedKey, reqKey) {
  if (!sortedKey || !reqKey) return false;
  if (sortedKey === reqKey) return true;
  const sortedCol = sortedKey.split('.').pop();
  const reqCol = reqKey.split('.').pop();
  return sortedCol === reqCol;
}
