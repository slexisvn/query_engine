# 48. Partitioning and partition pruning

> After this chapter you will be able to compare partition placement, pruning, and distributed join strategies, including the current startup-path limitations.

## The question

Two workers, half the orders and half the customers on each. Counting works:

```
+------------+
| count_star |
+------------+
| 240000     |
+------------+
1 row(s) returned.

Executed in 114.63 ms [2 worker(s)]
```

Join the two tables and the query does not slow down — it dies:

```
coord> SELECT COUNT(*) FROM ORDERS o JOIN CUSTOMER c ON c.C_CUSTKEY = o.O_CUSTKEY;
Fragment 1 failed after 3 retries: Unknown node: worker-9611
```

The worker's own log is more revealing — it received the fragment, ran it, and failed on the way out:

```
[fragment] Received fragment 1
[fragment] Fragment 1 failed: Unknown node: worker-9611
```

`worker-9611` is that worker's own id. It could not find *itself*.

## Who holds which rows

[`PartitionMap`](../../src/distributed/partition/partition-map.ts) is the coordinator's model of data placement. Per table it stores a strategy, a partition count, a partition key, and a placement map from partition id to node ids:

```typescript
this._tables.set(upper, {
  strategy,
  partitionCount,
  partitionKey: strategy._partitionKey || null,
  placements: placementMap,
});
```

There are three strategies in [`partition-strategy.ts`](../../src/distributed/partition/partition-strategy.ts). [`HashPartitionStrategy`](../../src/distributed/partition/partition-strategy.ts) hashes a normalized key with murmur3 and takes it modulo the partition count. [`RangePartitionStrategy`](../../src/distributed/partition/partition-strategy.ts) binary-searches a sorted boundary array. [`RoundRobinPartitionStrategy`](../../src/distributed/partition/partition-strategy.ts) ignores the value entirely and uses the row index.

The CLI registers the third one. [`src/cli/coordinator.ts`](../../src/cli/coordinator.ts) does this as each worker joins:

```typescript
partitionMap.registerTable(tableName, new RoundRobinPartitionStrategy(), reg.partitionCount, placements);
```

and the worker loads the rows to match, by row index:

```typescript
if (usePartitionFilter && (currentRow % partitionCount) !== partitionIndex) {
  return;
}
```

So partition *p* is the rows whose ordinal position in the CSV is congruent to *p*, and it lives on exactly one worker. Round-robin balances row counts closely, but provides no key-location guarantee: equal customer keys can be scattered across workers, so key equality alone proves neither co-location nor a prunable partition.

## Pruning, and the field nobody sets

[`PartitionPruner`](../../src/distributed/partition/partition-pruner.ts) answers "given this `WHERE` clause, which partitions can I skip?" It is a recursive evaluator that intersects for `AND`, unions for `OR`, and handles `=`, the range operators, `BETWEEN`, and `IN`. It is also gated on its first line:

```typescript
if (!predicate || !info.partitionKey) return allIds;
```

And `partitionKey` comes from `strategy._partitionKey`, a field **no strategy class in the codebase defines**. `HashPartitionStrategy`'s constructor sets `_seed` and `_keyParts`; `RangePartitionStrategy`'s sets `_boundaries`; `RoundRobinPartitionStrategy` has no constructor. The only assignments to `_partitionKey` anywhere in the repository are in `tests/distributed/e2e/`, which attaches it to the strategy object by hand.

The pruner works, then, and it is worth knowing how well, because a partition key is one field away:

```
partitionKey recorded: null
hash, no _partitionKey, O_CUSTKEY = 42         -> {0,1,2,3,4,5,6,7}  (8 of 8)
partitionKey recorded: "O_CUSTKEY"
hash + key, O_CUSTKEY = 42                     -> {0}  (1 of 8)
hash + key, O_CUSTKEY IN (42, 43, 44)          -> {0,5}  (2 of 8)
hash + key, O_CUSTKEY > 42 (range op on hash)  -> {0,1,2,3,4,5,6,7}  (8 of 8)
hash + key, O_TOTALPRICE = 42 (other column)   -> {0,1,2,3,4,5,6,7}  (8 of 8)
hash + key, no predicate                       -> {0,1,2,3,4,5,6,7}  (8 of 8)
range + key, O_TOTALPRICE < 60000              -> {0,1}  (2 of 4)
range + key, BETWEEN 60000 AND 120000          -> {1,2}  (2 of 4)
```

