# Task 3.4: Implement Deterministic CPU Selection Oracle

## Goal

Implement the accepted float32 CPU oracle for hierarchy traversal, hysteretic group selection, residency fallback, culling, and page demand.

## Requirements addressed

REQ-SEL-1, REQ-SEL-3, REQ-SEL-4, REQ-SEL-5, REQ-SEL-6, REQ-SEL-7, REQ-GEO-7

## Background

Task 3.2 supplies immutable hierarchy records. This oracle is completed before GPU work and is exposed only through an internal testing subpath.

## Files to modify/create

- `packages/babylon-lite/src/mesh-lod/mesh-lod-selection-cpu.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-testing.ts`
- `packages/babylon-lite/package.json` — testing subpath export.
- `tests/lite/unit/mesh-lod/mesh-lod-selection-cpu.test.ts`
- `tests/lite/unit/mesh-lod/fixtures/selection-*.json`

## APIs and structs involved

- Explicit camera/projection/frustum, instance transform, residency bitset, prior hysteresis bitset.
- Result: ascending selected cluster IDs, desired missing pages with deterministic priority, diagnostics.

## Implementation details

1. Implement perspective/orthographic SSE equations with `Math.fround` around comparison-sensitive intermediates.
2. Transform local spheres by world matrix and maximum column scale.
3. Traverse level roots/children deterministically and conservatively frustum-cull spheres.
4. Apply asymmetric 15% refine/coarsen boundaries using prior `wasFineRequired`.
5. Require every group page resident before refinement; preserve coarser referencing clusters otherwise.
6. Keep hierarchy-visible selected groups atomic and return ascending cluster IDs without duplicates.
7. Compute benefit/cost priority and tie-break by ascending page ID.

## Targeted tests

- Exact threshold/equality boundaries, camera jitter, perspective/orthographic, outside/intersecting frusta.
- Partial group residency, terminal fallback, multi-instance transforms, exhaustive small DAG cuts.

## Gotchas

- Terminal groups are always fine-required and pinned.
- Ordering must be explicitly stable even if GPU tests later normalize it.

## Dependencies

- Task 3.2 parsed records.

## Verification checklist

- [ ] Fixtures have committed expected IDs.
- [ ] No cut contains missing/duplicate regions.
- [ ] Jitter remains stable inside hysteresis.
- [ ] CPU oracle tests pass.
