# 49. Transport and cluster health

> After this chapter you will be able to trace exchange messages and distinguish heartbeat observations, failure suspicion, and fragment recovery.

## The question

Take one chunk of `ORDERS` — 2,048 rows, four columns — and encode it the way a gather fragment does:

```
chunk rows=2048 cols=4 types=INT32,INT32,FLOAT64,VARCHAR
encoded bytes=27800  bytes/row=13.6
```

Now hand the same chunk to an `ExchangeSender` configured for a hash shuffle, with one target node and no key extractors — which, from [chapter 47](47-fragments-and-exchange.md), is the configuration a partial aggregate actually gets:

```
hash_shuffle, 0 key extractors, 1 target -> 1 message(s), 61486 bytes to coordinator
```

Same rows, same codec, same single destination, one message either way. 27,800 bytes became 61,486. The shuffle has nothing to shuffle and it still costs 121% more.

## The wire format

[`Transport`](../../src/distributed/transport/transport.ts) is an abstract base class whose every method throws — ten of them, covering chunks, fragments, control messages, and node registration. That shape lets the tests substitute a `MockTransport` that delivers chunks by calling the listener directly, and would let a deployment swap HTTP for something else. There is one production implementation.

[`HttpTransport`](../../src/distributed/transport/http-transport.ts) runs a plain `node:http` server with six routes:

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET` | `/status` | — | liveness probe, returns the node id |
| `POST` | `/register` | JSON | a worker announces itself to the coordinator |
| `POST` | `/heartbeat` | JSON | a worker says it is still there |
| `POST` | `/fragment/execute` | JSON | dispatch a fragment; answers `202` immediately |
| `POST` | `/control` | JSON | `fragment_completed`, `fragment_failed`, `cancel_fragment` |
| `POST` | `/exchange/:channelId` | binary | one encoded chunk |

Only the last one carries data, and it is the only one that is not JSON. Nodes are addressed by id through a local map, which is where chapter 48's `Unknown node` came from:

```typescript
const target = this._nodes.get(targetNodeId);
if (!target) throw new Error(`Unknown node: ${targetNodeId}`);
```

Each destination gets a keep-alive `Agent` with `maxSockets: 4`, cached by `host:port`, so a fragment sending a hundred chunks reuses four TCP connections rather than opening a hundred.

[`ChunkCodec`](../../src/distributed/transport/chunk-codec.ts) is the frame. Ten bytes of header, then the columns:

```typescript
const writer = new ByteWriter(new Uint8Array(CODEC_HEADER_BYTES + chunkRecordBytes(flatChunk.columns)));
writer.u32(HEADER_MAGIC);
writer.u16(flatChunk.columns.length);
writer.u32(flatChunk.size);
writeChunkRecords(writer, flatChunk.columns);
```

The body is `writeChunkRecords` from [`column-codec.ts`](../../src/storage/column-codec.ts) — the same encoder [chapter 43](../05-storage/43-serialization-and-spill.md) uses for spill files. There is no separate network format, which is why the round trip preserves column *types* as well as values:

```
column classes:    Column:INT32, Column:INT32, Column:FLOAT64, DictionaryColumn:VARCHAR
after round trip:  Column:INT32, Column:INT32, Column:FLOAT64, DictionaryColumn:VARCHAR
```

That `DictionaryColumn` is the answer to the opening question, and we will come back to it in a moment.

**End of stream is a chunk with no columns.** [`finalize`](../../src/distributed/execution/exchange-operator.ts) encodes an empty `DataChunk` and sends it to every target:

```typescript
const endMarker = this._codec.encode(new DataChunk([], 0));
```

Ten bytes — header only, no records. The receiver recognizes it by shape:

```typescript
if (chunk.size === 0 && chunk.columns.length === 0) {
  this._completedSources.add(sourceNodeId);
  ...
}
```

**A chunk can arrive before anyone is listening.** A fragment starts producing as soon as it is dispatched; the consumer's receiver may not have registered its channel yet. `HttpTransport` buffers into `_pendingChunks` keyed by channel and `onChunkReceived` drains the backlog when a listener appears. Without that, a fast fragment's first chunks would be dropped.

## Why the shuffle doubles it

Now the 61,486 bytes. [`_sendShuffle`](../../src/distributed/execution/exchange-operator.ts) never encodes the chunk it was given. It calls `_partitionByKey` first, and that function rebuilds every column from scratch:

```typescript
const cols = chunk.columns.map(srcCol => {
  const newCol = new Column(srcCol.dataType, rowIndices.length);
  for (let j = 0; j < rowIndices.length; j++) {
    newCol.set(j, srcCol.get(rowIndices[j]));
  }
  newCol.length = rowIndices.length;
  return newCol;
});
```

`new Column(VARCHAR, n)` is a plain string column. The `DictionaryColumn` holding 2,048 two-byte indices into a seven-entry dictionary ([chapter 41](../05-storage/41-encodings.md)) becomes 2,048 literal copies of a ten-character date plus an offsets array. That is the whole 33,686-byte difference.

And it happens even when there is nothing to do. With no key extractors, the partition id is the hash of an empty key list:

```typescript
const pid = hashKeyValues(keyParts, keyParts.length) % partCount;
```

[`hashKeyValues`](../../src/execution/hash-table.ts) with arity zero returns the seed for every row, so every row goes to one bucket, and one bucket is rebuilt into one chunk. Then:

```typescript
const targetIdx = partitionId % this._targetNodes.length;
```

With one target node that is index 0. So the shuffle path, in the configuration it is given, materializes every row, discards the column encodings, and sends the result where a gather would have sent the original. Setting `outputPartitioning.targetNodes` — chapter 48's missing peer registration — would make that work meaningful; leaving it unset makes it pure overhead.

## Who is in the cluster

[`NodeDescriptor`](../../src/distributed/cluster/node-descriptor.ts) is an address plus a role plus a capacity plus a status. The role decides what a node may be asked to do:

```typescript
canExecuteFragments(): boolean {
  return this.status !== NodeStatus.DEAD
    && (this.role === NodeRole.WORKER || this.role === NodeRole.HYBRID);
}
canCoordinate(): boolean {
  return this.role === NodeRole.COORDINATOR || this.role === NodeRole.HYBRID;
}
```

`HYBRID` is both, with a visible consequence: [`getWorkerNodes`](../../src/distributed/cluster/cluster-manager.ts) filters on `canExecuteFragments`, so a `HYBRID` coordinator counts itself as a worker. The two CLI entry points differ exactly here. The standalone coordinator declares `NodeRole.COORDINATOR`:

```
  node:    coordinator-9400
  port:    9400
  workers: 2
  alive:   3