Three lines are worth reading twice. Equality on a hash key prunes to one partition of eight. `IN` with three values prunes to **two**, not three, because two hashes collided — the pruner unions whatever `partitionFor` returns and does not care. And a range predicate on a *hash*-partitioned table prunes nothing, correctly: [`_pruneRange`](../../src/distributed/partition/partition-pruner.ts) refuses any strategy but `RANGE`, because hashing does not preserve order.

The result feeds `_selectNodesForPartitions` in [`DistributedPlanner`](../../src/distributed/planner/distributed-planner.ts), which turns a partition set into the nodes that must run the scan fragment. With no partition key that is always every node, so in any cluster the CLI can start, **every scan goes to every worker.**

## Three ways to join

Placement matters most for joins, and [`DistributionAwareJoin`](../../src/distributed/optimizer/distribution-aware-join.ts) — the pass `enableDistributed` splices in behind `PlanProperties` — annotates each join node with one of four strategies, trying the free options first. A join against a **replicated** table is co-located, provided the join type allows that particular side to be the replicated one — `REPLICATED_SIDE_ALLOWED_BY_JOIN_TYPE` permits either side for `INNER`, only the right for `LEFT`, `SEMI`, and `ANTI`, and only the left for `RIGHT`. Then it checks whether both tables are hash-partitioned the same way on the join keys, via [`isColocated`](../../src/distributed/partition/partition-map.ts) plus [`_areColocated`](../../src/distributed/optimizer/distribution-aware-join.ts). Failing both, it costs three options in bytes and takes the cheapest:

```typescript
const shuffleCost = (leftCard * leftRowWidth + rightCard * rightRowWidth) * this._costPerByte;
const broadcastLeftCost = leftCard * leftRowWidth * this._costPerByte * nodeCount;
const broadcastRightCost = rightCard * rightRowWidth * this._costPerByte * nodeCount;
```

Running the same join under four different partition maps:

```
round-robin, no partition key                -> shuffle  cost=128
hash on join key, same placement             -> colocated  cost=undefined
hash on unrelated keys                       -> shuffle  cost=128
CUSTOMER replicated                          -> colocated  cost=undefined
```

Co-location has no cost because nothing moves. And notice `nodeCount` in the broadcast formulas: `_estimateNodeCount` returns `Math.max(2, Config.defaultPartitionCount)`, which is 16, always, regardless of how many nodes the cluster has. A broadcast is priced as if it goes to sixteen machines even in the two-machine cluster above, so it only wins when one side is more than fifteen times smaller in bytes *and* under `Config.broadcastThreshold` (10,000 rows). Bisecting for the boundary:

```
broadcastThreshold 10000 networkCostPerByte 0.001 nodeCount used = 16
c.C_CUSTKEY <= 50      leftCard=1 rightCard=50 -> broadcast_left cost=1.024
c.C_CUSTKEY < 5        leftCard=1 rightCard=4 -> shuffle cost=0.32
c.C_NATIONKEY = 3      leftCard=40 rightCard=1000 -> broadcast_left cost=40.96
```

The last line is the clean case: 40 rows against 1,000, and broadcasting the small side wins. Change nothing but the join type and it flips back:

```
LEFT join, filtered left   joinType=LEFT leftCard=40 rightCard=1000 -> shuffle cost=66.56
```

because [`_isRestrictedJoinType`](../../src/distributed/optimizer/distribution-aware-join.ts) sets `broadcastLeft` to `Infinity` for `LEFT`, `SEMI`, and `ANTI`: broadcasting the preserved side of a left join would make every recipient emit its own `NULL`-padded rows for the same left row.

One more thing about those numbers. `leftCard=1000` is not the customer table's size — the coordinator loaded only 1,000 rows, enough to infer a schema. The strategy is chosen from a sample.

## The join that cannot run

