# Task 6.1: Implement Page Request Scheduler

## Goal

Implement bounded, deduplicated, cancellable, priority-ordered, retry-bounded fine-page requests.

## Requirements addressed

REQ-STREAM-1, REQ-STREAM-2, REQ-STREAM-3, REQ-STREAM-4, REQ-STREAM-5, REQ-STREAM-6

## Background

Phase 5 emits per-page demand priorities. Fine pages are requested individually from page-table ranges; pinned/bootstrap requests are outside the fine scheduler.

## Files to modify/create

- `packages/babylon-lite/src/mesh-lod/mesh-lod-scheduler.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.ts`
- `tests/lite/unit/mesh-lod/mesh-lod-scheduler.test.ts`

## APIs and structs involved

- `MeshLoDRequestScheduler`, `MeshLoDPageRuntime` states.
- Generation, demand frame, request token/controller, retry attempt/priority.

## Implementation details

1. Accept deterministic demand snapshots and sort descending priority then ascending page ID.
2. Guarantee one queued/in-flight request per page and share its terminal result.
3. Enforce mutable `maxConcurrentRequests`.
4. Remove queued demand and abort in-flight work after two obsolete frames.
5. Reject stale generation/token completions before decode or residency mutation.
6. Implement initial attempt plus retries at 250/1000 ms by default.
7. Classify network/408/429/5xx retryable; abort, protocol/integrity/version, and other 4xx permanent.
8. Pause only new fine requests/retries.

## Targeted tests

- Concurrency high-water mark, deduplication, priority/tie order, starvation prevention.
- Queued removal, in-flight abort, stale completion, exact retry count/delays/status matrix.

## Gotchas

- Cancellation must not turn a stale response resident.
- Fine failure must update diagnostics without failing the coarse asset.

## Dependencies

- Tasks 3.3, 5.2, and 5.4.

## Verification checklist

- [ ] In-flight count never exceeds the limit.
- [ ] Duplicate demand uses one transfer.
- [ ] Obsolete/stale work cannot commit.
- [ ] Retry behavior is bounded and observable.
