import { OptimizationPass } from '../pass.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';
import { PlanNodeType, JoinType, getChildren, type LogicalPlanNode, type LogicalJoinNode } from '../../planner/logical-plan.js';
import { BoundExprKind, type BoundExpr, type BoundColumnRefNode } from '../../binder/expression-binder.js';
import type { ColumnInfo } from '../../binder/scope.js';
import { splitAnd } from '../sort-properties.js';
import { columnKey, isUniqueOnKeys, type UniqueKeyCatalog } from '../unique-keys.js';

interface NamedExpr {
  outputName?: string;
  alias?: string;
  name?: string;
  columnName?: string;
}

export class JoinElimination extends OptimizationPass {
  catalog: UniqueKeyCatalog | null;

  constructor(catalog: UniqueKeyCatalog | null = null) {
    super();
    this.catalog = catalog;
  }

  override get name() { return 'JoinElimination'; }

  override apply(plan: LogicalPlanNode): LogicalPlanNode {
    const rewriter = new JoinEliminationRewriter(this.catalog);
    return rewriter.rewrite(plan);
  }
}

const COLUMN_RESTRICTING_PARENTS = new Set<PlanNodeType>([PlanNodeType.PROJECT, PlanNodeType.AGGREGATE]);

class JoinEliminationRewriter extends PlanRewriter {
  catalog: UniqueKeyCatalog | null;

  constructor(catalog: UniqueKeyCatalog | null) {
    super();
    this.catalog = catalog;
  }

  override rewriteDefault(node: LogicalPlanNode): LogicalPlanNode {
    const newNode = this.rewriteChildren(node);

    if (COLUMN_RESTRICTING_PARENTS.has(newNode.type) && hasLeftJoinChild(newNode)) {
      return tryEliminateLeftJoin(newNode, this.catalog);
    }

    return newNode;
  }
}

function hasLeftJoinChild(node: LogicalPlanNode): boolean {
  if (!node.children) return false;
  return node.children.some((c) => c.type === PlanNodeType.JOIN && c.joinType === JoinType.LEFT);
}

function tryEliminateLeftJoin(parent: LogicalPlanNode, catalog: UniqueKeyCatalog | null): LogicalPlanNode {
  const parentChildren = parent.children || [];
  const newChildren = parentChildren.map((child) => {
    if (child.type !== PlanNodeType.JOIN || child.joinType !== JoinType.LEFT) return child;

    const rightTables = collectTableAliases(child.children[1]);
    const rightOutputs = collectOutputNames(child.children[1]);

    const usedAbove = new Set<string>();
    collectNodeExprColumns(parent, usedAbove);

    const rightUsed = hasAnyColumnUsed(rightTables, usedAbove)
      || hasAnyNameUsed(rightOutputs, usedAbove);

    if (rightUsed) return child;
    if (!preservesLeftCardinality(child, catalog)) return child;
    return child.children[0];
  });

  const changed = newChildren.some((c, i) => c !== parentChildren[i]);
  return changed ? { ...parent, children: newChildren } : parent;
}

function preservesLeftCardinality(join: LogicalJoinNode, catalog: UniqueKeyCatalog | null): boolean {
  const right = join.children[1];
  const rightAliases = collectTableAliases(right);
  const rightNames = collectOutputNames(right);
  const rightKeys = new Set<string>();

  for (const pred of splitAnd(join.condition)) {
    if (pred.kind !== BoundExprKind.BINARY || pred.op !== '=') continue;
    for (const side of [pred.left, pred.right]) {
      if (side.kind !== BoundExprKind.COLUMN_REF) continue;
      if (!belongsToRight(side, rightAliases, rightNames)) continue;
      rightKeys.add(columnKey(side.tableAlias, side.columnName));
    }
  }

  return isUniqueOnKeys(right, rightKeys, catalog);
}

function belongsToRight(ref: BoundColumnRefNode, aliases: Set<string>, names: Set<string>): boolean {
  const alias = (ref.tableAlias || '').toUpperCase();
  if (alias) return aliases.has(alias);
  return names.has((ref.columnName || '').toUpperCase());
}

function collectNodeExprColumns(node: LogicalPlanNode, used: Set<string>): void {
  const collectExpr = (expr: BoundExpr): void => {
    if (!expr || typeof expr !== 'object') return;
    if (expr.kind === BoundExprKind.COLUMN_REF) {
      used.add(`${(expr.tableAlias || '').toUpperCase()}.${(expr.columnName || '').toUpperCase()}`);
      return;
    }
    for (const val of Object.values(expr)) {
      if (Array.isArray(val)) {
        for (const item of val) collectExpr(item as BoundExpr);
      } else if (val && typeof val === 'object') {
        collectExpr(val as BoundExpr);
      }
    }
  };

  switch (node.type) {
    case PlanNodeType.PROJECT:
      for (const expr of node.expressions) collectExpr(expr);
      break;
    case PlanNodeType.FILTER:
      if (node.condition) collectExpr(node.condition);
      break;
    case PlanNodeType.AGGREGATE:
      if (node.groupBy) for (const g of node.groupBy) collectExpr(g);
      for (const agg of node.aggregates) {
        for (const arg of (agg as BoundExpr & { args?: BoundExpr[] }).args || []) collectExpr(arg);
      }
      break;
    case PlanNodeType.SORT:
      for (const ok of node.orderKeys) collectExpr(ok.expr);
      break;
    case PlanNodeType.DISTINCT:
      break;
  }
}

function collectTableAliases(node: LogicalPlanNode): Set<string> {
  const aliases = new Set<string>();
  function walk(n: LogicalPlanNode): void {
    if (!n) return;
    if (n.type === PlanNodeType.SCAN) {
      aliases.add((n.alias || n.table).toUpperCase());
    }
    for (const child of getChildren(n)) walk(child);
  }
  walk(node);
  return aliases;
}

function hasAnyColumnUsed(tableAliases: Set<string>, usedColumns: Set<string>): boolean {
  for (const col of usedColumns) {
    const table = col.split('.')[0];
    if (tableAliases.has(table)) return true;
  }
  return false;
}

function hasAnyNameUsed(columnNames: Set<string>, usedColumns: Set<string>): boolean {
  for (const col of usedColumns) {
    const name = col.split('.')[1];
    if (name && columnNames.has(name)) return true;
  }
  return false;
}

function collectOutputNames(node: LogicalPlanNode): Set<string> {
  const names = new Set<string>();
  const add = (value?: string | null): void => {
    const name = (value || '').toUpperCase();
    if (name) names.add(name);
  };
  const outputName = (expr: NamedExpr): void =>
    add(expr?.outputName || expr?.alias || expr?.name || expr?.columnName);

  function walk(n: LogicalPlanNode): void {
    if (!n) return;
    switch (n.type) {
      case PlanNodeType.SCAN:
        for (const col of n.columns || []) add(col.name || (col as ColumnInfo & { columnName?: string }).columnName);
        return;
      case PlanNodeType.PROJECT:
        for (const expr of n.expressions || []) outputName(expr as NamedExpr);
        return;
      case PlanNodeType.AGGREGATE:
        for (const expr of n.groupBy || []) outputName(expr as NamedExpr);
        for (const agg of n.aggregates || []) outputName(agg as NamedExpr);
        return;
      default:
        for (const child of getChildren(n)) walk(child);
    }
  }

  walk(node);
  return names;
}
