import { getChildren, setChildren, type LogicalPlanNode } from './logical-plan.js';

export class PlanVisitor {
  visit(node: LogicalPlanNode): unknown {
    const method = `visit${node.type}`;
    const fn = (this as any)[method];
    if (typeof fn === 'function') {
      return fn.call(this, node);
    }
    return this.visitDefault(node);
  }

  visitDefault(node: LogicalPlanNode): void {
    this.visitChildren(node);
  }

  visitChildren(node: LogicalPlanNode): void {
    for (const child of getChildren(node)) {
      this.visit(child);
    }
  }
}

export class PlanRewriter {
  rewrite(node: LogicalPlanNode): LogicalPlanNode {
    const method = `rewrite${node.type}`;
    const fn = (this as any)[method];
    if (typeof fn === 'function') {
      return fn.call(this, node);
    }
    return this.rewriteDefault(node);
  }

  rewriteDefault(node: LogicalPlanNode): LogicalPlanNode {
    return this.rewriteChildren(node);
  }

  rewriteChildren(node: LogicalPlanNode): LogicalPlanNode {
    const children = getChildren(node);
    if (children.length === 0) return node;

    const newChildren = children.map(child => this.rewrite(child));
    const changed = newChildren.some((child, i) => child !== children[i]);
    return changed ? setChildren(node, newChildren) : node;
  }
}
