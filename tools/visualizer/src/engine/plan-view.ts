import { formatExpression, formatNode } from '@engine/planner/plan-formatter.js';
import { getChildren, PlanNodeType } from '@engine/planner/logical-plan.js';
import type { LogicalPlanNode } from '@engine/planner/logical-plan.js';
import type { ColumnInfo } from '@engine/binder/scope.js';
import type { BoundExpr } from '@engine/binder/expression-binder.js';

export const ROOT_PATH = 'r';

const SCAN_TYPES: ReadonlySet<PlanNodeType> = new Set([PlanNodeType.SCAN, PlanNodeType.INDEX_SCAN]);

export interface PlanViewNode {
  path: string;
  type: PlanNodeType;
  label: string;
  title: string;
  detail: string;
  cardinality: number | null;
  node: LogicalPlanNode;
  children: PlanViewNode[];
}

function unwrapSingleGroup(text: string): string {
  if (!text.startsWith('(') || !text.endsWith(')')) return text;

  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '(') depth++;
    else if (text[index] === ')' && --depth === 0) {
      return index === text.length - 1 ? text.slice(1, -1) : text;
    }
  }
  return text;
}

function splitLabel(label: string): { title: string; detail: string } {
  const open = label.indexOf(' (');
  if (open === -1) return { title: label, detail: '' };
  return { title: label.slice(0, open), detail: unwrapSingleGroup(label.slice(open + 1)) };
}

interface ScanFields {
  columns?: ColumnInfo[];
  pruningFilter?: BoundExpr;
}

function labelOf(node: LogicalPlanNode): string {
  const base = formatNode(node);
  if (!SCAN_TYPES.has(node.type)) return base;

  const scan = node as LogicalPlanNode & ScanFields;
  const parts: string[] = [];

  const columns = scan.columns ?? [];
  if (columns.length > 0) parts.push(`reads ${columns.map(column => column.name).join(', ')}`);
  if (scan.pruningFilter) parts.push(`skips blocks that fail ${formatExpression(scan.pruningFilter)}`);

  return parts.length === 0 ? base : `${base} (${parts.join(' · ')})`;
}

export function toPlanView(node: LogicalPlanNode, path: string = ROOT_PATH): PlanViewNode {
  const label = labelOf(node);
  const { title, detail } = splitLabel(label);
  return {
    path,
    type: node.type,
    label,
    title,
    detail,
    cardinality: node._cardinality ?? null,
    node,
    children: getChildren(node).map((child, index) => toPlanView(child, `${path}.${index}`)),
  };
}

export function planViewToText(root: PlanViewNode, depth: number = 0): string[] {
  const lines = [`${'  '.repeat(depth)}-> ${root.label}`];
  for (const child of root.children) lines.push(...planViewToText(child, depth + 1));
  return lines;
}

export function flattenPlanView(root: PlanViewNode, into: PlanViewNode[] = []): PlanViewNode[] {
  into.push(root);
  for (const child of root.children) flattenPlanView(child, into);
  return into;
}
