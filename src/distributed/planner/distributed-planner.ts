import { PlanNodeType, JoinType, LogicalExchangeReceive, getChildren, setChildren } from '../../planner/logical-plan.js';
import type {
  LogicalPlanNode,
  LogicalScanNode,
  LogicalIndexScanNode,
  LogicalJoinNode,
  LogicalExchangeNode,
  LogicalMergeExchangeNode,
  LogicalPartialAggregateNode,
  LogicalFinalAggregateNode,
} from '../../planner/logical-plan.js';
import { Fragment, FragmentPlan, ExchangeType } from './fragment.js';
import { DistributionStrategy } from '../optimizer/distribution-aware-join.js';
import { ExchangePlacement } from './exchange-placement.js';
import { PartitionPruner } from '../partition/partition-pruner.js';
import type {
  NodeId,
  PartitionId,
  FragmentId,
  FragmentizeContext,
  DistributedScanSchemaColumn,
  JoinShuffleKeyIndices,
  ExchangeInput,
  OutputPartitioning,
  FragmentProcessResult,
  GatherPlacementResult,
} from '../distributed-types.js';
import type { BoundExpr, BoundBinaryNode } from '../../binder/expression-binder.js';
import type { ColumnInfo } from '../../binder/scope.js';
import { splitConjuncts } from '../../binder/conjuncts.js';
import { capabilityOf, runsOnWorkers, preservesColocation, preservesPartitioning } from './operator-capability.js';
import { descriptorOf } from '../../planner/plan-node-descriptor.js';
import { projectedColumnName, projectedColumnAlias } from '../../planner/project-schema.js';
import { chooseJoinBuildSide } from '../../planner/join-build-side.js';
import type { DataType } from '../../storage/data-type.js';

interface OutputPartitioningLocal {
  exchangeType: string;
  partitionCount?: number;
  targetNodes?: NodeId[];
  keyColumns?: number[];
}

interface ExchangeSideKeysLike {
  keys?: BoundExpr[];
}

interface DistributionAnnotatedJoin {
  _distributionStrategy?: string;
  _distributionCost?: number;
}

interface TableScanNode {
  table: string;
}

interface ColumnRefLike {
  kind?: string;
  tableAlias?: string;
  columnName?: string;
  name?: string;
}

interface ProjectExprLike {
  outputName?: string;
  alias?: string;
  name?: string;
  columnName?: string;
  dataType?: DataType | null;
  resultType?: string | null;
}

interface NodeLike {
  nodeId: NodeId;
}

interface PartitionTableInfoLike {
  partitionCount: number;
  partitionKey: string | null;
}

interface PartitionMapLike {
  getTableInfo(tableName: string): PartitionTableInfoLike | null;
  getNodesForPartition(tableName: string, partitionId: PartitionId): NodeId[];
  isReplicated(tableName: string): boolean;
}

interface ClusterManagerLike {
  localNode: NodeLike;
  getWorkerNodes(): NodeLike[];
}

interface TableStorageLike {
  getSchema(): DistributedScanSchemaColumn[];
}

interface CatalogLike {
  getTableStorage(tableName: string): TableStorageLike | null | undefined;
}

interface StatisticsEntryLike {
  rowCount?: number;
  avgRowWidth?: number;
}

type ExchangePlacementCtorArg = ConstructorParameters<typeof ExchangePlacement>[0];
type ExchangePlacementStatsArg = ConstructorParameters<typeof ExchangePlacement>[1];
type PrunerPartitionMapArg = Parameters<PartitionPruner['prune']>[2];

function exchangeInputsOf(fragmentIds: FragmentId[], exchangeType: ExchangeType): ExchangeInput[] {
  return fragmentIds.map(sourceFragmentId => ({ sourceFragmentId, exchangeType }));
}

export class DistributedPlanner {
  _partitionMap: PartitionMapLike;
  _clusterManager: ClusterManagerLike;
  _exchangePlacement: ExchangePlacement;
  _pruner: PartitionPruner;
  _catalog: CatalogLike | null;
  _fragments: Fragment[];

