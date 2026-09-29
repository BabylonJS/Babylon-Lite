# Task 4.1: Share Lazy Meshopt Page Decoder

## Goal

Reuse the existing lazy meshoptimizer decoder for independent MeshLoD page streams without changing glTF behavior.

## Requirements addressed

REQ-INT-2, REQ-INT-8, REQ-FMT-4

## Background

`packages/babylon-lite/src/loader-gltf/meshopt-decode.ts:20-59` currently keeps its decoder interface private and is dynamically imported by `gltf-feature-meshopt.ts`. MeshLoD needs the same `decodeGltfBuffer` surface for `ATTRIBUTES/NONE` and `TRIANGLES/NONE`.

## Files to modify/create

- `packages/babylon-lite/src/loader-gltf/meshopt-decode.ts` — export internal decoder typing only.
- `packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.ts` — lazy decoder load, page decode, validation.
- `tests/lite/unit/mesh-lod/mesh-lod-page-decoder.test.ts`
- `tests/lite/unit/decode-error.test.ts` — ensure existing behavior remains stable if appropriate.

## APIs and structs involved

- Internal `MeshoptDecoderModule`.
- Stored page header and page-table decoded offsets/counts.

## Implementation details

1. Export only the minimal decoder interface needed by both callers; preserve script URL and singleton behavior.
2. Dynamically import `meshopt-decode.ts` on first MeshLoD decode.
3. Validate page CRC/header/stream offsets before invoking the codec.
4. Decode vertices and indices into the declared decoded allocation.
5. Validate decoded lengths, index bounds, vertex stride 24, index stride 2, and zero padding.
6. Map script and codec failures to `MLOD_DECODER_LOAD`/`MLOD_DECODER_FAILURE`.

## Targeted tests

- Mock decoder receives exact mode/filter/count/stride.
- Corrupt page never invokes decoder.
- Lazy import is absent until decode is requested.
- Existing glTF meshopt tests remain unchanged.

## Gotchas

- Do not route MeshLoD through `GltfFeature`.
- Do not eagerly load the decoder from the public facade.

## Dependencies

- Tasks 3.2–3.3.

## Verification checklist

- [ ] One decoder module serves both paths.
- [ ] Existing glTF semantics are unchanged.
- [ ] Page decode validates before/after codec use.
- [ ] Decoder tests pass.
