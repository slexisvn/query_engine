import type { BoundExpr, BoundColumnRefNode, BoundWindowNode } from '../binder/expression-binder.js';
import type { ColumnInfo } from '../binder/scope.js';

export type IndexScanValue = string | number | bigint | null;

export type ProjectedExpr = BoundExpr & { outputName?: string };

export enum PlanNodeType {
  SCAN = 'Scan',
  FILTER = 'Filter',
  PROJECT = 'Project',
  JOIN = 'Join',
  AGGREGATE = 'Aggregate',
  SORT = 'Sort',
  LIMIT = 'Limit',
  DISTINCT = 'Distinct',
  UNION = 'Union',
  CTE_SCAN = 'CTEScan',
  CTE_ANCHOR = 'CTEAnchor',
  DEPENDENT_JOIN = 'DependentJoin',
  MATERIALIZE = 'Materialize',
  EMPTY = 'Empty',
  TOP_N = 'TopN',
  INDEX_SCAN = 'IndexScan',
  WINDOW = 'Window',
  EXCHANGE = 'Exchange',
  PARTIAL_AGGREGATE = 'PartialAggregate',
  FINAL_AGGREGATE = 'FinalAggregate',
  MERGE_EXCHANGE = 'MergeExchange',
  EXCHANGE_RECEIVE = 'ExchangeReceive',
  SINGLE_ROW = 'SingleRow',
}

export enum JoinType {
  INNER = 'INNER',
  LEFT = 'LEFT',
  RIGHT = 'RIGHT',
  FULL = 'FULL',
  SEMI = 'SEMI',
  ANTI = 'ANTI',
  MARK = 'MARK',
  SINGLE = 'SINGLE',
  CROSS = 'CROSS',
}

export enum PhysicalStrategy {
  HASH = 'HASH',
  MERGE = 'MERGE',
  NESTED_LOOP = 'NESTED_LOOP',
  STREAM = 'STREAM',
  UNGROUPED = 'UNGROUPED',
  PERFECT_HASH = 'PERFECT_HASH',
}

export enum SortDirection {
  ASC = 'ASC',
  DESC = 'DESC',
}

export enum NullOrder {
  FIRST = 'FIRST',
  LAST = 'LAST',
}

export interface LogicalOrderKey { expr: BoundExpr; direction?: string; nullOrder?: string | null; }

export type SortedByEntry = string | { key: string; direction?: string };

interface PlanNodeBase {
  children?: LogicalPlanNode[];
  _cardinality?: number;
  _sortedBy?: SortedByEntry[];
  _cteMap?: Map<string, LogicalPlanNode>;
  _requiresSort?: { left: boolean; right: boolean };
  _buildSide?: 'left' | 'right';
  _dedupeBuild?: boolean;
  _cost?: number;
}

export interface LogicalScanNode extends PlanNodeBase {
  type: PlanNodeType.SCAN;
  table: string;
  columns: ColumnInfo[];
  alias: string;
}

export interface LogicalFilterNode extends PlanNodeBase {
  type: PlanNodeType.FILTER;
  condition: BoundExpr | null;
  children: LogicalPlanNode[];
}

export interface LogicalProjectNode extends PlanNodeBase {
  type: PlanNodeType.PROJECT;
  expressions: ProjectedExpr[];
  children: LogicalPlanNode[];
}

export interface LogicalJoinNode extends PlanNodeBase {
  type: PlanNodeType.JOIN;
  joinType: JoinType;
  condition: BoundExpr | null;
  physicalStrategy: PhysicalStrategy;
  children: LogicalPlanNode[];
}

export interface LogicalAggregateNode extends PlanNodeBase {
  type: PlanNodeType.AGGREGATE;
  groupBy: BoundExpr[];
  aggregates: BoundExpr[];
  physicalStrategy: PhysicalStrategy;
  children: LogicalPlanNode[];
}

export interface LogicalSortNode extends PlanNodeBase {
  type: PlanNodeType.SORT;
  orderKeys: LogicalOrderKey[];
  limit?: number;
  offset?: number;
  children: LogicalPlanNode[];
}

