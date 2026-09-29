# Task 6.4: Verify Streaming and Cache Invariants

## Goal

Create deterministic instrumented fixtures covering every scheduler/cache bound and failure lifecycle.

## Requirements addressed

REQ-VERIFY-4, REQ-STREAM-1..6, REQ-CACHE-1..4

## Background

Tasks 6.1–6.3 complete fine streaming. Verification must be independent of real network timing and must prove coarse fallback under every outcome.

## Files to modify/create

- `tests/lite/integration/mesh-lod/mesh-lod-streaming-cache.test.ts`
- `tests/lite/unit/mesh-lod/fake-range-server.ts`
- `tests/lite/unit/mesh-lod/fake-frame-clock.ts`
- `tests/lite/unit/mesh-lod/mesh-lod-cache.test.ts`

## APIs and structs involved

- Custom fetch seam, fake timers/frames, scheduler/cache diagnostics.
- Exact page ranges from page table.

## Implementation details

1. Build deterministic fake responses for delay, bandwidth chunks, retry statuses, abort races, 200 fallback, invalid 206, and integrity failure.
2. Record starts/completions/aborts and assert concurrency/deduplication/priority.
3. Advance explicit frames to test two-frame obsolete grace and 120-frame residency hold.
4. Stress capacity/budget/fragmentation while tracking pinned, upload, and frame references.
5. Assert terminal fine failures preserve selected ancestor clusters.
6. Produce a requirement-to-test inventory for every `REQ-VERIFY-4` clause.
7. Run targeted tests then mandatory `pnpm test`; do not run perf tests.

## Targeted tests

- Named integration fixture plus scheduler/cache unit suites.
- Full `pnpm test`.

## Gotchas

- Avoid wall-clock sleeps; use deterministic clocks/timers.
- Do not accept transient over-budget states beyond the documented active upload.

## Dependencies

- Tasks 6.1–6.3.

## Verification checklist

- [ ] Every streaming/cache requirement maps to a passing fixture.
- [ ] Instrumented bounds are asserted, not inferred.
- [ ] Fallback survives all failure modes.
- [ ] Mandatory `pnpm test` passes.