`shuffle` is what round-robin data gets, and [`_buildShuffleJoin`](../../src/distributed/planner/distributed-planner.ts) implements it. For the running example on two workers, the plan is cut into seven fragments:

```
  fragment 1 target=[worker-19401] output={"exchangeType":"hash_shuffle","partitionCount":2,"targetNodes":["worker-19401","worker-19402"],"keyColumns":[0]} inputs=[]
      Filter
        Scan(CUSTOMER AS C)
  ... fragment 2 is the same on worker-19402; fragments 3 and 4 are the same for Scan(ORDERS AS O) ...
  fragment 5 target=[worker-19401] output={"exchangeType":"gather","partitionCount":2} inputs=[1:hash_shuffle, 2:hash_shuffle, 3:hash_shuffle, 4:hash_shuffle]
      Join(INNER)
        ExchangeReceive(fragments=[1,2])
        ExchangeReceive(fragments=[3,4])
  ... fragment 6 is the same join on worker-19402 ...
  fragment 7 target=[coordinator-19400] output=null (root) inputs=[5:gather, 6:gather]
      Project
        Limit(10)
          MergeExchange(limit=10)
            TopN(10)
              FinalAggregate(final)
                PartialAggregate(partial)
                  ExchangeReceive(fragments=[5,6])
```

This is the correct shape: both sides are re-hashed on the join key so matching rows land together, the join runs on both workers in parallel, and only the aggregated result reaches the coordinator. `keyColumns: [0]` is the key's position in the fragment's output schema, from [`_extractShuffleKeyIndices`](../../src/distributed/planner/distributed-planner.ts).

And it cannot execute, because of one line in the worker's startup. [`src/cli/worker.ts`](../../src/cli/worker.ts) registers exactly one peer:

```typescript
transport.registerNode('coordinator', coordHost, coordPort);
```

[`HttpTransport`](../../src/distributed/transport/http-transport.ts) resolves a node id to an address through that table, and throws when it cannot:

```typescript
const target = this._nodes.get(targetNodeId);
if (!target) throw new Error(`Unknown node: ${targetNodeId}`);
```

The coordinator learns about every worker as it registers, and tells no worker about any other. So a fragment whose `outputPartitioning.targetNodes` names a peer — every shuffle fragment, and every broadcast fragment — fails on its first `sendChunk`, and three retries later the query is dead. **Worker-to-worker exchange is planned, dispatched, and never delivered**; the missing piece is a peer-address broadcast at join time, not anything in the planner or the executor.

Which is why the aggregate in chapter 47 worked. Its shuffle fragments had *no* `targetNodes`, so [`_buildOutputConfig`](../../src/distributed/execution/coordinator.ts) defaulted the destination to the coordinator:

```typescript
targetNodes: (op.targetNodes && op.targetNodes.length > 0) ? op.targetNodes : [targetNodeId],
```

Everything that talks only to the coordinator runs. Everything that needs a peer does not.

## Joins that do run

A join whose inputs are not plain scan/filter subtrees is not pushable, so [`_isShufflePushableJoin`](../../src/distributed/planner/distributed-planner.ts) rejects it, `_placeGathers` recurses into the children, and each child becomes its own gather fragment. Count the customers that placed an order — a `COUNT(*)` over `CUSTOMER` joined to a `GROUP BY o.O_CUSTKEY` subquery on `ORDERS` — and the join happens on the coordinator:

```
  fragment 1 target=[worker-19401] output={"exchangeType":"hash_shuffle","partitionCount":2} inputs=[]
      PartialAggregate(partial)
        Scan(ORDERS AS O)
  ... fragment 2 is the same on worker-19402; fragments 3 and 4 are Scan(CUSTOMER AS C), output=gather ...
  fragment 5 target=[coordinator-19400] output=null (root) inputs=[1:hash_shuffle, 2:hash_shuffle, 3:gather, 4:gather]
      Project
        FinalAggregate(final)
          PartialAggregate(partial)
            Join(INNER)
              Project
                FinalAggregate(final)
                  ExchangeReceive(fragments=[1,2])
              ExchangeReceive(fragments=[3,4])
```

On the live cluster it returns `7664`, matching the single-node answer exactly, and the worker log shows what crossed the wire:

```
[fragment] Fragment 10 completed: 30000 rows in 42.52 ms
[fragment] Fragment 8 completed: 6370 rows in 68.06 ms
```

30,000 customer rows shipped whole, 6,370 pre-aggregated keys. A working distributed join — working precisely because it is the *less* scalable plan.

## The other partition-aware passes

Four more passes share a small helper module, [`repartition.ts`](../../src/distributed/optimizer/repartition.ts): [`hashShuffleExchange`](../../src/distributed/optimizer/repartition.ts) builds the `Exchange` node they all insert, and [`partitionedScanTables`](../../src/distributed/optimizer/repartition.ts) says whether there is anything partitioned underneath worth splitting. Each does what `PartialAggregate` does — a cheap local pass, a shuffle, a global pass.

```
ORDER BY + LIMIT, single node           ORDER BY + LIMIT, distributed
Project                                 Project
  TopN(5)                                 TopN(5)
    Scan(ORDERS AS O)                       Exchange(hash_shuffle)
                                              TopN(5)
                                                Scan(ORDERS AS O)

DISTINCT, single node                   DISTINCT, distributed
Distinct                                Distinct
  Project                                 Exchange(hash_shuffle)
    Scan(ORDERS AS O)                       Distinct
                                              Project
                                                Scan(ORDERS AS O)
```

[`DistributedSetOpPass`](../../src/distributed/optimizer/distributed-setop.ts) is the fourth, and the only one that can do nothing: if every input scans the same partitioned tables, a `UNION ALL` is already partition-wise and needs no exchange.

[`DistributedLimitPass`](../../src/distributed/optimizer/distributed-limit.ts) is the sharpest: five rows per worker guarantee the global top five, so 240,000 rows become 10. It adds `offset` to the local count and zeroes the local offset — a local `LIMIT 5 OFFSET 100` would be wrong, a local `LIMIT 105` is not. [`localPartitionedScanTables`](../../src/distributed/optimizer/repartition.ts) refuses to push through any node that could change row multiplicity, which is why the whitelist stops at scan, filter, project, and unlimited sort.

[`DistributedSortPass`](../../src/distributed/optimizer/distributed-sort.ts) fires only when there is *already* an exchange below, and converts a global sort into a local sort under a `MergeExchange`. That is why the running example has `Limit → MergeExchange → TopN` — the partial aggregate got there first.

The limit query on the live cluster returns five rows, all tied at the maximum price, and a different five than the single-node run picks:

```
distributed: 3627, 14093, 24559, 35025, 45491
single node: 3627,  8860, 14093, 19326, 24559
```

Both are correct: `ORDER BY O_TOTALPRICE DESC` says nothing about ties, and the two plans break them in the order their inputs arrive.

## In the code

| Idea | Where |
|---|---|
| Placement model | [`PartitionMap`](../../src/distributed/partition/partition-map.ts) |
| Hash / range / round-robin | [`src/distributed/partition/partition-strategy.ts`](../../src/distributed/partition/partition-strategy.ts) |
| Co-location test | [`isColocated`](../../src/distributed/partition/partition-map.ts) |
| Predicate → partition set | [`PartitionPruner`](../../src/distributed/partition/partition-pruner.ts) |
| Join strategy choice | [`DistributionAwareJoin`](../../src/distributed/optimizer/distribution-aware-join.ts) |
| Broadcast side legality | [`_isRestrictedJoinType`](../../src/distributed/optimizer/distribution-aware-join.ts) |
| Shuffle fragment construction | [`_buildShuffleJoin`](../../src/distributed/planner/distributed-planner.ts) |
| Broadcast fragment construction | [`_buildBroadcastJoin`](../../src/distributed/planner/distributed-planner.ts) |
| Shared exchange-insertion helpers | [`repartition.ts`](../../src/distributed/optimizer/repartition.ts) |
| Two-phase limit, distinct, set op | [`DistributedLimitPass`](../../src/distributed/optimizer/distributed-limit.ts), [`DistributedDistinctPass`](../../src/distributed/optimizer/distributed-distinct.ts), [`DistributedSetOpPass`](../../src/distributed/optimizer/distributed-setop.ts) |
| Local sort under a merge | [`DistributedSortPass`](../../src/distributed/optimizer/distributed-sort.ts) |