export interface LogicalLimitNode extends PlanNodeBase {
  type: PlanNodeType.LIMIT;
  count: number;
  offset: number;
  children: LogicalPlanNode[];
}

export interface LogicalDistinctNode extends PlanNodeBase {
  type: PlanNodeType.DISTINCT;
  children: LogicalPlanNode[];
}

export interface LogicalUnionNode extends PlanNodeBase {
  type: PlanNodeType.UNION;
  all: boolean;
  children: LogicalPlanNode[];
}

export interface LogicalCTEScanNode extends PlanNodeBase {
  type: PlanNodeType.CTE_SCAN;
  cteName: string;
  cteId: number;
  children: LogicalPlanNode[];
}

export interface LogicalCTEAnchorNode extends PlanNodeBase {
  type: PlanNodeType.CTE_ANCHOR;
  cteName: string;
  cteId: number;
  children: LogicalPlanNode[];
}

export interface LogicalDependentJoinNode extends PlanNodeBase {
  type: PlanNodeType.DEPENDENT_JOIN;
  correlatedColumns: BoundColumnRefNode[];
  subqueryType: string;
  condition: BoundExpr | null;
  children: LogicalPlanNode[];
}

export interface LogicalTopNNode extends PlanNodeBase {
  type: PlanNodeType.TOP_N;
  orderKeys: LogicalOrderKey[];
  count: number;
  offset: number;
  children: LogicalPlanNode[];
}

export interface LogicalIndexScanNode extends PlanNodeBase {
  type: PlanNodeType.INDEX_SCAN;
  table: string;
  alias: string;
  indexName: string;
  columnName: string;
  scanType: string;
  scanKey: IndexScanValue;
  scanLow: IndexScanValue;
  scanHigh: IndexScanValue;
  lowInc: boolean;
  highInc: boolean;
  columns: ColumnInfo[];
}

export interface LogicalWindowNode extends PlanNodeBase {
  type: PlanNodeType.WINDOW;
  windowExprs: BoundExpr[];
  children: LogicalPlanNode[];
}

export interface LogicalMaterializeNode extends PlanNodeBase {
  type: PlanNodeType.MATERIALIZE;
  children: LogicalPlanNode[];
}

export interface LogicalExchangeNode extends PlanNodeBase {
  type: PlanNodeType.EXCHANGE;
  exchangeType: string;
  partitionKeys: BoundExpr[];
  partitionCount: number;
  children: LogicalPlanNode[];
}

export interface LogicalPartialAggregateNode extends PlanNodeBase {
  type: PlanNodeType.PARTIAL_AGGREGATE;
  groupBy: BoundExpr[];
  aggregates: BoundExpr[];
  physicalStrategy: PhysicalStrategy;
  children: LogicalPlanNode[];
}

export interface LogicalFinalAggregateNode extends PlanNodeBase {
  type: PlanNodeType.FINAL_AGGREGATE;
  groupBy: BoundExpr[];
  aggregates: BoundExpr[];
  partialAggregates: BoundExpr[];
  physicalStrategy: PhysicalStrategy;
  children: LogicalPlanNode[];
}

export interface LogicalMergeExchangeNode extends PlanNodeBase {
  type: PlanNodeType.MERGE_EXCHANGE;
  orderKeys: LogicalOrderKey[];
  limit: number | null;
  children: LogicalPlanNode[];
}

export interface LogicalExchangeReceiveNode extends PlanNodeBase {
  type: PlanNodeType.EXCHANGE_RECEIVE;
  sourceFragmentIds: number[];
  schema: ColumnInfo[];
  children: LogicalPlanNode[];
}

export interface LogicalSingleRowNode extends PlanNodeBase {
  type: PlanNodeType.SINGLE_ROW;
  children: LogicalPlanNode[];
}

export interface LogicalEmptyNode extends PlanNodeBase {
  type: PlanNodeType.EMPTY;
  children?: LogicalPlanNode[];
}

