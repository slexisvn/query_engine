import { PlanNodeType, JoinType, LogicalExchangeReceive, getChildren, setChildren } from '../../planner/logical-plan.js';
import { Fragment, FragmentPlan, ExchangeType, resetFragmentIdCounter } from './fragment.js';
import { DistributionStrategy } from '../optimizer/distribution-aware-join.js';
import { ExchangePlacement } from './exchange-placement.js';
import { PartitionPruner } from '../partition/partition-pruner.js';
import { Config } from '../../config.js';

export class DistributedPlanner {
  constructor(partitionMap, clusterManager, statisticsMap, catalog = null) {
    this._partitionMap = partitionMap;
    this._clusterManager = clusterManager;
    this._exchangePlacement = new ExchangePlacement(partitionMap, statisticsMap);
    this._pruner = new PartitionPruner();
    this._catalog = catalog;
    this._fragments = [];
  }

  fragmentize(logicalPlan) {
    resetFragmentIdCounter();
    this._fragments = [];

    const coordinatorId = this._clusterManager.localNode.nodeId;
    const context = { coordinatorId };

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

  _placeGathers(node) {
    if (node.type === PlanNodeType.JOIN
      && (node._distributionStrategy === DistributionStrategy.BROADCAST_LEFT
        || node._distributionStrategy === DistributionStrategy.BROADCAST_RIGHT)) {
      const bc = this._buildBroadcastJoin(node);
      if (bc) return bc;
    }

    if (node.type === PlanNodeType.JOIN && this._isShufflePushableJoin(node)) {
      const shuffled = this._buildShuffleJoin(node);
      if (shuffled) return shuffled;
    }

    if (node.type === PlanNodeType.JOIN && this._isColocatedPushableJoin(node)) {
      const scan = this._findPartitionedScan(node);
      const partitionIds = this._pruner.prune(scan.table, null, this._partitionMap);
      const workerNodes = this._selectNodesForPartitions(scan.table, partitionIds, this._clusterManager.getWorkerNodes());
      if (workerNodes.length > 0) {
        const fragmentIds = [];
        const exchangeInputs = [];
        for (const nodeId of workerNodes) {
          const wf = new Fragment({
            planRoot: node,
            targetNodes: [nodeId],
            exchangeInputs: [],
            outputPartitioning: { exchangeType: 'gather', partitionCount: workerNodes.length },
            estimatedCardinality: Math.ceil((node._cardinality || 0) / workerNodes.length),
          });
          this._fragments.push(wf);
          fragmentIds.push(wf.fragmentId);
          exchangeInputs.push({ sourceFragmentId: wf.fragmentId, exchangeType: ExchangeType.GATHER });
        }
        return { plan: LogicalExchangeReceive(fragmentIds, this._joinOutputSchema(node)), exchangeInputs };
      }
    }

    if (this._isPushableSubtree(node)) {
      const scan = this._findPartitionedScan(node);
      const partitionIds = this._pruner.prune(scan.table, null, this._partitionMap);
      const workerNodes = this._selectNodesForPartitions(scan.table, partitionIds, this._clusterManager.getWorkerNodes());
      if (workerNodes.length === 0) return { plan: node, exchangeInputs: [] };

      const fragmentIds = [];
      const exchangeInputs = [];
      for (const nodeId of workerNodes) {
        const wf = new Fragment({
          planRoot: node,
          targetNodes: [nodeId],
          exchangeInputs: [],
          outputPartitioning: { exchangeType: 'gather', partitionCount: workerNodes.length },
          estimatedCardinality: Math.ceil((node._cardinality || 0) / workerNodes.length),
        });
        this._fragments.push(wf);
        fragmentIds.push(wf.fragmentId);
        exchangeInputs.push({ sourceFragmentId: wf.fragmentId, exchangeType: ExchangeType.GATHER });
      }
      return { plan: LogicalExchangeReceive(fragmentIds, this._deriveSubtreeSchema(node)), exchangeInputs };
    }

    const children = getChildren(node);
    if (children.length === 0) return { plan: node, exchangeInputs: [] };
    const newChildren = [];
    let exchangeInputs = [];
    for (const child of children) {
      const r = this._placeGathers(child);
      newChildren.push(r.plan);
      exchangeInputs = exchangeInputs.concat(r.exchangeInputs);
    }
    return { plan: setChildren(node, newChildren), exchangeInputs };
  }

  _isPushableSubtree(node) {
    const SAFE = new Set([PlanNodeType.SCAN, PlanNodeType.INDEX_SCAN, PlanNodeType.FILTER, PlanNodeType.PROJECT]);
    let hasPartitionedScan = false;
    const stack = [node];
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

  _findPartitionedScan(node) {
    const stack = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      if ((n.type === PlanNodeType.SCAN || n.type === PlanNodeType.INDEX_SCAN) && this._partitionMap.getTableInfo(n.table)) return n;
      for (const child of getChildren(n)) stack.push(child);
    }
    return null;
  }

  _buildBroadcastJoin(node) {
    // Only INNER broadcast is supported (the common fact⋈dim case). Outer broadcast falls
    // back to shuffle/gather to avoid preserved-side duplication and build-side ordering issues.
    if (node.joinType !== JoinType.INNER) return null;
    const broadcastLeft = node._distributionStrategy === DistributionStrategy.BROADCAST_LEFT;

    const leftChild = node.children[0];
    const rightChild = node.children[1];
    if (!this._isScanFilterSubtree(leftChild) || !this._isScanFilterSubtree(rightChild)) return null;

    const smallChild = broadcastLeft ? leftChild : rightChild;
    const bigChild = broadcastLeft ? rightChild : leftChild;
    const smallScan = this._findPartitionedScan(smallChild);
    const bigScan = this._findPartitionedScan(bigChild);
    const alive = this._clusterManager.getWorkerNodes();
    const smallWorkers = this._selectNodesForPartitions(smallScan.table, this._pruner.prune(smallScan.table, null, this._partitionMap), alive);
    const bigWorkers = this._selectNodesForPartitions(bigScan.table, this._pruner.prune(bigScan.table, null, this._partitionMap), alive);
    if (smallWorkers.length === 0 || bigWorkers.length === 0) return null;

    // A fragments: each small-side worker broadcasts its partition to all big-side (join) workers
    const aIds = [];
    for (const nodeId of smallWorkers) {
      const f = new Fragment({
        planRoot: smallChild,
        targetNodes: [nodeId],
        exchangeInputs: [],
        outputPartitioning: { exchangeType: 'broadcast', targetNodes: bigWorkers },
        estimatedCardinality: 0,
      });
      this._fragments.push(f);
      aIds.push(f.fragmentId);
    }
    const aInputs = aIds.map(id => ({ sourceFragmentId: id, exchangeType: ExchangeType.BROADCAST }));
    const recv = LogicalExchangeReceive(aIds, this._deriveSubtreeSchema(smallChild));
    const joinPlan = setChildren(node, broadcastLeft ? [recv, bigChild] : [bigChild, recv]);

    // C fragments: each big-side worker scans its local big partition and joins the full broadcast small side
    const rootInputs = [];
    const cIds = [];
    for (const nodeId of bigWorkers) {
      const f = new Fragment({
        planRoot: joinPlan,
        targetNodes: [nodeId],
        exchangeInputs: aInputs,
        outputPartitioning: { exchangeType: 'gather', partitionCount: bigWorkers.length },
        estimatedCardinality: 0,
      });
      this._fragments.push(f);
      cIds.push(f.fragmentId);
      rootInputs.push({ sourceFragmentId: f.fragmentId, exchangeType: ExchangeType.GATHER });
    }

    return { plan: LogicalExchangeReceive(cIds, this._joinOutputSchema(node)), exchangeInputs: rootInputs };
  }

  _isShufflePushableJoin(node) {
    if (node._distributionStrategy !== DistributionStrategy.SHUFFLE) return false;
    const jt = node.joinType;
    if (jt !== JoinType.INNER && jt !== JoinType.LEFT && jt !== JoinType.RIGHT && jt !== JoinType.FULL) return false;
    return this._isScanFilterSubtree(node.children[0]) && this._isScanFilterSubtree(node.children[1]);
  }

  _buildShuffleJoin(node) {
    const leftChild = node.children[0];
    const rightChild = node.children[1];
    const leftSchema = this._deriveSubtreeSchema(leftChild);
    const rightSchema = this._deriveSubtreeSchema(rightChild);
    const keys = this._extractShuffleKeyIndices(node.condition, leftSchema, rightSchema);
    if (!keys || keys.leftIdx.length === 0) return null;

    const leftScan = this._findPartitionedScan(leftChild);
    const rightScan = this._findPartitionedScan(rightChild);
    const alive = this._clusterManager.getWorkerNodes();
    const leftWorkers = this._selectNodesForPartitions(leftScan.table, this._pruner.prune(leftScan.table, null, this._partitionMap), alive);
    const rightWorkers = this._selectNodesForPartitions(rightScan.table, this._pruner.prune(rightScan.table, null, this._partitionMap), alive);
    if (leftWorkers.length === 0 || rightWorkers.length === 0) return null;

    const cWorkers = [...new Set([...leftWorkers, ...rightWorkers])];
    const W = cWorkers.length;

    const mkShuffleFrags = (subtree, workers, keyColumns) => {
      const ids = [];
      for (const nodeId of workers) {
        const f = new Fragment({
          planRoot: subtree,
          targetNodes: [nodeId],
          exchangeInputs: [],
          outputPartitioning: { exchangeType: 'hash_shuffle', partitionCount: W, targetNodes: cWorkers, keyColumns },
          estimatedCardinality: 0,
        });
        this._fragments.push(f);
        ids.push(f.fragmentId);
      }
      return ids;
    };

    const leftFragIds = mkShuffleFrags(leftChild, leftWorkers, keys.leftIdx);
    const rightFragIds = mkShuffleFrags(rightChild, rightWorkers, keys.rightIdx);

    const leftInputs = leftFragIds.map(id => ({ sourceFragmentId: id, exchangeType: ExchangeType.HASH_SHUFFLE }));
    const rightInputs = rightFragIds.map(id => ({ sourceFragmentId: id, exchangeType: ExchangeType.HASH_SHUFFLE }));
    const joinPlan = setChildren(node, [
      LogicalExchangeReceive(leftFragIds, leftSchema),
      LogicalExchangeReceive(rightFragIds, rightSchema),
    ]);

    const rootInputs = [];
    const cFragIds = [];
    for (const nodeId of cWorkers) {
      const f = new Fragment({
        planRoot: joinPlan,
        targetNodes: [nodeId],
        exchangeInputs: [...leftInputs, ...rightInputs],
        outputPartitioning: { exchangeType: 'gather', partitionCount: W },
        estimatedCardinality: 0,
      });
      this._fragments.push(f);
      cFragIds.push(f.fragmentId);
      rootInputs.push({ sourceFragmentId: f.fragmentId, exchangeType: ExchangeType.GATHER });
    }

    return { plan: LogicalExchangeReceive(cFragIds, this._joinOutputSchema(node)), exchangeInputs: rootInputs };
  }

  _extractShuffleKeyIndices(condition, leftSchema, rightSchema) {
    if (!condition) return null;
    const leftIdx = [];
    const rightIdx = [];
    const preds = this._splitAnd(condition);
    for (const pred of preds) {
      if (pred.op !== '=') continue;
      const a = pred.left, b = pred.right;
      if (a?.kind !== 'BoundColumnRef' || b?.kind !== 'BoundColumnRef') continue;
      let li = this._colIndexInSchema(a, leftSchema);
      let ri = this._colIndexInSchema(b, rightSchema);
      if (li < 0 || ri < 0) {
        li = this._colIndexInSchema(b, leftSchema);
        ri = this._colIndexInSchema(a, rightSchema);
      }
      if (li < 0 || ri < 0) return null;
      leftIdx.push(li);
      rightIdx.push(ri);
    }
    return leftIdx.length > 0 ? { leftIdx, rightIdx } : null;
  }

  _splitAnd(expr) {
    if (!expr) return [];
    if (expr.op === 'AND') return [...this._splitAnd(expr.left), ...this._splitAnd(expr.right)];
    return [expr];
  }

  _colIndexInSchema(ref, schema) {
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

  _isColocatedPushableJoin(node) {
    if (node._distributionStrategy !== DistributionStrategy.COLOCATED) return false;
    const jt = node.joinType;
    if (jt !== JoinType.INNER && jt !== JoinType.LEFT && jt !== JoinType.RIGHT && jt !== JoinType.FULL) return false;
    return this._isScanFilterSubtree(node.children[0]) && this._isScanFilterSubtree(node.children[1]);
  }

  _isScanFilterSubtree(node) {
    const SAFE = new Set([PlanNodeType.SCAN, PlanNodeType.INDEX_SCAN, PlanNodeType.FILTER]);
    let hasPartitionedScan = false;
    const stack = [node];
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

  _joinOutputSchema(node) {
    const buildChild = node._buildSide === 'right' ? node.children[1] : node.children[0];
    const probeChild = node._buildSide === 'right' ? node.children[0] : node.children[1];
    return [...this._deriveSubtreeSchema(buildChild), ...this._deriveSubtreeSchema(probeChild)];
  }

  _deriveSubtreeSchema(node) {
    if (node.type === PlanNodeType.FILTER) return this._deriveSubtreeSchema(node.children[0]);
    if (node.type === PlanNodeType.PROJECT) {
      return node.expressions.map((expr, i) => ({
        name: expr?.outputName || expr?.alias || expr?.name || expr?.columnName || `col${i}`,
        dataType: expr?.dataType || expr?.resultType || 'VARCHAR',
        tableAlias: '',
      }));
    }
    return this._scanOutputSchema(node);
  }

  _scanOutputSchema(node) {
    if (!this._catalog) return [];
    const storage = this._catalog.getTableStorage(node.table);
    if (!storage || typeof storage.getSchema !== 'function') return [];
    const tableSchema = storage.getSchema();
    const alias = node.alias || node.table;
    let cols = tableSchema;
    if (node.columns && node.columns.length > 0 && node.columns.length < tableSchema.length) {
      cols = node.columns
        .map(c => tableSchema.find(s => s.name.toUpperCase() === (c.name || c).toUpperCase()))
        .filter(Boolean);
    }
    return cols.map(c => ({ name: c.name, dataType: c.dataType, tableAlias: alias }));
  }

  _processNode(node, context) {
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

  _processScan(node, context) {
    const tableName = node.table;
    const tableInfo = this._partitionMap.getTableInfo(tableName);

    if (!tableInfo) {
      return { plan: node, exchangeInputs: [], workerNodes: [] };
    }

    const filter = this._findFilterAbove(node);
    const partitionIds = this._pruner.prune(tableName, filter, this._partitionMap);
    const workerNodes = this._clusterManager.getWorkerNodes();
    const targetNodes = this._selectNodesForPartitions(tableName, partitionIds, workerNodes);

    return {
      plan: node,
      exchangeInputs: [],
      workerNodes: targetNodes,
    };
  }

  _processJoin(node, context) {
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
        if (exchange.left.keys) input.keys = exchange.left.keys;
      }
    }

    if (exchange.right.type !== ExchangeType.PASSTHROUGH) {
      for (const input of rightResult.exchangeInputs) {
        input.exchangeType = exchange.right.type;
        if (exchange.right.keys) input.keys = exchange.right.keys;
      }
    }

    const newNode = {
      ...node,
      children: [leftResult.plan, rightResult.plan],
    };

    return { plan: newNode, exchangeInputs, workerNodes: [] };
  }

  _processPartialAggregate(node, context) {
    const childResult = this._processNode(node.children[0], context);
    const newNode = {
      ...node,
      children: [childResult.plan],
    };
    return {
      plan: newNode,
      exchangeInputs: childResult.exchangeInputs,
      workerNodes: childResult.workerNodes || [],
    };
  }

  _processFinalAggregate(node, context) {
    const childResult = this._processNode(node.children[0], context);
    const newNode = {
      ...node,
      children: [childResult.plan],
    };
    return { plan: newNode, exchangeInputs: childResult.exchangeInputs, workerNodes: [] };
  }

  _processExchange(node, context) {
    const childResult = this._processNode(node.children[0], context);
    const workerNodes = childResult.workerNodes || [];

    if (workerNodes.length === 0) {
      return { plan: childResult.plan, exchangeInputs: childResult.exchangeInputs, workerNodes: [] };
    }

    const workerPlan = childResult.plan;
    const exchangeInputs = [];
    const fragmentIds = [];

    for (const nodeId of workerNodes) {
      const workerFragment = new Fragment({
        planRoot: workerPlan,
        targetNodes: [nodeId],
        exchangeInputs: [],
        outputPartitioning: {
          exchangeType: node.exchangeType || 'gather',
          partitionCount: workerNodes.length,
        },
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

  _processMergeExchange(node, context) {
    const childResult = this._processNode(node.children[0], context);

    const exchangeInputs = childResult.exchangeInputs.map(input => ({
      ...input,
      exchangeType: ExchangeType.GATHER,
      ordered: true,
      orderKeys: node.orderKeys,
    }));

    const newNode = {
      ...node,
      children: [childResult.plan],
    };

    return { plan: newNode, exchangeInputs, workerNodes: [] };
  }

  _processGeneric(node, context) {
    const children = getChildren(node);
    if (children.length === 0) {
      return { plan: node, exchangeInputs: [], workerNodes: [] };
    }

    const childResults = children.map(child => this._processNode(child, context));
    const allExchangeInputs = [];
    const newChildren = [];
    let mergedWorkerNodes = [];

    for (const result of childResults) {
      newChildren.push(result.plan);
      allExchangeInputs.push(...result.exchangeInputs);
      if (result.workerNodes && result.workerNodes.length > 0) {
        mergedWorkerNodes = result.workerNodes;
      }
    }

    const newNode = { ...node, children: newChildren };
    return { plan: newNode, exchangeInputs: allExchangeInputs, workerNodes: mergedWorkerNodes };
  }

  _findFilterAbove(_node) {
    return null;
  }

  _selectNodesForPartitions(tableName, partitionIds, workerNodes) {
    if (workerNodes.length === 0) {
      throw new Error(`Table "${tableName}" is partitioned but no workers are available to scan it`);
    }

    const nodeSet = new Set();
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
