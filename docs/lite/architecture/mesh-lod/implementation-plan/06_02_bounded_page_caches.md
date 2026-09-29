# Task 6.2: Implement Bounded CPU/GPU Page Caches

## Goal

Complete deterministic allocation, accounting, retention, and safe eviction for encoded CPU pages and decoded GPU residency.

## Requirements addressed

REQ-CACHE-1, REQ-CACHE-2, REQ-CACHE-3, REQ-CACHE-4, REQ-RENDER-4

## Background

Task 4.2 created the fixed arena/pinned prefix. This task adds fine-page allocation and eviction while preserving current-frame references and hysteresis.

## Files to modify/create

- `packages/babylon-lite/src/mesh-lod/mesh-lod-cache.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.ts`
- `tests/lite/unit/mesh-lod/mesh-lod-cache.test.ts`

## APIs and structs involved

- 64 KiB deterministic first-fit blocks.
- `cacheCapacityBytes`, mutable `cacheBudgetBytes`, `cpuPageCacheBytes`.
- Page `lastUsedFrame`, priority, `frameRefCount`, pinned/uploading/in-flight state.

## Implementation details

1. Allocate decoded pages in contiguous 64 KiB blocks without replacing the arena.
2. Evict enough eligible victims before upload; evict more deterministically if fragmented.
3. Exclude pinned, fetching/decoding/uploading, current-frame referenced, and <120-frame-held pages.
4. Choose victims by oldest use, lower priority, then higher page ID.
5. Update page-state GPU records only after upload completion.
6. Retain encoded pinned pages always; bound unpinned encoded bytes with matching LRU ordering.
7. Release decoded CPU bytes after upload and keep accounting diagnostics exact.

## Targeted tests

- Budget boundary, one-upload exception accounting, fragmentation, pinned non-eviction.
- Current-frame/in-flight/upload victim exclusion.
- 120-frame residency jitter and CPU cache eviction.

## Gotchas

- Effective budget changes must not reallocate capacity.
- Logical committed residency may not exceed budget after upload settles.

## Dependencies

- Tasks 4.2 and 6.1.

## Verification checklist

- [ ] Pinned pages always count and remain resident.
- [ ] Eviction never invalidates submitted work.
- [ ] Budget/fragmentation tests are deterministic.
- [ ] Cache diagnostics match allocations.
