export const PlanNodeType = {
  SCAN: 'Scan',
  FILTER: 'Filter',
  PROJECT: 'Project',
  JOIN: 'Join',
  AGGREGATE: 'Aggregate',
  SORT: 'Sort',
  LIMIT: 'Limit',
  DISTINCT: 'Distinct',
  UNION: 'Union',
  CTE_SCAN: 'CTEScan',
  CTE_ANCHOR: 'CTEAnchor',
  DEPENDENT_JOIN: 'DependentJoin',
  MATERIALIZE: 'Materialize',
  EMPTY: 'Empty',
  TOP_N: 'TopN',
  INDEX_SCAN: 'IndexScan',
};

export const JoinType = {
  INNER: 'INNER',
  LEFT: 'LEFT',
  RIGHT: 'RIGHT',
  FULL: 'FULL',
  SEMI: 'SEMI',
  ANTI: 'ANTI',
  MARK: 'MARK',
  SINGLE: 'SINGLE',
  CROSS: 'CROSS',
};

export const PhysicalStrategy = {
  HASH: 'HASH',
  MERGE: 'MERGE',
  NESTED_LOOP: 'NESTED_LOOP',
  STREAM: 'STREAM',
  UNGROUPED: 'UNGROUPED',
  PERFECT_HASH: 'PERFECT_HASH',
};

export const SortDirection = {
  ASC: 'ASC',
  DESC: 'DESC',
};

export const NullOrder = {
  FIRST: 'FIRST',
  LAST: 'LAST',
};

export function LogicalScan(table, columns, alias) {
  return { type: PlanNodeType.SCAN, table, columns, alias: alias || table };
}

export function LogicalFilter(condition, child) {
  return { type: PlanNodeType.FILTER, condition, children: [child] };
}

export function LogicalProject(expressions, child) {
  return { type: PlanNodeType.PROJECT, expressions, children: [child] };
}

export function LogicalJoin(joinType, condition, left, right, physicalStrategy = PhysicalStrategy.HASH) {
  return {
    type: PlanNodeType.JOIN,
    joinType,
    condition,
    children: [left, right],
    physicalStrategy,
  };
}

export function LogicalAggregate(groupBy, aggregates, child, physicalStrategy = PhysicalStrategy.HASH) {
  return {
    type: PlanNodeType.AGGREGATE,
    groupBy,
    aggregates,
    children: [child],
    physicalStrategy,
  };
}

export function LogicalSort(orderKeys, child) {
  return { type: PlanNodeType.SORT, orderKeys, children: [child] };
}

export function LogicalLimit(count, offset, child) {
  return { type: PlanNodeType.LIMIT, count, offset: offset || 0, children: [child] };
}

export function LogicalDistinct(child) {
  return { type: PlanNodeType.DISTINCT, children: [child] };
}

export function LogicalUnion(left, right, all) {
  return { type: PlanNodeType.UNION, all: !!all, children: [left, right] };
}

export function LogicalCTEScan(cteName, cteId) {
  return { type: PlanNodeType.CTE_SCAN, cteName, cteId, children: [] };
}

export function LogicalCTEAnchor(cteName, cteId, producer, consumer) {
  return { type: PlanNodeType.CTE_ANCHOR, cteName, cteId, children: [producer, consumer] };
}

export function LogicalDependentJoin(child, subquery, correlatedColumns, subqueryType, condition) {
  return {
    type: PlanNodeType.DEPENDENT_JOIN,
    correlatedColumns,
    subqueryType,
    condition,
    children: [child, subquery],
  };
}

export function LogicalTopN(orderKeys, count, offset, child) {
  return { type: PlanNodeType.TOP_N, orderKeys, count, offset: offset || 0, children: [child] };
}

export function LogicalIndexScan(table, alias, indexName, columnName, scanType, scanKey, scanLow, scanHigh, lowInc, highInc, columns) {
  return {
    type: PlanNodeType.INDEX_SCAN,
    table, alias: alias || table, indexName, columnName,
    scanType, scanKey, scanLow, scanHigh, lowInc, highInc,
    columns,
  };
}

export function LogicalMaterialize(child) {
  return { type: PlanNodeType.MATERIALIZE, children: [child] };
}

export function getChildren(node) {
  return node.children || [];
}

export function setChildren(node, children) {
  return { ...node, children };
}

export function planToString(node, indent = 0) {
  const prefix = '  '.repeat(indent);
  let str = `${prefix}${node.type}`;

  switch (node.type) {
    case PlanNodeType.SCAN:
      str += `(${node.table}${node.alias !== node.table ? ` AS ${node.alias}` : ''})`;
      break;
    case PlanNodeType.JOIN:
      str += `(${node.joinType})`;
      break;
    case PlanNodeType.LIMIT:
      str += `(${node.count}${node.offset ? `, offset=${node.offset}` : ''})`;
      break;
    case PlanNodeType.CTE_SCAN:
      str += `(${node.cteName})`;
      break;
    case PlanNodeType.CTE_ANCHOR:
      str += `(${node.cteName})`;
      break;
    case PlanNodeType.DEPENDENT_JOIN:
      str += `(${node.subqueryType})`;
      break;
    case PlanNodeType.TOP_N:
      str += `(${node.count}${node.offset ? `, offset=${node.offset}` : ''})`;
      break;
    case PlanNodeType.INDEX_SCAN:
      str += `(${node.table} using ${node.indexName})`;
      break;
  }

  str += '\n';
  for (const child of getChildren(node)) {
    str += planToString(child, indent + 1);
  }
  return str;
}