  constructor(partitionMap: PartitionMapLike, clusterManager: ClusterManagerLike, statisticsMap: Map<string, StatisticsEntryLike>, catalog: CatalogLike | null = null) {
    this._partitionMap = partitionMap;
    this._clusterManager = clusterManager;
    this._exchangePlacement = new ExchangePlacement(partitionMap as ExchangePlacementCtorArg, statisticsMap as ExchangePlacementStatsArg);
    this._pruner = new PartitionPruner();
    this._catalog = catalog;
    this._fragments = [];
  }

  fragmentize(logicalPlan: LogicalPlanNode): FragmentPlan {
    this._fragments = [];

    const coordinatorId = this._clusterManager.localNode.nodeId;
    const context: FragmentizeContext = { coordinatorId };

    const rootPlanRoot = this._processNode(logicalPlan, context);

    const placed = this._placeGathers(rootPlanRoot.plan);
    const rootPlan = placed.plan;
    const rootExchangeInputs = (rootPlanRoot.exchangeInputs || []).concat(placed.exchangeInputs);

    const rootFragment = new Fragment({
      planRoot: rootPlan,
      targetNodes: [coordinatorId],
      exchangeInputs: rootExchangeInputs,
      outputPartitioning: null,
      estimatedCardinality: logicalPlan._cardinality || 0,
    });
    this._fragments.push(rootFragment);

    return new FragmentPlan(this._fragments, rootFragment.fragmentId);
  }

  _placeGathers(node: LogicalPlanNode): GatherPlacementResult {
    if (node.type === PlanNodeType.JOIN
      && ((node as DistributionAnnotatedJoin)._distributionStrategy === DistributionStrategy.BROADCAST_LEFT
        || (node as DistributionAnnotatedJoin)._distributionStrategy === DistributionStrategy.BROADCAST_RIGHT)) {
      const bc = this._buildBroadcastJoin(node);
      if (bc) return bc;
    }

    if (node.type === PlanNodeType.JOIN && this._isShufflePushableJoin(node)) {
      const shuffled = this._buildShuffleJoin(node);
      if (shuffled) return shuffled;
    }

    if (node.type === PlanNodeType.JOIN && this._isColocatedPushableJoin(node)) {
      const scan = this._findPartitionedScan(node);
      const partitionIds = this._pruner.prune((scan as TableScanNode).table, null, this._partitionMap as PrunerPartitionMapArg);
      const workerNodes = this._selectNodesForPartitions((scan as TableScanNode).table, partitionIds, this._clusterManager.getWorkerNodes());
      if (workerNodes.length > 0) {
        const fragmentIds: FragmentId[] = [];
        const exchangeInputs: ExchangeInput[] = [];
        for (const nodeId of workerNodes) {
          const wf = new Fragment({
            planRoot: node,
            targetNodes: [nodeId],
            exchangeInputs: [],
            outputPartitioning: { exchangeType: 'gather', partitionCount: workerNodes.length } as OutputPartitioningLocal as OutputPartitioning,
            estimatedCardinality: Math.ceil((node._cardinality || 0) / workerNodes.length),
          });
          this._fragments.push(wf);
          fragmentIds.push(wf.fragmentId);
          exchangeInputs.push({ sourceFragmentId: wf.fragmentId, exchangeType: ExchangeType.GATHER });
        }
        return { plan: LogicalExchangeReceive(fragmentIds, this._joinOutputSchema(node) as ColumnInfo[]), exchangeInputs };
      }
    }

    if (this._isPushableSubtree(node)) {
      const scan = this._findPartitionedScan(node);
      const partitionIds = this._pruner.prune((scan as TableScanNode).table, null, this._partitionMap as PrunerPartitionMapArg);
      const workerNodes = this._selectNodesForPartitions((scan as TableScanNode).table, partitionIds, this._clusterManager.getWorkerNodes());
      if (workerNodes.length === 0) return { plan: node, exchangeInputs: [] };

      const fragmentIds: FragmentId[] = [];
      const exchangeInputs: ExchangeInput[] = [];
      for (const nodeId of workerNodes) {
        const wf = new Fragment({
          planRoot: node,
          targetNodes: [nodeId],
          exchangeInputs: [],
          outputPartitioning: { exchangeType: 'gather', partitionCount: workerNodes.length } as OutputPartitioningLocal as OutputPartitioning,
          estimatedCardinality: Math.ceil((node._cardinality || 0) / workerNodes.length),
        });
        this._fragments.push(wf);
        fragmentIds.push(wf.fragmentId);
        exchangeInputs.push({ sourceFragmentId: wf.fragmentId, exchangeType: ExchangeType.GATHER });
      }
      return { plan: LogicalExchangeReceive(fragmentIds, this._deriveSubtreeSchema(node) as ColumnInfo[]), exchangeInputs };
    }

    const children = getChildren(node);
    if (children.length === 0) return { plan: node, exchangeInputs: [] };
    const newChildren: LogicalPlanNode[] = [];
    let exchangeInputs: ExchangeInput[] = [];
    for (const child of children) {
      const r = this._placeGathers(child);
      newChildren.push(r.plan);
      exchangeInputs = exchangeInputs.concat(r.exchangeInputs);
    }
    return { plan: setChildren(node, newChildren), exchangeInputs };
  }