export type LogicalPlanNode =
  | LogicalScanNode | LogicalFilterNode | LogicalProjectNode | LogicalJoinNode
  | LogicalAggregateNode | LogicalSortNode | LogicalLimitNode | LogicalDistinctNode
  | LogicalUnionNode | LogicalCTEScanNode | LogicalCTEAnchorNode | LogicalDependentJoinNode
  | LogicalTopNNode | LogicalIndexScanNode | LogicalWindowNode | LogicalMaterializeNode
  | LogicalExchangeNode | LogicalPartialAggregateNode | LogicalFinalAggregateNode
  | LogicalMergeExchangeNode | LogicalExchangeReceiveNode | LogicalSingleRowNode
  | LogicalEmptyNode;

export function LogicalScan(table: string, columns: ColumnInfo[], alias?: string): LogicalScanNode {
  return { type: PlanNodeType.SCAN, table, columns, alias: alias || table };
}

export function LogicalFilter(condition: BoundExpr | null, child: LogicalPlanNode): LogicalFilterNode {
  return { type: PlanNodeType.FILTER, condition, children: [child] };
}

export function LogicalProject(expressions: ProjectedExpr[], child: LogicalPlanNode): LogicalProjectNode {
  return { type: PlanNodeType.PROJECT, expressions, children: [child] };
}

export function LogicalJoin(joinType: JoinType, condition: BoundExpr | null, left: LogicalPlanNode, right: LogicalPlanNode, physicalStrategy: PhysicalStrategy = PhysicalStrategy.HASH): LogicalJoinNode {
  return {
    type: PlanNodeType.JOIN,
    joinType,
    condition,
    children: [left, right],
    physicalStrategy,
  };
}

export function LogicalAggregate(groupBy: BoundExpr[], aggregates: BoundExpr[], child: LogicalPlanNode, physicalStrategy: PhysicalStrategy = PhysicalStrategy.HASH): LogicalAggregateNode {
  return {
    type: PlanNodeType.AGGREGATE,
    groupBy,
    aggregates,
    children: [child],
    physicalStrategy,
  };
}

export function LogicalSort(orderKeys: LogicalOrderKey[], child: LogicalPlanNode): LogicalSortNode {
  return { type: PlanNodeType.SORT, orderKeys, children: [child] };
}

export function LogicalLimit(count: number, offset: number | null | undefined, child: LogicalPlanNode): LogicalLimitNode {
  return { type: PlanNodeType.LIMIT, count, offset: offset || 0, children: [child] };
}

export function LogicalDistinct(child: LogicalPlanNode): LogicalDistinctNode {
  return { type: PlanNodeType.DISTINCT, children: [child] };
}

export function LogicalUnion(left: LogicalPlanNode, right: LogicalPlanNode, all: boolean): LogicalUnionNode {
  return { type: PlanNodeType.UNION, all: !!all, children: [left, right] };
}

export function LogicalCTEScan(cteName: string, cteId: number): LogicalCTEScanNode {
  return { type: PlanNodeType.CTE_SCAN, cteName, cteId, children: [] };
}

export function LogicalCTEAnchor(cteName: string, cteId: number, producer: LogicalPlanNode, consumer: LogicalPlanNode): LogicalCTEAnchorNode {
  return { type: PlanNodeType.CTE_ANCHOR, cteName, cteId, children: [producer, consumer] };
}

export function LogicalDependentJoin(child: LogicalPlanNode, subquery: LogicalPlanNode, correlatedColumns: BoundColumnRefNode[], subqueryType: string, condition: BoundExpr | null): LogicalDependentJoinNode {
  return {
    type: PlanNodeType.DEPENDENT_JOIN,
    correlatedColumns,
    subqueryType,
    condition,
    children: [child, subquery],
  };
}

export function LogicalTopN(orderKeys: LogicalOrderKey[], count: number, offset: number | null | undefined, child: LogicalPlanNode): LogicalTopNNode {
  return { type: PlanNodeType.TOP_N, orderKeys, count, offset: offset || 0, children: [child] };
}

