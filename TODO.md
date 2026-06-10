# TODO — Morsel-driven parallel engine (đường thật)

Trạng thái hiện tại: chỉ **filter** và **aggregate** chạy song song. Aggregate là một
lát cắt hẹp (`src/parallel/morsel-aggregate.js` + `morsel-agg-worker.js`): copy cột vào
một SAB mới mỗi query, worker viết tay (không reuse operator), work-stealing bằng
`Atomics.add`, merge ở main. Đúng + fuzz sạch + ~4.2x trên 11 worker, nhưng vẫn còn
serial copy và không lan sang join/sort/project.

Mục tiêu: morsel-driven thật — zero-copy SAB columns + worker chạy operator thật trên
pipeline-fragment + parallel join. Làm **additive**, có flag, giữ nguyên path single/SIMD.

---

## #1 — SAB-backed Column allocator  ⭐ enabler, làm trước

Hiện: `src/storage/column.js` cấp `this.data = typedArrayFor(dataType, capacity)` →
ArrayBuffer thường. Worker không đọc được nếu không copy.

Việc:
- [ ] Arena allocator trên `SharedArrayBuffer` (bump-pointer + grow), trả về typed-array
      view. File mới: `src/storage/sab-arena.js`.
- [ ] `Column`/`DictionaryColumn` nhận allocator qua tham số (mặc định = allocator thường
      → path cũ không đổi). `column.data`, `nullBitmap`, dict `indices` cấp trên arena khi
      bật flag.
- [ ] Flag `Config.sabColumns` (env `QE_SAB_COLUMNS`). Mặc định off.
- [ ] Soi các nơi giả định `data` là ArrayBuffer thường: `storage/serializer.js`,
      `storage/chunk.js` (`slice`/`flatten`), spill (`tempManager`), `Column._grow`.
- [ ] Test: round-trip set/get/null/grow trên cột SAB == cột thường (metamorphic).

Khi xong: `morsel-aggregate.js` không cần copy nữa — pass thẳng view SAB cho worker
(bỏ vòng gather bulk-copy ở `run()`), đo lại speedup (kỳ vọng >4.2x).

## #2 — MorselScheduler thống nhất

Hiện: `morsel-agg-worker.js` tự `Atomics.add` trên SAB đã gather. `src/parallel/morsel-source.js`
phát morsel theo **page** của scan — hai cơ chế rời nhau.

Việc:
- [ ] Một `MorselScheduler` dùng chung: shared atomic counter phát [rowStart,rowEnd) trên
      output của scan (adapt `morsel-source.js`).
