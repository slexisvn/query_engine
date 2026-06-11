import { PlanNodeType, LogicalExchangeReceive, getChildren } from '../../planner/logical-plan.js';
import { Fragment, FragmentPlan, ExchangeType, resetFragmentIdCounter } from './fragment.js';
import { ExchangePlacement } from './exchange-placement.js';
import { PartitionPruner } from '../partition/partition-pruner.js';
import { Config } from '../../config.js';

export class DistributedPlanner {
  constructor(partitionMap, clusterManager, statisticsMap) {
    this._partitionMap = partitionMap;
    this._clusterManager = clusterManager;
    this._exchangePlacement = new ExchangePlacement(partitionMap, statisticsMap);
    this._pruner = new PartitionPruner();
    this._fragments = [];
  }

  fragmentize(logicalPlan) {
    resetFragmentIdCounter();
    this._fragments = [];

    const coordinatorId = this._clusterManager.localNode.nodeId;
    const context = { coordinatorId };

    const rootPlanRoot = this._processNode(logicalPlan, context);

    const rootFragment = new Fragment({
      planRoot: rootPlanRoot.plan,
      targetNodes: [coordinatorId],
      exchangeInputs: rootPlanRoot.exchangeInputs,
      outputPartitioning: null,
      estimatedCardinality: logicalPlan._cardinality || 0,
    });
    this._fragments.push(rootFragment);

    return new FragmentPlan(this._fragments, rootFragment.fragmentId);
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
