import { getChildren, setChildren } from './logical-plan.js';

export class PlanVisitor {
  visit(node) {
    const method = `visit${node.type}`;
    if (typeof this[method] === 'function') {
      return this[method](node);
    }
    return this.visitDefault(node);
  }

  visitDefault(node) {
    this.visitChildren(node);
  }

  visitChildren(node) {
    for (const child of getChildren(node)) {
      this.visit(child);
    }
  }
}

export class PlanRewriter {
  rewrite(node) {
    const method = `rewrite${node.type}`;
    if (typeof this[method] === 'function') {
      return this[method](node);
    }
    return this.rewriteDefault(node);
  }

  rewriteDefault(node) {
    return this.rewriteChildren(node);
  }

  rewriteChildren(node) {
    const children = getChildren(node);
    if (children.length === 0) return node;

    const newChildren = children.map(child => this.rewrite(child));
    const changed = newChildren.some((child, i) => child !== children[i]);
    return changed ? setChildren(node, newChildren) : node;
  }
}
