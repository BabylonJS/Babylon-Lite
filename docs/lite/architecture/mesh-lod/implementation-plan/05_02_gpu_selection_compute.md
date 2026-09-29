# Task 5.2: Implement GPU Selection and Demand Compute

## Goal

Implement hierarchy traversal, hysteretic group evaluation, exact cut selection, culling, and missing-page priority in WGSL.

## Requirements addressed

REQ-SEL-2, REQ-SEL-3, REQ-SEL-4, REQ-SEL-5, REQ-SEL-6, REQ-STREAM-5

## Background

Task 5.1 supplies GPU records. WGSL must match Task 3.4's float32 equations and comparisons exactly.

## Files to modify/create

- `packages/babylon-lite/src/mesh-lod/mesh-lod-selection.wgsl`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.ts`
- `tests/lite/integration/mesh-lod/mesh-lod-selection-gpu.test.ts`

## APIs and structs involved

- Transient hierarchy queue, visible-group bitset, selected cluster list, page-demand words, diagnostics counters.
- Workgroup size 64.
- Task-local `MeshLoDUpdateBatch extends DrawUpdateBatch`.

## Implementation details

1. Add reset, hierarchy traversal, group evaluation, and cluster selection entry points.
2. Use the same perspective/orthographic SSE, maximum scale, conservative sphere/frustum tests, and asymmetric thresholds as CPU.
3. Persist prior fine-required bits per group/instance.
4. Check complete group page residency before refinement.
5. Atomically append selected cluster/instance pairs and fixed-point page priority; tie resolution remains CPU page-ID ordering.
6. Detect transient capacity overflow without out-of-bounds writes and surface `MLOD_DEVICE_LIMIT`.
7. Queue all dispatches through one feature-owned update batch flushed before the render pass.

## Targeted tests

- Readback comparison for threshold, frustum, incomplete residency, hysteresis, and transformed-instance fixtures.
- Capacity overflow/error fixture.

## Gotchas

- Equality operators must match CPU exactly.
- Invisible groups contribute no page demand.

## Dependencies

- Tasks 3.4 and 5.1.

## Verification checklist

- [ ] GPU IDs normalize exactly to CPU IDs.
- [ ] Prior-state transitions match CPU.
- [ ] Missing-page priorities match fixtures.
- [ ] No out-of-bounds writes occur on overflow.
