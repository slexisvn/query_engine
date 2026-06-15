export enum PhysicalNodeType {
  TABLE_SCAN = 'TableScan',
  FILTER = 'Filter',
  PROJECT = 'Project',
  HASH_JOIN = 'HashJoin',
  HASH_AGGREGATE = 'HashAggregate',
  SORT = 'Sort',
  LIMIT = 'Limit',
  TOP_N = 'TopN',
  DISTINCT = 'Distinct',
  UNION = 'Union',
  MATERIALIZE = 'Materialize',
  RESULT_SINK = 'ResultSink',
}