| Setting | Default | Effect |
|---|---|---|
| `defaultPartitionCount` | 16 | shuffle partition count, and the fixed node count in broadcast costing |
| `broadcastThreshold` | 10000 | rows above which a side may not be broadcast |
| `networkCostPerByte` | 0.001 | the only unit in the distribution cost model |
| `fragmentRetryLimit` | 3 | dispatch attempts before the query fails |

## Traps

**Round-robin partitions by position rather than key value.** It can balance row counts without proving where a particular key lives. Key-based pruning and co-location need a value-based strategy and a partition key.

**Nothing sets `_partitionKey` outside the tests.** The pruner and `_areColocated` both short-circuit on it, so from the CLI, pruning prunes nothing and no join is co-located.

**Broadcast is costed against sixteen nodes.** `_estimateNodeCount` never consults `ClusterManager`, so lowering `QE_PARTITION_COUNT` makes broadcast more attractive and adding machines does not make it less.

**A shuffle join is planned correctly and cannot be delivered.** The failure is in address bookkeeping — workers know only the coordinator — not in the planner, the exchange operators, or the transport.

**`.explain` needs a coordinator that has a schema.** The `--distributed` flag on the main CLI loads the coordinator's tables with `partitionIndex: -1`, which matches no row, so the tables register with zero columns and binding fails before a plan exists. The standalone coordinator entry point loads `QE_COORD_SCHEMA_SAMPLE_ROWS` rows instead, and works.

## Exercises

### Understand

Two rows share a join key but were assigned to workers by round-robin position. Can a worker safely assume all matching rows are local?

### Practice

1. **Observe.** Reproduce the pruning table: build a `PartitionMap` with a `HashPartitionStrategy`, set `_partitionKey` by hand, and prune `=`, `IN`, and `>`. Why did `IN` with three values return two partitions?

2. **Observe.** Register `CUSTOMER` as replicated with `registerReplicatedTable` and re-plan the running example. Which strategy does the join get, and how many fragments now?

3. **Extend (optional).** Start a two-worker cluster and run the failing join. Then make the coordinator's `onRegister` handler tell every worker about every other worker. Does the shuffle join complete, and does it agree with the single-node answer?

4. **Extend (optional).** Change `_estimateNodeCount` to return the live worker count. Re-run the four cost measurements above and say which flip.

5. **Extend (optional).** Construct a query and a two-partition split where pushing `OFFSET` down into `DistributedLimitPass`'s local node gives the wrong rows.

### Hints and expected observations

No. Key equality gives no location guarantee under round-robin assignment. A co-located join needs compatible key-based partitioning and complete placement metadata.

## Recap

- A **partition map** holds, per table, a strategy, a count, a key, and a placement from partition id to node. The CLI registers **round-robin by row index**, which carries no information.
- `PartitionPruner` turns a predicate into a partition set — one of eight for hash equality, two of four for a range `BETWEEN` — but short-circuits when the table has no partition key, and **no strategy class sets one outside the tests**.
- `DistributionAwareJoin` prefers co-location — a replicated table, or matching hash partitioning on the join keys — then costs shuffle against broadcast in bytes. Broadcast is charged for **sixteen** recipients regardless of cluster size, and is forbidden on the preserved side of `LEFT`, `SEMI`, and `ANTI` joins.
- A shuffle join produces one fragment per side per worker plus one join fragment per worker; its output partitioning names **peer workers**, which workers cannot resolve, so it fails with `Unknown node` after three retries. Joins whose inputs are not plain scan subtrees gather to the coordinator instead, and work.
- `DistributedLimit`, `DistributedDistinct`, and `DistributedSetOp` all use the same local-then-shuffle-then-global shape; `DistributedSort` is the one that fires only when an exchange already exists below it.

Next: [chapter 49](49-transport-and-cluster-health.md) goes down to the bytes — how a chunk is framed for the wire, why the shuffle path makes it twice as large, and what the cluster does when a node stops answering.
