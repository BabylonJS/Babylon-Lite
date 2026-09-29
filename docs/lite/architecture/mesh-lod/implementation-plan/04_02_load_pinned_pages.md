# Task 4.2: Load Metadata and Pinned Coarse Pages

## Goal

Make `loadMeshLoD` resolve only after validated metadata, decoder readiness, pinned-page decode, and pinned GPU upload succeed.

## Requirements addressed

REQ-LOAD-1, REQ-LOAD-2, REQ-CACHE-2, REQ-FMT-3

## Background

Tasks 3.3 and 4.1 provide bootstrap ranges and page decoding. This task creates the asset runtime, fixed GPU arena, metadata buffers, and initial coarse residency; it does not register scene work.

## Files to modify/create

- `packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.ts`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-cache.ts` — initial arena/block allocator and pinned accounting.
- `packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.ts`
- `tests/lite/integration/mesh-lod/mesh-lod-loader.test.ts`
- `tests/lite/unit/mesh-lod/mesh-lod-options.test.ts`

## APIs and structs involved

- `MeshLoDAsset`, `MeshLoDAssetRuntime`, `MeshLoDEffectiveSettings`.
- `MeshLoDPageRuntime` bootstrap states.
- 64 KiB fixed blocks; default 128 MiB capacity/budget and 64 MiB CPU cache.

## Implementation details

1. Apply exact defaults and validate budget/capacity/concurrency/retry values.
2. Parse/bootstrap metadata and calculate rounded pinned allocation before GPU allocation.
3. Fail with `MLOD_BUDGET_TOO_SMALL` if budget/capacity cannot hold pinned pages.
4. Allocate immutable capacity arena and persistent metadata/page-state buffers using device limits.
5. Decode pinned pages, retain encoded bytes, upload to deterministic prefix offsets, and mark GPU resident.
6. Populate stable metadata/diagnostics state and resolve only when complete coarse geometry is usable.
7. Keep fine pages unrequested.

## Targeted tests

- Promise timing relative to pinned/fine fetches.
- Minimum-budget boundary, device limit, pinned CRC/decode/upload failure.
- Diagnostics effective settings and pinned residency.

## Gotchas

- Pinned pages count toward both configured budgets.
- No asset may be scene-registered before load resolves.

## Dependencies

- Tasks 3.1–4.1.

## Verification checklist

- [ ] Fine requests are absent during load.
- [ ] All terminal-group pages are GPU resident at resolve.
- [ ] Too-small budgets fail before registration.
- [ ] Loader integration tests pass.