- [ ] Scan trên storage SAB-backed (#1) → morsel là view, không copy.

## #3 — Worker chạy pipeline-fragment (reuse operator)  ⭐ phần nặng nhất

Hiện: `src/parallel/worker-thread.js` chỉ chạy **kernel WASM lẻ** (filter 1 cột, reduce 1 cột).
Chưa dựng pipeline từ plan.

Việc:
- [ ] Serialize plan-fragment + bound-expr (đã là plain object) → postMessage 1 lần lúc
      khởi tạo worker (không gửi lại mỗi morsel).
- [ ] Worker dựng lại pipeline bằng `QueryExecutor.buildPipeline` trên đúng
      `FilterOperator`/`ProjectionOperator`/`HashAggregateOperator` đang có.
- [ ] Worker chạy fragment `scan→filter→project→partial-aggregate` trên morsel của nó,
      trả partial.
- [ ] Kiểm: bound-expr resolve theo tên (`resolveColumnIndex`) nên columnMapping dựng lại
      trong worker phải khớp.

## #4 — Cắt plan theo pipeline breaker + combine(partials)

Breaker = aggregate / join-build / sort. Worker làm tới breaker → partial; main combine.
Theo mô hình sink DuckDB: `Sink()` (local) → `Combine()` (local→global) → `Finalize()`.

Việc:
- [ ] Thêm `HashAggregateOperator.combine(partials)` (merge nhiều bảng hash partial → 1).
      Lưu ý NULL/empty group, SUM/AVG (giữ count), MIN/MAX seed đúng (đã fix `maxF64`).
- [ ] **Radix-partitioned hash table** (đúng DuckDB): mỗi worker build N partition local,
      chia theo `hash(key) & (N-1)`. Combine làm **per-partition song song** (partition i của
      mọi worker gộp độc lập) → không nghẽn ở merge tuyến tính khi cardinality cao. Chọn N
      theo số worker (vd N = next_pow2(workers) hoặc 2×). Đây là điểm khác chính so với
      "merge → 1" naive.
- [ ] `MorselAggregateOperator` route qua path mới này thay cho coordinator bespoke; bỏ
      `morsel-agg-worker.js` khi path reuse-operator chạy ổn (đừng để 2 path song song lâu).
- [ ] Pass đổi: ranh giới breaker do executor xác định, không hardcode trong worker. Combine
      hook vào `TaskScheduler`/`PipelineGraph` (đừng tự quản thread).

## #5 — Parallel hash-join (radix-join)

Hiện: join hoàn toàn serial (`src/execution/operators/hash-join.js`).

Việc:
- [ ] **Radix-partition cả hai side** theo `hash(key) & (N-1)` (đúng DuckDB radix-join):
      build side và probe side cùng partition → partition i chỉ join với partition i.
- [ ] Build: các worker materialize tuple vào partition local, rồi **parallel finalize**
      dựng hash table per-partition song song (hoặc 1 hash table shared build song song —
      DuckDB hiện đại dùng cách shared + parallel build, cả hai đều hợp lệ).
- [ ] Probe: probe side chạy song song qua morsel; mỗi morsel route vào hash table đúng
      partition (pipeline 2, phụ thuộc build xong qua `TaskScheduler`).
- [ ] Xử lý outer/semi/anti/mark cho đúng (đã có 3VL ở merge-join, soi lại hash path).

---

## Gap production (độc lập roadmap trên, nên xử sớm)

- [ ] **External/spill cho parallel aggregate.** `MorselAggregateOperator` buffer *toàn bộ*
      chunk + SAB giữ mọi row, **không** tôn trọng `Config.memoryLimit` (serial có spill).
      `GROUP BY` lớn dưới parallel có thể OOM. Tối thiểu: guard theo rows/bytes → fallback
      serial; lý tưởng (đúng DuckDB): external hash-aggregate — khi 1 partition (radix #4)
      vượt mem thì spill partition đó ra `tempManager`, finalize đọc lại từng partition.
- [ ] **External/spill cho hash-join.** DuckDB spill cả join, không chỉ aggregate: khi build
      side vượt mem, spill theo partition radix (#5) → probe đọc lại từng partition. Engine đã
      có spill cho hash-join serial (`tempManager`); cần áp cho path parallel/partitioned.
- [ ] **Worker-crash resilience.** Worker chết giữa query → `run()` reject nhưng pool không
      respawn → query sau treo. Cần phát hiện 'exit' → dựng lại worker.
- [ ] **Coverage morsel:** INT64/DECIMAL/TIMESTAMP + DISTINCT/aggregate-over-expression
      đang fallback serial (mất parallel). Mở rộng nếu cần.
- [ ] **Merge cardinality cao:** merge partial ở main là serial — nghẽn khi vài triệu group.
      Cân nhắc partitioned/parallel merge.

## Housekeeping

- [ ] ~30 file đang sửa **chưa commit** (cả batch DataFrame + morsel + fix WASM). Review &
      commit trước khi mở nhánh #1.
- [ ] `build/wasm/core.wasm` là artifact đã recompile (fix `maxF64`) — nhớ commit kèm
      `src/wasm/assembly/aggregate.ts`.

---

## Tham chiếu nhanh

- Morsel aggregate hiện tại: `src/parallel/morsel-aggregate.js`, `morsel-agg-worker.js`,
  `src/execution/operators/morsel-aggregate-op.js` (router + fallback serial).
- Wiring: `QueryExecutor.buildAggregate` (`src/execution/query-executor.js`),
  `enableParallel` (`src/index.js`), config `parallelAggThreshold`/`aggMorselRows`.
- Worker kernel-lẻ hiện tại: `src/parallel/worker-thread.js`, `worker-pool.js`,
  `parallel-dispatch.js`.
- Regression test: `tests/parallel/morsel-aggregate.test.js`,
  `tests/e2e/query-engine.test.js` (mục "parallel morsel aggregate" + "WASM/SIMD ungrouped").
- Suite hiện xanh: 2120 test. Chạy: `npx vitest run`.
