import { PlanNodeType, JoinType, SetOpType, type LogicalPlanNode } from './logical-plan.js';

const SET_OP_LABELS: Readonly<Record<SetOpType, string>> = {
  [SetOpType.UNION]: 'Union',
  [SetOpType.INTERSECT]: 'Intersect',
  [SetOpType.EXCEPT]: 'Except',
};
import { BoundExprKind, type BoundExpr, type BoundAggregateNode, type BoundWindowNode } from '../binder/expression-binder.js';

export function formatExpression(expr?: BoundExpr | null): string {
  if (!expr) return '';
  switch (expr.kind) {
    case BoundExprKind.COLUMN_REF:
      return expr.tableAlias ? `${expr.tableAlias}.${expr.columnName}` : expr.columnName;
    case BoundExprKind.LITERAL:
      if (typeof expr.value === 'string') return `'${expr.value}'`;
      return String(expr.value);
    case BoundExprKind.BINARY:
      return `(${formatExpression(expr.left)} ${expr.op} ${formatExpression(expr.right)})`;
    case BoundExprKind.UNARY:
      return `${expr.op} ${formatExpression(expr.operand)}`;
    case BoundExprKind.FUNCTION:
      return `${expr.name}(${expr.args.map(formatExpression).join(', ')})`;
    case BoundExprKind.AGGREGATE:
      return `${expr.name}(${expr.args.map(formatExpression).join(', ')})`;
    default:
      return expr.kind ? `<${expr.kind}>` : JSON.stringify(expr);
  }
}

export function formatPlan(plan: LogicalPlanNode, depth: number = 0): string {
  const indent = '  '.repeat(depth);
  let result = `${indent}-> ${formatNode(plan)}\n`;

  if (plan.children && plan.children.length > 0) {
    for (const child of plan.children) {
      result += formatPlan(child, depth + 1);
    }
  }

  return result;
}

function formatNode(node: LogicalPlanNode): string {
  switch (node.type) {
    case PlanNodeType.SCAN:
      return `Seq Scan on ${node.table}${node.alias ? ' as ' + node.alias : ''}`;
    case PlanNodeType.FILTER:
      return `Filter (condition: ${formatExpression(node.condition)})`;
    case PlanNodeType.PROJECT:
      const exprs = node.expressions.map(e => formatExpression(e)).join(', ');
      return `Project (${exprs})`;
    case PlanNodeType.JOIN: {
      const joinTypeStr = node.joinType === JoinType.INNER ? '' : `${node.joinType} `;
      let joinStr = `${joinTypeStr}Join`;
      if (node.condition) joinStr += ` (condition: ${formatExpression(node.condition)})`;
      return joinStr;
    }
    case PlanNodeType.AGGREGATE: {
      let aggStr = 'Aggregate';
      if (node.groupBy && node.groupBy.length > 0) {
        aggStr += ` (group by: ${node.groupBy.map(g => formatExpression(g)).join(', ')})`;
      }
      if (node.aggregates && node.aggregates.length > 0) {
        aggStr += ` (aggs: ${node.aggregates.map(a => `${(a as BoundAggregateNode).name}(${(a as BoundAggregateNode).args.map(arg => formatExpression(arg)).join(', ')})`).join(', ')})`;
      }
      return aggStr;
    }
    case PlanNodeType.SORT:
      const sorts = node.orderKeys.map(k => `${formatExpression(k.expr)} ${k.direction || 'ASC'}`).join(', ');
      return `Sort (${sorts})`;
    case PlanNodeType.LIMIT:
      return `Limit (count: ${node.count}${node.offset ? ', offset: ' + node.offset : ''})`;
    case PlanNodeType.TOP_N: {
      const topNSorts = node.orderKeys.map(k => `${formatExpression(k.expr)} ${k.direction || 'ASC'}`).join(', ');
      return `Top-N (count: ${node.count}${node.offset ? ', offset: ' + node.offset : ''}, order: ${topNSorts})`;
    }
    case PlanNodeType.DISTINCT:
      return `Distinct`;
    case PlanNodeType.SET_OP:
      return `${SET_OP_LABELS[node.op]}${node.all ? ' All' : ''}`;
    case PlanNodeType.CTE_ANCHOR:
      return `CTE Anchor (${node.cteName})`;
    case PlanNodeType.CTE_SCAN:
      return `CTE Scan (${node.cteName})`;
    case PlanNodeType.MATERIALIZE:
      return `Materialize`;
    case PlanNodeType.DEPENDENT_JOIN:
      return `Dependent Join (${node.subqueryType})`;
    case PlanNodeType.INDEX_SCAN: {
      let desc = `Index Scan using ${node.indexName} on ${node.table}`;
      if (node.alias !== node.table) desc += ` as ${node.alias}`;
      if (node.scanType === 'point') desc += ` (key: ${node.scanKey})`;
      else desc += ` (range: ${node.scanLow ?? '-∞'} to ${node.scanHigh ?? '∞'})`;
      return desc;
    }
    case PlanNodeType.EMPTY:
      return `Empty (short-circuit)`;
    case PlanNodeType.WINDOW: {
      const wExprs = node.windowExprs.map(w => (w as BoundWindowNode).name).join(', ');
      return `Window (${wExprs})`;
    }
    default:
      return `${node.type}`;
  }
}