  _isPushableSubtree(node: LogicalPlanNode): boolean {
    const SAFE = new Set<PlanNodeType>([PlanNodeType.SCAN, PlanNodeType.INDEX_SCAN, PlanNodeType.FILTER, PlanNodeType.PROJECT]);
    let hasPartitionedScan = false;
    const stack: LogicalPlanNode[] = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      if (!n || !SAFE.has(n.type)) return false;
      if ((n.type === PlanNodeType.SCAN || n.type === PlanNodeType.INDEX_SCAN) && this._partitionMap.getTableInfo(n.table)) {
        hasPartitionedScan = true;
      }
      for (const child of getChildren(n)) stack.push(child);
    }
    return hasPartitionedScan;
  }

  _findPartitionedScan(node: LogicalPlanNode): LogicalPlanNode | null {
    const stack: LogicalPlanNode[] = [node];
    while (stack.length > 0) {
      const n = stack.pop() as LogicalPlanNode;
      if ((n.type === PlanNodeType.SCAN || n.type === PlanNodeType.INDEX_SCAN) && this._partitionMap.getTableInfo(n.table)) return n;
      for (const child of getChildren(n)) stack.push(child);
    }
    return null;
  }

  _buildBroadcastJoin(node: LogicalJoinNode): GatherPlacementResult | null {
    if (node.joinType !== JoinType.INNER) return null;
    const broadcastLeft = (node as DistributionAnnotatedJoin)._distributionStrategy === DistributionStrategy.BROADCAST_LEFT;

    const leftChild = node.children[0];
    const rightChild = node.children[1];
    if (!this._isScanFilterSubtree(leftChild) || !this._isScanFilterSubtree(rightChild)) return null;

    const smallChild = broadcastLeft ? leftChild : rightChild;
    const bigChild = broadcastLeft ? rightChild : leftChild;
    const smallScan = this._findPartitionedScan(smallChild);
    const bigScan = this._findPartitionedScan(bigChild);
    const alive = this._clusterManager.getWorkerNodes();
    const smallWorkers = this._selectNodesForPartitions((smallScan as TableScanNode).table, this._pruner.prune((smallScan as TableScanNode).table, null, this._partitionMap as PrunerPartitionMapArg), alive);
    const bigWorkers = this._selectNodesForPartitions((bigScan as TableScanNode).table, this._pruner.prune((bigScan as TableScanNode).table, null, this._partitionMap as PrunerPartitionMapArg), alive);
    if (smallWorkers.length === 0 || bigWorkers.length === 0) return null;

    const broadcastIds = this._spawnFragments(smallChild, smallWorkers, [],
      () => ({ exchangeType: 'broadcast', targetNodes: bigWorkers } as OutputPartitioningLocal as OutputPartitioning));
    const broadcastInputs = exchangeInputsOf(broadcastIds, ExchangeType.BROADCAST);
    const recv = LogicalExchangeReceive(broadcastIds, this._deriveSubtreeSchema(smallChild) as ColumnInfo[]);
    const joinPlan = setChildren(node, broadcastLeft ? [recv, bigChild] : [bigChild, recv]);

    const joinIds = this._spawnFragments(joinPlan, bigWorkers, broadcastInputs,
      () => ({ exchangeType: 'gather', partitionCount: bigWorkers.length } as OutputPartitioningLocal as OutputPartitioning));

    return {
      plan: LogicalExchangeReceive(joinIds, this._joinOutputSchema(node) as ColumnInfo[]),
      exchangeInputs: exchangeInputsOf(joinIds, ExchangeType.GATHER),
    };
  }

  _spawnFragments(
    planRoot: LogicalPlanNode,
    workers: NodeId[],
    exchangeInputs: ExchangeInput[],
    outputPartitioning: () => OutputPartitioning
  ): FragmentId[] {
    const ids: FragmentId[] = [];
    for (const nodeId of workers) {
      const fragment = new Fragment({
        planRoot,
        targetNodes: [nodeId],
        exchangeInputs,
        outputPartitioning: outputPartitioning(),
        estimatedCardinality: 0,
      });
      this._fragments.push(fragment);
      ids.push(fragment.fragmentId);
    }
    return ids;
  }

  _isShufflePushableJoin(node: LogicalJoinNode): boolean {
    if ((node as DistributionAnnotatedJoin)._distributionStrategy !== DistributionStrategy.SHUFFLE) return false;
    const jt = node.joinType;
    if (jt !== JoinType.INNER && jt !== JoinType.LEFT && jt !== JoinType.RIGHT && jt !== JoinType.FULL) return false;
    return this._isScanFilterSubtree(node.children[0]) && this._isScanFilterSubtree(node.children[1]);
  }

  _buildShuffleJoin(node: LogicalJoinNode): GatherPlacementResult | null {
    const leftChild = node.children[0];
    const rightChild = node.children[1];
    const leftSchema = this._deriveSubtreeSchema(leftChild);
    const rightSchema = this._deriveSubtreeSchema(rightChild);
    const keys = this._extractShuffleKeyIndices(node.condition, leftSchema, rightSchema);
    if (!keys || keys.leftIdx.length === 0) return null;

    const leftScan = this._findPartitionedScan(leftChild);
    const rightScan = this._findPartitionedScan(rightChild);
    const alive = this._clusterManager.getWorkerNodes();
    const leftWorkers = this._selectNodesForPartitions((leftScan as TableScanNode).table, this._pruner.prune((leftScan as TableScanNode).table, null, this._partitionMap as PrunerPartitionMapArg), alive);
    const rightWorkers = this._selectNodesForPartitions((rightScan as TableScanNode).table, this._pruner.prune((rightScan as TableScanNode).table, null, this._partitionMap as PrunerPartitionMapArg), alive);
    if (leftWorkers.length === 0 || rightWorkers.length === 0) return null;

    const joinWorkers = [...new Set([...leftWorkers, ...rightWorkers])];
    const joinWorkerCount = joinWorkers.length;

    const shuffleSideFragments = (subtree: LogicalPlanNode, workers: NodeId[], keyColumns: number[]): FragmentId[] =>
      this._spawnFragments(subtree, workers, [],
        () => ({ exchangeType: 'hash_shuffle', partitionCount: joinWorkerCount, targetNodes: joinWorkers, keyColumns } as OutputPartitioningLocal as OutputPartitioning));

    const leftFragIds = shuffleSideFragments(leftChild, leftWorkers, keys.leftIdx);
    const rightFragIds = shuffleSideFragments(rightChild, rightWorkers, keys.rightIdx);

    const leftInputs = exchangeInputsOf(leftFragIds, ExchangeType.HASH_SHUFFLE);
    const rightInputs = exchangeInputsOf(rightFragIds, ExchangeType.HASH_SHUFFLE);
    const joinPlan = setChildren(node, [
      LogicalExchangeReceive(leftFragIds, leftSchema as ColumnInfo[]),
      LogicalExchangeReceive(rightFragIds, rightSchema as ColumnInfo[]),
    ]);

    const joinIds = this._spawnFragments(joinPlan, joinWorkers, [...leftInputs, ...rightInputs],
      () => ({ exchangeType: 'gather', partitionCount: joinWorkerCount } as OutputPartitioningLocal as OutputPartitioning));

    return {
      plan: LogicalExchangeReceive(joinIds, this._joinOutputSchema(node) as ColumnInfo[]),
      exchangeInputs: exchangeInputsOf(joinIds, ExchangeType.GATHER),
    };
  }

  _extractShuffleKeyIndices(condition: BoundExpr | null, leftSchema: DistributedScanSchemaColumn[], rightSchema: DistributedScanSchemaColumn[]): JoinShuffleKeyIndices | null {
    if (!condition) return null;
    const leftIdx: number[] = [];
    const rightIdx: number[] = [];
    const preds = splitConjuncts(condition);
    for (const pred of preds) {
      if ((pred as BoundBinaryNode).op !== '=') continue;
      const a = (pred as BoundBinaryNode).left, b = (pred as BoundBinaryNode).right;
      if ((a as ColumnRefLike)?.kind !== 'BoundColumnRef' || (b as ColumnRefLike)?.kind !== 'BoundColumnRef') continue;
      let li = this._colIndexInSchema(a as ColumnRefLike, leftSchema);
      let ri = this._colIndexInSchema(b as ColumnRefLike, rightSchema);
      if (li < 0 || ri < 0) {
        li = this._colIndexInSchema(b as ColumnRefLike, leftSchema);
        ri = this._colIndexInSchema(a as ColumnRefLike, rightSchema);
      }
      if (li < 0 || ri < 0) return null;
      leftIdx.push(li);
      rightIdx.push(ri);
    }
    return leftIdx.length > 0 ? { leftIdx, rightIdx } : null;
  }

  _colIndexInSchema(ref: ColumnRefLike, schema: DistributedScanSchemaColumn[]): number {
    const alias = (ref.tableAlias || '').toUpperCase();
    const name = (ref.columnName || ref.name || '').toUpperCase();
    for (let i = 0; i < schema.length; i++) {
      if (schema[i].name.toUpperCase() === name && (schema[i].tableAlias || '').toUpperCase() === alias) return i;
    }
    if (alias) return -1;
    for (let i = 0; i < schema.length; i++) {
      if (schema[i].name.toUpperCase() === name) return i;
    }
    return -1;
  }

  _isColocatedPushableJoin(node: LogicalJoinNode): boolean {
    if ((node as DistributionAnnotatedJoin)._distributionStrategy !== DistributionStrategy.COLOCATED) return false;
    const jt = node.joinType;
    if (jt !== JoinType.INNER && jt !== JoinType.LEFT && jt !== JoinType.RIGHT && jt !== JoinType.FULL) return false;
    if (!this._isWorkerLocalSubtree(node.children[0]) || !this._isWorkerLocalSubtree(node.children[1])) return false;
    return this._findPartitionedScan(node) !== null;
  }

  _isWorkerLocalSubtree(node: LogicalPlanNode): boolean {
    const SAFE = new Set<PlanNodeType>([PlanNodeType.SCAN, PlanNodeType.INDEX_SCAN, PlanNodeType.FILTER]);
    let scanCount = 0;
    const stack: LogicalPlanNode[] = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      if (!n || !SAFE.has(n.type)) return false;
      if (n.type === PlanNodeType.SCAN || n.type === PlanNodeType.INDEX_SCAN) {
        scanCount++;
        if (!this._partitionMap.getTableInfo(n.table) && !this._partitionMap.isReplicated(n.table)) return false;
      }
      for (const child of getChildren(n)) stack.push(child);
    }
    return scanCount > 0;
  }

  _isScanFilterSubtree(node: LogicalPlanNode): boolean {
    const SAFE = new Set<PlanNodeType>([PlanNodeType.SCAN, PlanNodeType.INDEX_SCAN, PlanNodeType.FILTER]);
    let hasPartitionedScan = false;
    const stack: LogicalPlanNode[] = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      if (!n || !SAFE.has(n.type)) return false;
      if ((n.type === PlanNodeType.SCAN || n.type === PlanNodeType.INDEX_SCAN) && this._partitionMap.getTableInfo(n.table)) {
        hasPartitionedScan = true;
      }
      for (const child of getChildren(n)) stack.push(child);
    }
    return hasPartitionedScan;
  }

  _joinOutputSchema(node: LogicalJoinNode): DistributedScanSchemaColumn[] {
    const buildSide = chooseJoinBuildSide(
      node.joinType,
      node.children[0]._cardinality ?? 0,
      node.children[1]._cardinality ?? 0,
    );
    const buildChild = buildSide === 'right' ? node.children[1] : node.children[0];
    const probeChild = buildSide === 'right' ? node.children[0] : node.children[1];
    return [...this._deriveSubtreeSchema(buildChild), ...this._deriveSubtreeSchema(probeChild)];
  }

  _deriveSubtreeSchema(node: LogicalPlanNode): DistributedScanSchemaColumn[] {
    if (descriptorOf(node.type).preservesSchema) return this._deriveSubtreeSchema(getChildren(node)[0]);
    if (node.type === PlanNodeType.PROJECT) {
      return node.expressions.map((expr, i): DistributedScanSchemaColumn => {
        const name = projectedColumnName(expr, i);
        return {
          name,
          dataType: (expr as ProjectExprLike)?.dataType || (expr as ProjectExprLike)?.resultType || 'VARCHAR',
          tableAlias: projectedColumnAlias(expr, name, node.outputAlias || ''),
        };
      });
    }
    if (node.type === PlanNodeType.SCAN || node.type === PlanNodeType.INDEX_SCAN) return this._scanOutputSchema(node);
    return [];
  }

  _scanOutputSchema(node: LogicalScanNode | LogicalIndexScanNode): DistributedScanSchemaColumn[] {
    if (!this._catalog) return [];
    const storage = this._catalog.getTableStorage(node.table);
    if (!storage || typeof storage.getSchema !== 'function') return [];
    const tableSchema = storage.getSchema();
    const alias = node.alias || node.table;
    let cols: DistributedScanSchemaColumn[] = tableSchema;
    if (node.columns && node.columns.length > 0 && node.columns.length < tableSchema.length) {
      const byName = new Map<string, DistributedScanSchemaColumn>();
      for (const column of tableSchema) {
        const key = column.name.toUpperCase();
        if (!byName.has(key)) byName.set(key, column);
      }
      cols = node.columns
        .map(c => byName.get(((c.name || c) as string).toUpperCase()))
        .filter(Boolean) as DistributedScanSchemaColumn[];
    }
    return cols.map((c): DistributedScanSchemaColumn => ({ name: c.name, dataType: c.dataType, tableAlias: alias }));
  }

  _processNode(node: LogicalPlanNode, context: FragmentizeContext): FragmentProcessResult {
    switch (node.type) {
      case PlanNodeType.SCAN:
      case PlanNodeType.INDEX_SCAN:
        return this._processScan(node, context);

      case PlanNodeType.JOIN:
        return this._processJoin(node, context);

      case PlanNodeType.PARTIAL_AGGREGATE:
        return this._processPartialAggregate(node, context);

      case PlanNodeType.FINAL_AGGREGATE:
        return this._processFinalAggregate(node, context);

      case PlanNodeType.EXCHANGE:
        return this._processExchange(node, context);

      case PlanNodeType.MERGE_EXCHANGE:
        return this._processMergeExchange(node, context);

      default:
        return this._processGeneric(node, context);
    }
  }

  _processScan(node: LogicalScanNode | LogicalIndexScanNode, context: FragmentizeContext): FragmentProcessResult {
    const tableName = node.table;
    const tableInfo = this._partitionMap.getTableInfo(tableName);

    if (!tableInfo) {
      return { plan: node, exchangeInputs: [], workerNodes: [] };
    }

    const partitionIds = this._pruner.prune(tableName, context.scanFilter ?? null, this._partitionMap as PrunerPartitionMapArg);
    const workerNodes = this._clusterManager.getWorkerNodes();
    const targetNodes = this._selectNodesForPartitions(tableName, partitionIds, workerNodes);

    return {
      plan: node,
      exchangeInputs: [],
      workerNodes: targetNodes,
      groupsColocated: false,
    };
  }

  _processJoin(node: LogicalJoinNode, context: FragmentizeContext): FragmentProcessResult {
    const leftResult = this._processNode(node.children[0], this._contextForChild(node, node.children[0], context));
    const rightResult = this._processNode(node.children[1], this._contextForChild(node, node.children[1], context));

    const exchange = this._exchangePlacement.determineJoinExchange(node);

    const exchangeInputs = [
      ...leftResult.exchangeInputs,
      ...rightResult.exchangeInputs,
    ];

    if (exchange.left.type !== ExchangeType.PASSTHROUGH) {
      for (const input of leftResult.exchangeInputs) {
        input.exchangeType = exchange.left.type;
        if ((exchange.left as ExchangeSideKeysLike).keys) input.keys = (exchange.left as ExchangeSideKeysLike).keys;
      }
    }

    if (exchange.right.type !== ExchangeType.PASSTHROUGH) {
      for (const input of rightResult.exchangeInputs) {
        input.exchangeType = exchange.right.type;
        if ((exchange.right as ExchangeSideKeysLike).keys) input.keys = (exchange.right as ExchangeSideKeysLike).keys;
      }
    }

    const newNode = {
      ...node,
      children: [leftResult.plan, rightResult.plan],
    };
    const colocated = this._isColocatedPushableJoin(node);

    return {
      plan: newNode as LogicalPlanNode,
      exchangeInputs,
      workerNodes: colocated
        ? (leftResult.workerNodes?.length ? leftResult.workerNodes : (rightResult.workerNodes ?? []))
        : [],
      groupsColocated: colocated,
    };
  }

  _processPartialAggregate(node: LogicalPartialAggregateNode, context: FragmentizeContext): FragmentProcessResult {
    const childResult = this._processNode(node.children[0], this._contextForChild(node, node.children[0], context));
    const newNode = {
      ...node,
      children: [childResult.plan],
    };
    return {
      plan: newNode as LogicalPlanNode,
      exchangeInputs: childResult.exchangeInputs,
      workerNodes: childResult.workerNodes || [],
    };
  }

  _processFinalAggregate(node: LogicalFinalAggregateNode, context: FragmentizeContext): FragmentProcessResult {
    const childResult = this._processNode(node.children[0], this._contextForChild(node, node.children[0], context));
    const newNode = {
      ...node,
      children: [childResult.plan],
    };
    return { plan: newNode as LogicalPlanNode, exchangeInputs: childResult.exchangeInputs, workerNodes: [] };
  }

  _processExchange(node: LogicalExchangeNode, context: FragmentizeContext): FragmentProcessResult {
    const childResult = this._processNode(node.children[0], this._combiningContext(node, context));
    const workerNodes = childResult.workerNodes || [];

    if (workerNodes.length === 0) {
      return { plan: childResult.plan, exchangeInputs: childResult.exchangeInputs, workerNodes: [] };
    }

    const workerPlan = childResult.plan;
    const exchangeInputs: ExchangeInput[] = [];
    const fragmentIds: FragmentId[] = [];

    for (const nodeId of workerNodes) {
      const workerFragment = new Fragment({
        planRoot: workerPlan,
        targetNodes: [nodeId],
        exchangeInputs: [],
        outputPartitioning: {
          exchangeType: node.exchangeType || 'gather',
          partitionCount: workerNodes.length,
        } as OutputPartitioningLocal as OutputPartitioning,
        estimatedCardinality: Math.ceil((node._cardinality || 0) / workerNodes.length),
      });
      this._fragments.push(workerFragment);
      fragmentIds.push(workerFragment.fragmentId);

      exchangeInputs.push({
        sourceFragmentId: workerFragment.fragmentId,
        exchangeType: ExchangeType.GATHER,
      });
    }

    const receiveNode = LogicalExchangeReceive(fragmentIds, this._deriveSubtreeSchema(workerPlan) as ColumnInfo[]);

    return { plan: receiveNode, exchangeInputs, workerNodes: [] };
  }

  _processMergeExchange(node: LogicalMergeExchangeNode, context: FragmentizeContext): FragmentProcessResult {
    const childResult = this._processNode(node.children[0], this._combiningContext(node, context));

    const exchangeInputs: ExchangeInput[] = childResult.exchangeInputs.map(input => ({
      ...input,
      exchangeType: ExchangeType.GATHER,
      ordered: true,
      orderKeys: node.orderKeys,
    }));

    const newNode = {
      ...node,
      children: [childResult.plan],
    };

    return { plan: newNode as LogicalPlanNode, exchangeInputs, workerNodes: [] };
  }

  _contextForChild(parent: LogicalPlanNode, child: LogicalPlanNode, context: FragmentizeContext): FragmentizeContext {
    const combinedAbove = context.combinedAbove === true && preservesPartitioning(capabilityOf(parent.type));
    const scansDirectly = child.type === PlanNodeType.SCAN || child.type === PlanNodeType.INDEX_SCAN;
    if (parent.type === PlanNodeType.FILTER && scansDirectly) {
      return { ...context, scanFilter: parent.condition, combinedAbove };
    }
    return { ...context, scanFilter: context.scanFilter === undefined ? undefined : null, combinedAbove };
  }

  _combiningContext(node: LogicalPlanNode, context: FragmentizeContext): FragmentizeContext {
    return { ...this._contextForChild(node, getChildren(node)[0], context), combinedAbove: true };
  }

  _processGeneric(node: LogicalPlanNode, context: FragmentizeContext): FragmentProcessResult {
    const children = getChildren(node);
    if (children.length === 0) {
      return { plan: node, exchangeInputs: [], workerNodes: [] };
    }

    const childResults = children.map(child => this._processNode(child, this._contextForChild(node, child, context)));
    const allExchangeInputs: ExchangeInput[] = [];
    const newChildren: LogicalPlanNode[] = [];
    let mergedWorkerNodes: NodeId[] = [];
    let childGroupsColocated = false;

    for (const result of childResults) {
      newChildren.push(result.plan);
      allExchangeInputs.push(...result.exchangeInputs);
      if (result.workerNodes && result.workerNodes.length > 0) {
        mergedWorkerNodes = result.workerNodes;
        childGroupsColocated = result.groupsColocated === true;
      }
    }

    const capability = capabilityOf(node.type);
    const placeOnWorkers = runsOnWorkers(capability, {
      combinedAbove: context.combinedAbove === true,
      groupsColocated: childGroupsColocated,
    });

    return {
      plan: { ...node, children: newChildren } as LogicalPlanNode,
      exchangeInputs: allExchangeInputs,
      workerNodes: placeOnWorkers ? mergedWorkerNodes : [],
      groupsColocated: placeOnWorkers && preservesColocation(capability, childGroupsColocated),
    };
  }

  _selectNodesForPartitions(tableName: string, partitionIds: Set<PartitionId>, workerNodes: NodeLike[]): NodeId[] {
    if (workerNodes.length === 0) {
      throw new Error(`Table "${tableName}" is partitioned but no workers are available to scan it`);
    }

    const nodeSet = new Set<NodeId>();
    for (const pid of partitionIds) {
      const nodes = this._partitionMap.getNodesForPartition(tableName, pid);
      if (nodes.length > 0) {
        nodeSet.add(nodes[0]);
      }
    }

    if (nodeSet.size === 0) {
      return workerNodes.map(n => n.nodeId);
    }

    return [...nodeSet];
  }
}