```

Two workers, three nodes. The `--distributed` flag on the main CLI leaves the role at its default, `HYBRID`, and the same cluster reports:

```
  distributed: enabled (node: coordinator-15796, 3 worker(s))
```

Three workers, because the coordinator is one of them. Neither line is wrong; they ask different questions of the same `ClusterManager`, and the second means the coordinator is itself a candidate target for pushed-down fragments. [`addNode`](../../src/distributed/cluster/cluster-manager.ts) is idempotent — a re-registering node updates its address and returns to `ALIVE` rather than duplicating — and `recordHeartbeat` resurrects a node marked `DEAD`.

## How long until a node is declared dead

[`HeartbeatMonitor`](../../src/distributed/cluster/heartbeat-monitor.ts) implements phi-accrual failure detection: instead of a fixed timeout, it models the distribution of past inter-arrival times and reports φ, roughly the negative log of the probability that a heartbeat this late is still coming. `getStatus` reads two levels off one threshold:

```typescript
getStatus(nodeId: NodeId, now: number): NodeStatus {
  const phiValue = this.phi(nodeId, now);
  if (phiValue >= this._threshold * 2) return NodeStatus.DEAD;
  if (phiValue >= this._threshold) return NodeStatus.SUSPECT;
  return NodeStatus.ALIVE;
}
```

Feed it a hundred perfectly regular heartbeats three seconds apart — the configured interval — and ask what φ says after various silences:

```
interval 3000 threshold 8 window 100
silence(s) | phi      | status
         3 | 0.301030 | alive
         6 | 0.770951 | alive
        10 | 1.621251 | alive
        30 | 6.212842 | alive
        60 | 13.115741 | suspect
       300 | 16.000000 | dead
      3600 | 16.000000 | dead
