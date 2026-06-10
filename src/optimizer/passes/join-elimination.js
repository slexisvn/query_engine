import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { PlanNodeType, JoinType, getChildren } from '../../planner/logical-plan.js';
import { BoundExprKind } from '../../binder/expression-binder.js';

export class JoinElimination extends OptimizationPass {
  get name() { return 'JoinElimination'; }

  apply(plan) {
    const rewriter = new JoinEliminationRewriter();
    return rewriter.rewrite(plan);
  }
}

const COLUMN_RESTRICTING_PARENTS = new Set([PlanNodeType.PROJECT, PlanNodeType.AGGREGATE]);

class JoinEliminationRewriter extends PlanRewriter {
  rewriteDefault(node) {
    const newNode = this.rewriteChildren(node);

    if (COLUMN_RESTRICTING_PARENTS.has(newNode.type) && hasLeftJoinChild(newNode)) {
      return tryEliminateLeftJoin(newNode);
    }

    return newNode;
  }
}

function hasLeftJoinChild(node) {
  if (!node.children) return false;
  return node.children.some(c => c.type === PlanNodeType.JOIN && c.joinType === JoinType.LEFT);
}

function tryEliminateLeftJoin(parent) {
  const newChildren = parent.children.map(child => {
    if (child.type !== PlanNodeType.JOIN || child.joinType !== JoinType.LEFT) return child;

    const rightTables = collectTableAliases(child.children[1]);
    const rightOutputs = collectOutputNames(child.children[1]);

    const usedAbove = new Set();
    collectNodeExprColumns(parent, usedAbove);

    const rightUsed = hasAnyColumnUsed(rightTables, usedAbove)
      || hasAnyNameUsed(rightOutputs, usedAbove);

    if (!rightUsed) {
      return child.children[0];
    }
    return child;
  });

  const changed = newChildren.some((c, i) => c !== parent.children[i]);
  return changed ? { ...parent, children: newChildren } : parent;
}

function collectNodeExprColumns(node, used) {
  const collectExpr = (expr) => {
    if (!expr || typeof expr !== 'object') return;
    if (expr.kind === BoundExprKind.COLUMN_REF) {
      used.add(`${(expr.tableAlias || '').toUpperCase()}.${(expr.columnName || '').toUpperCase()}`);
      return;
    }
    for (const val of Object.values(expr)) {
      if (Array.isArray(val)) {
        for (const item of val) collectExpr(item);
      } else if (val && typeof val === 'object') {
        collectExpr(val);
      }
    }
  };

  switch (node.type) {
    case PlanNodeType.PROJECT:
      for (const expr of node.expressions) collectExpr(expr);
      break;
    case PlanNodeType.FILTER:
      collectExpr(node.condition);
      break;
    case PlanNodeType.AGGREGATE:
      if (node.groupBy) for (const g of node.groupBy) collectExpr(g);
      for (const agg of node.aggregates) {
        for (const arg of agg.args) collectExpr(arg);
      }
      break;
    case PlanNodeType.SORT:
      for (const ok of node.orderKeys) collectExpr(ok.expr);
      break;
    case PlanNodeType.DISTINCT:
      break;
  }
}

function collectTableAliases(node) {
  const aliases = new Set();
  function walk(n) {
    if (!n) return;
    if (n.type === PlanNodeType.SCAN) {
      aliases.add((n.alias || n.table).toUpperCase());
    }
    for (const child of getChildren(n)) walk(child);
  }
  walk(node);
  return aliases;
}

function hasAnyColumnUsed(tableAliases, usedColumns) {
  for (const col of usedColumns) {
    const table = col.split('.')[0];
    if (tableAliases.has(table)) return true;
  }
  return false;
}

function hasAnyNameUsed(columnNames, usedColumns) {
  for (const col of usedColumns) {
    const name = col.split('.')[1];
    if (name && columnNames.has(name)) return true;
  }
  return false;
}

function collectOutputNames(node) {
  const names = new Set();
  const add = (value) => {
    const name = (value || '').toUpperCase();
    if (name) names.add(name);
  };
  const outputName = (expr) =>
    add(expr?.outputName || expr?.alias || expr?.name || expr?.columnName);

  function walk(n) {
    if (!n) return;
    switch (n.type) {
      case PlanNodeType.SCAN:
        for (const col of n.columns || []) add(col.name || col.columnName);
        return;
      case PlanNodeType.PROJECT:
        for (const expr of n.expressions || []) outputName(expr);
        return;
      case PlanNodeType.AGGREGATE:
        for (const expr of n.groupBy || []) outputName(expr);
        for (const agg of n.aggregates || []) outputName(agg);
        return;
      default:
        for (const child of getChildren(n)) walk(child);
    }
  }

  walk(node);
  return names;
}