export function LogicalIndexScan(table: string, alias: string | undefined, indexName: string, columnName: string, scanType: string, scanKey: IndexScanValue, scanLow: IndexScanValue, scanHigh: IndexScanValue, lowInc: boolean, highInc: boolean, columns: ColumnInfo[]): LogicalIndexScanNode {
  return {
    type: PlanNodeType.INDEX_SCAN,
    table, alias: alias || table, indexName, columnName,
    scanType, scanKey, scanLow, scanHigh, lowInc, highInc,
    columns,
  };
}

export function LogicalWindow(windowExprs: BoundExpr[], child: LogicalPlanNode): LogicalWindowNode {
  return { type: PlanNodeType.WINDOW, windowExprs, children: [child] };
}

export function LogicalMaterialize(child: LogicalPlanNode): LogicalMaterializeNode {
  return { type: PlanNodeType.MATERIALIZE, children: [child] };
}

export function LogicalExchange(exchangeType: string, partitionKeys: BoundExpr[] | null | undefined, partitionCount: number | null | undefined, child: LogicalPlanNode): LogicalExchangeNode {
  return {
    type: PlanNodeType.EXCHANGE,
    exchangeType,
    partitionKeys: partitionKeys || [],
    partitionCount: partitionCount || 0,
    children: [child],
  };
}

export function LogicalPartialAggregate(groupBy: BoundExpr[], aggregates: BoundExpr[], child: LogicalPlanNode): LogicalPartialAggregateNode {
  return {
    type: PlanNodeType.PARTIAL_AGGREGATE,
    groupBy,
    aggregates,
    children: [child],
    physicalStrategy: PhysicalStrategy.HASH,
  };
}

export function LogicalFinalAggregate(groupBy: BoundExpr[], aggregates: BoundExpr[], partialAggregates: BoundExpr[], child: LogicalPlanNode): LogicalFinalAggregateNode {
  return {
    type: PlanNodeType.FINAL_AGGREGATE,
    groupBy,
    aggregates,
    partialAggregates,
    children: [child],
    physicalStrategy: PhysicalStrategy.HASH,
  };
}

export function LogicalMergeExchange(orderKeys: LogicalOrderKey[], limit: number | null | undefined, child: LogicalPlanNode): LogicalMergeExchangeNode {
  return {
    type: PlanNodeType.MERGE_EXCHANGE,
    orderKeys,
    limit: limit || null,
    children: [child],
  };
}

export function LogicalExchangeReceive(sourceFragmentIds: number[], schema?: ColumnInfo[]): LogicalExchangeReceiveNode {
  return {
    type: PlanNodeType.EXCHANGE_RECEIVE,
    sourceFragmentIds,
    schema: schema || [],
    children: [],
  };
}

export function LogicalSingleRow(): LogicalSingleRowNode {
  return { type: PlanNodeType.SINGLE_ROW, children: [] };
}

export function getChildren(node: LogicalPlanNode): LogicalPlanNode[] {
  return node.children || [];
}

export function setChildren<T extends LogicalPlanNode>(node: T, children: LogicalPlanNode[]): T {
  return { ...node, children } as T;
}

export function planToString(node: LogicalPlanNode, indent: number = 0): string {
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
    case PlanNodeType.WINDOW:
      str += `(${node.windowExprs.map(w => (w as BoundWindowNode).name).join(', ')})`;
      break;
    case PlanNodeType.TOP_N:
      str += `(${node.count}${node.offset ? `, offset=${node.offset}` : ''})`;
      break;
    case PlanNodeType.INDEX_SCAN:
      str += `(${node.table} using ${node.indexName})`;
      break;
    case PlanNodeType.EXCHANGE:
      str += `(${node.exchangeType})`;
      break;
    case PlanNodeType.PARTIAL_AGGREGATE:
      str += `(partial)`;
      break;
    case PlanNodeType.FINAL_AGGREGATE:
      str += `(final)`;
      break;
    case PlanNodeType.MERGE_EXCHANGE:
      str += `(${node.limit ? `limit=${node.limit}` : 'all'})`;
      break;
    case PlanNodeType.EXCHANGE_RECEIVE:
      str += `(fragments=[${node.sourceFragmentIds.join(',')}])`;
      break;
  }

  str += '\n';
  for (const child of getChildren(node)) {
    str += planToString(child, indent + 1);
  }
  return str;
}
