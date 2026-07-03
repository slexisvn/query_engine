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
import { Fragment, FragmentPlan, ExchangeType, resetFragmentIdCounter } from './fragment.js';
import { DistributionStrategy } from '../optimizer/distribution-aware-join.js';
import { ExchangePlacement } from './exchange-placement.js';
import { PartitionPruner } from '../partition/partition-pruner.js';
import { Config } from '../../config.js';
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
import { splitAnd } from './expr-utils.js';

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
  dataType?: string | null;
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
    resetFragmentIdCounter();
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
    // Only INNER broadcast is supported (the common fact⋈dim case). Outer broadcast falls
    // back to shuffle/gather to avoid preserved-side duplication and build-side ordering issues.
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

    // A fragments: each small-side worker broadcasts its partition to all big-side (join) workers
    const aIds: FragmentId[] = [];
    for (const nodeId of smallWorkers) {
      const f = new Fragment({
        planRoot: smallChild,
        targetNodes: [nodeId],
        exchangeInputs: [],
        outputPartitioning: { exchangeType: 'broadcast', targetNodes: bigWorkers } as OutputPartitioningLocal as OutputPartitioning,
        estimatedCardinality: 0,
      });
      this._fragments.push(f);
      aIds.push(f.fragmentId);
    }
    const aInputs: ExchangeInput[] = aIds.map(id => ({ sourceFragmentId: id, exchangeType: ExchangeType.BROADCAST }));
    const recv = LogicalExchangeReceive(aIds, this._deriveSubtreeSchema(smallChild) as ColumnInfo[]);
    const joinPlan = setChildren(node, broadcastLeft ? [recv, bigChild] : [bigChild, recv]);

    // C fragments: each big-side worker scans its local big partition and joins the full broadcast small side
    const rootInputs: ExchangeInput[] = [];
    const cIds: FragmentId[] = [];
    for (const nodeId of bigWorkers) {
      const f = new Fragment({
        planRoot: joinPlan,
        targetNodes: [nodeId],
        exchangeInputs: aInputs,
        outputPartitioning: { exchangeType: 'gather', partitionCount: bigWorkers.length } as OutputPartitioningLocal as OutputPartitioning,
        estimatedCardinality: 0,
      });
      this._fragments.push(f);
      cIds.push(f.fragmentId);
      rootInputs.push({ sourceFragmentId: f.fragmentId, exchangeType: ExchangeType.GATHER });
    }

    return { plan: LogicalExchangeReceive(cIds, this._joinOutputSchema(node) as ColumnInfo[]), exchangeInputs: rootInputs };
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

    const cWorkers = [...new Set([...leftWorkers, ...rightWorkers])];
    const W = cWorkers.length;

    const mkShuffleFrags = (subtree: LogicalPlanNode, workers: NodeId[], keyColumns: number[]): FragmentId[] => {
      const ids: FragmentId[] = [];
      for (const nodeId of workers) {
        const f = new Fragment({
          planRoot: subtree,
          targetNodes: [nodeId],
          exchangeInputs: [],
          outputPartitioning: { exchangeType: 'hash_shuffle', partitionCount: W, targetNodes: cWorkers, keyColumns } as OutputPartitioningLocal as OutputPartitioning,
          estimatedCardinality: 0,
        });
        this._fragments.push(f);
        ids.push(f.fragmentId);
      }
      return ids;
    };

    const leftFragIds = mkShuffleFrags(leftChild, leftWorkers, keys.leftIdx);
    const rightFragIds = mkShuffleFrags(rightChild, rightWorkers, keys.rightIdx);

    const leftInputs: ExchangeInput[] = leftFragIds.map(id => ({ sourceFragmentId: id, exchangeType: ExchangeType.HASH_SHUFFLE }));
    const rightInputs: ExchangeInput[] = rightFragIds.map(id => ({ sourceFragmentId: id, exchangeType: ExchangeType.HASH_SHUFFLE }));
    const joinPlan = setChildren(node, [
      LogicalExchangeReceive(leftFragIds, leftSchema as ColumnInfo[]),
      LogicalExchangeReceive(rightFragIds, rightSchema as ColumnInfo[]),
    ]);

    const rootInputs: ExchangeInput[] = [];
    const cFragIds: FragmentId[] = [];
    for (const nodeId of cWorkers) {
      const f = new Fragment({
        planRoot: joinPlan,
        targetNodes: [nodeId],
        exchangeInputs: [...leftInputs, ...rightInputs],
        outputPartitioning: { exchangeType: 'gather', partitionCount: W } as OutputPartitioningLocal as OutputPartitioning,
        estimatedCardinality: 0,
      });
      this._fragments.push(f);
      cFragIds.push(f.fragmentId);
      rootInputs.push({ sourceFragmentId: f.fragmentId, exchangeType: ExchangeType.GATHER });
    }

    return { plan: LogicalExchangeReceive(cFragIds, this._joinOutputSchema(node) as ColumnInfo[]), exchangeInputs: rootInputs };
  }

  _extractShuffleKeyIndices(condition: BoundExpr | null, leftSchema: DistributedScanSchemaColumn[], rightSchema: DistributedScanSchemaColumn[]): JoinShuffleKeyIndices | null {
    if (!condition) return null;
    const leftIdx: number[] = [];
    const rightIdx: number[] = [];
    const preds = splitAnd(condition);
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
    return this._isScanFilterSubtree(node.children[0]) && this._isScanFilterSubtree(node.children[1]);
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
    const buildChild = node._buildSide === 'right' ? node.children[1] : node.children[0];
    const probeChild = node._buildSide === 'right' ? node.children[0] : node.children[1];
    return [...this._deriveSubtreeSchema(buildChild), ...this._deriveSubtreeSchema(probeChild)];
  }

  _deriveSubtreeSchema(node: LogicalPlanNode): DistributedScanSchemaColumn[] {
    if (node.type === PlanNodeType.FILTER) return this._deriveSubtreeSchema(node.children[0]);
    if (node.type === PlanNodeType.PROJECT) {
      return node.expressions.map((expr, i): DistributedScanSchemaColumn => ({
        name: (expr as ProjectExprLike)?.outputName || (expr as ProjectExprLike)?.alias || (expr as ProjectExprLike)?.name || (expr as ProjectExprLike)?.columnName || `col${i}`,
        dataType: (expr as ProjectExprLike)?.dataType || (expr as ProjectExprLike)?.resultType || 'VARCHAR',
        tableAlias: '',
      }));
    }
    return this._scanOutputSchema(node as LogicalScanNode);
  }

  _scanOutputSchema(node: LogicalScanNode): DistributedScanSchemaColumn[] {
    if (!this._catalog) return [];
    const storage = this._catalog.getTableStorage(node.table);
    if (!storage || typeof storage.getSchema !== 'function') return [];
    const tableSchema = storage.getSchema();
    const alias = node.alias || node.table;
    let cols: DistributedScanSchemaColumn[] = tableSchema;
    if (node.columns && node.columns.length > 0 && node.columns.length < tableSchema.length) {
      cols = node.columns
        .map(c => tableSchema.find(s => s.name.toUpperCase() === ((c.name || c) as string).toUpperCase()))
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

    const filter = this._findFilterAbove(node);
    const partitionIds = this._pruner.prune(tableName, filter, this._partitionMap as PrunerPartitionMapArg);
    const workerNodes = this._clusterManager.getWorkerNodes();
    const targetNodes = this._selectNodesForPartitions(tableName, partitionIds, workerNodes);

    return {
      plan: node,
      exchangeInputs: [],
      workerNodes: targetNodes,
    };
  }

  _processJoin(node: LogicalJoinNode, context: FragmentizeContext): FragmentProcessResult {
    const leftResult = this._processNode(node.children[0], context);
    const rightResult = this._processNode(node.children[1], context);

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

    return { plan: newNode as LogicalPlanNode, exchangeInputs, workerNodes: [] };
  }

  _processPartialAggregate(node: LogicalPartialAggregateNode, context: FragmentizeContext): FragmentProcessResult {
    const childResult = this._processNode(node.children[0], context);
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
    const childResult = this._processNode(node.children[0], context);
    const newNode = {
      ...node,
      children: [childResult.plan],
    };
    return { plan: newNode as LogicalPlanNode, exchangeInputs: childResult.exchangeInputs, workerNodes: [] };
  }

  _processExchange(node: LogicalExchangeNode, context: FragmentizeContext): FragmentProcessResult {
    const childResult = this._processNode(node.children[0], context);
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

    const receiveNode = LogicalExchangeReceive(fragmentIds, []);

    return { plan: receiveNode, exchangeInputs, workerNodes: [] };
  }

  _processMergeExchange(node: LogicalMergeExchangeNode, context: FragmentizeContext): FragmentProcessResult {
    const childResult = this._processNode(node.children[0], context);

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

  _processGeneric(node: LogicalPlanNode, context: FragmentizeContext): FragmentProcessResult {
    const children = getChildren(node);
    if (children.length === 0) {
      return { plan: node, exchangeInputs: [], workerNodes: [] };
    }

    const childResults = children.map(child => this._processNode(child, context));
    const allExchangeInputs: ExchangeInput[] = [];
    const newChildren: LogicalPlanNode[] = [];
    let mergedWorkerNodes: NodeId[] = [];

    for (const result of childResults) {
      newChildren.push(result.plan);
      allExchangeInputs.push(...result.exchangeInputs);
      if (result.workerNodes && result.workerNodes.length > 0) {
        mergedWorkerNodes = result.workerNodes;
      }
    }

    const newNode = { ...node, children: newChildren };
    return { plan: newNode as LogicalPlanNode, exchangeInputs: allExchangeInputs, workerNodes: mergedWorkerNodes };
  }

  _findFilterAbove(_node: LogicalPlanNode): BoundExpr | null {
    return null;
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