```

A node that stops answering is still `alive` after thirty seconds, `suspect` at a minute, and `dead` somewhere between one and five minutes. For arrivals with no jitter, that is very slow, and the reason is in `ArrivalWindow`:

```typescript
_addToStats(value: number): void {
  this._meanAccum += value;
  this._varianceAccum += value * value;
}
```

`_varianceAccum` is the sum of *squares*, and `phi` divides it by `count - 1` and calls the result the variance:

```typescript
const variance = this._count > 1 ? this._varianceAccum / (this._count - 1) : mean * mean;
const stddev = Math.sqrt(variance);
```

The mean is never subtracted. With 99 intervals of exactly 3,000 ms the true variance is zero, but this computes 99 × 3000² / 98 ≈ 9,091,837, a standard deviation of about 3,015 ms — as though every heartbeat arrived at a random time within roughly one interval of when it should. The detector therefore behaves as if the network is extremely jittery no matter how regular it is. The `stddev === 0` branch below it, which would have fired at `elapsed > mean * 2` — six seconds — is unreachable, because that standard deviation can only be zero when every recorded interval is zero.

None of which matters yet, because **nothing calls `startMonitoring`**. `ClusterManager` exposes it, and it is the only caller of `HeartbeatMonitor.start`, which would install the interval timer that ticks φ and fires status callbacks — and no file in `src/` or `tests/` calls `startMonitoring` itself, so the timer is never installed. Heartbeats do arrive — the worker posts one every `Config.heartbeatIntervalMs` and the coordinator records it — but the recording only ever moves a node *toward* `ALIVE`. In a running cluster, nodes are never marked `SUSPECT` or `DEAD`, and `onNodeFailure` never fires.

What does happen when a node dies is that the fragment dispatched to it fails, `_dispatchFragment` retries up to `Config.fragmentRetryLimit` times, and [`_selectTargetNode`](../../src/distributed/execution/coordinator.ts) picks a different candidate — but only if the fragment has more than one:

```typescript
if (candidates.length === 1) {
  return candidates[0];
}
```

A scan fragment for a partition that lives on exactly one node has exactly one candidate, so it is retried three times against the same dead node and then the query fails. Fault tolerance in this engine is retry plus replica selection; with no replicas, it is retry.

## Knobs that do nothing

Five settings in [`src/config.ts`](../../src/config.ts) are read into the distributed subsystem and then never used:

| Setting | Default | State |
|---|---|---|
| `heartbeatTimeoutMs` | 10000 | declared; no code reads it — φ replaced the fixed timeout |
| `codecCompression` | 0 | declared; `ChunkCodec` has no compression path |
| `exchangeBatchSize` | 4096 | assigned to `ExchangeSender._batchSize`, never read again |
| `exchangeBufferCapacity` | 8 | assigned to `ExchangeReceiver._bufferCapacity`, never read again |
| `phiAccrualThreshold` | 8.0 | used, but only by a monitor that is never started |

The middle two are worth a second look, because their names describe backpressure. `ExchangeReceiver._buffer` is a plain array that `_handleChunk` pushes onto unconditionally; the capacity is never compared against anything. A fragment producing faster than its consumer drains grows that array without limit, and the chunks are decoded objects by then. It is a queue with a documented bound and no enforcement.

## In the code

| Idea | Where |
|---|---|
| Transport interface | [`Transport`](../../src/distributed/transport/transport.ts) |
| The one implementation | [`HttpTransport`](../../src/distributed/transport/http-transport.ts) |
| Chunk framing | [`ChunkCodec`](../../src/distributed/transport/chunk-codec.ts) |
| Shared column encoder | [`writeChunkRecords`](../../src/storage/column-codec.ts) |
| Sending a chunk | [`ExchangeSender`](../../src/distributed/execution/exchange-operator.ts) |
| The re-materialization | [`_partitionByKey`](../../src/distributed/execution/exchange-operator.ts) |
| Receiving a chunk | [`ExchangeReceiver`](../../src/distributed/execution/exchange-operator.ts) |
| Sorted k-way merge (tests only) | [`MergeExchangeOperator`](../../src/distributed/execution/merge-exchange.ts) |
| Node identity and role | [`NodeDescriptor`](../../src/distributed/cluster/node-descriptor.ts) |
| Membership | [`ClusterManager`](../../src/distributed/cluster/cluster-manager.ts) |
| Failure detection | [`HeartbeatMonitor`](../../src/distributed/cluster/heartbeat-monitor.ts) |
| Every wire message's shape | [`src/distributed/distributed-types.ts`](../../src/distributed/distributed-types.ts) |

| Setting | Default | Effect |
|---|---|---|
| `clusterPort` | 9400 | coordinator listen port |
| `workerPort` | 9401 | default worker listen port |
| `heartbeatIntervalMs` | 3000 | how often a worker posts `/heartbeat` |
| `phiAccrualWindowSize` | 100 | inter-arrival samples retained |
| `phiAccrualThreshold` | 8.0 | φ for `SUSPECT`; twice that for `DEAD` |
| `coordinatorTimeoutMs` | 300000 | query and fragment-wait deadline |
| `exchangePollIntervalMs` | 100 | merge-exchange wait between polls |
| `workerStartupTimeoutMs` | 30000 | how long the CLI waits for workers to register |

## Traps

**The network format is the disk format.** `ChunkCodec` wraps `writeChunkRecords`, so anything true of spill files in chapter 43 is true of exchange messages, including which encodings survive.

**Encoding is preserved by the codec and destroyed by the sender.** A gather sends the chunk as it stands. A shuffle rebuilds it value by value first. If you are measuring bytes on the wire, measure the path, not the codec.

**The end-of-stream marker is indistinguishable from an empty result.** A chunk with zero columns *and* zero rows means "done". A fragment that legitimately produces no rows sends no data chunks and then the marker, which is the same thing, which is why it works.

**A `HYBRID` node counts as a worker.** `.status` reporting three workers in a two-worker cluster is `getWorkerNodes` including the local node, not a bug in registration.

**The default startup path does not start automatic health monitoring.** The phi-accrual detector is implemented and tested, but its timer is never started. What tolerates a node failure is fragment retry, and retry can only help when the fragment has an alternative node.

## Recap

- One `Transport` interface, one HTTP implementation, six routes. Only `/exchange/:channelId` carries data; everything else is small JSON.
- `ChunkCodec` is a ten-byte header over the same column encoder that writes spill files, so **column encodings survive the round trip**. End of stream is an encoded chunk with no columns — ten bytes.
- The shuffle path calls `_partitionByKey`, which rebuilds every column value by value and **discards dictionary encoding**: 27,800 bytes became 61,486 for one chunk, with zero key extractors and one destination.
- Chunks that arrive before their receiver exists are buffered per channel and replayed when a listener registers.
- Role decides eligibility: a `HYBRID` coordinator counts itself among `getWorkerNodes`, which is why two CLI entry points report different worker counts for the same cluster.
- The phi-accrual detector never subtracts the mean when computing variance, so it treats perfectly regular heartbeats as highly jittery and takes minutes to declare a node dead — and it never runs anyway, because **`startMonitoring` is never called**. Fragment retry is the only fault tolerance that executes.

That completes Part 6. Scaling out is two unrelated systems: threads over shared memory, where the hard part is getting bytes into a `SharedArrayBuffer` cheaply, and processes over HTTP, where the hard part is deciding where the rows already are. Next: Part 7 turns from how the engine runs to how you work on it, starting with chapter 50 and the second front door onto the same logical plan.
