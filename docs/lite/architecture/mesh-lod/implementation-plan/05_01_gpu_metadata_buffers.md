# Task 5.1: Create Persistent GPU Metadata Buffers

## Goal

Upload immutable hierarchy data and mutable instance/page/prior-state data using the exact GPU layouts required by selection compute.

## Requirements addressed

REQ-SEL-2, REQ-RENDER-4, REQ-INT-7

## Background

Phase 4 renders CPU-expanded coarse selections. GPU selection needs persistent storage buffers while preserving the existing geometry arena and shared-asset/multi-instance model.

## Files to modify/create

- `packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-scene.ts`
- `tests/lite/unit/mesh-lod/mesh-lod-gpu-layout.test.ts`

## APIs and structs involved

- GPU groups/clusters: 16 `u32` words each; hierarchy nodes 8 words.
- Page-state record: 8 words.
- Instance record: 128 bytes.
- Prior group-state bitset per instance/group.

## Implementation details

1. Pack parsed metadata into explicit `Uint32Array`/`Float32Array` layouts; never parse WGSL strings.
2. Allocate device-limit-checked storage buffers with copy destinations.
3. Upload page residency/arena offsets and stable instance IDs.
4. Version-gate world/normal matrix uploads using `worldMatrixVersion`; compute inverse-transpose and maximum scale.
5. Grow instance/prior-state buffers make-before-break and retire old buffers through `retireGpuResources`.
6. Keep GPU handles internal to runtime records.

## Targeted tests

- Byte/word offset tests for each record.
- Instance transform/max-scale and visibility updates.
- Growth retirement and device-limit failures.

## Gotchas

- Public diagnostics expose counts/bytes only.
- Buffer layouts must remain aligned with WGSL and serialized record semantics.

## Dependencies

- Phase 4 runtime and scene batches.

## Verification checklist

- [ ] Every GPU word has a tested meaning.
- [ ] Shared assets reuse immutable buffers.
- [ ] Instance state remains independent.
- [ ] Growth is frame-safe.
