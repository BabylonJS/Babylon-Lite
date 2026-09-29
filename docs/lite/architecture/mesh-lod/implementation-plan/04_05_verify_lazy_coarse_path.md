# Task 4.5: Verify Lazy Loading and Coarse Fallback

## Goal

Prove the first runtime milestone end to end: opt-in chunks only, strict format failures, and uninterrupted coarse rendering.

## Requirements addressed

REQ-INT-1, REQ-INT-2, REQ-INT-8, REQ-VERIFY-2, REQ-VERIFY-5, REQ-SEL-7

## Background

Tasks 3.1–4.4 now provide a public lazy load-to-render path using CPU selection and pinned pages only.

## Files to modify/create

- `tests/lite/integration/mesh-lod/mesh-lod-coarse-path.test.ts`
- `tests/lite/build/mesh-lod-tree-shaking.test.ts`
- `tests/lite/parity/bundle-size.spec.ts` — explicit absence check for MeshLoD modules/chunks in existing scenes.
- `tests/lite/no-webgpu/mesh-lod-import.test.ts`

## APIs and structs involved

- Public facade/load/instance/scene APIs.
- Runtime chunk names/module IDs discovered from bundle-info rather than hardcoded hashes.

## Implementation details

1. Add an integration fixture that loads a compact `.mlod`, creates a PBR material/instance, registers a scene, and records coarse draw output.
2. Simulate delayed/failed fine page reads and assert no holes/asset failure.
3. Add build tests showing unrelated imports do not retain MeshLoD runtime/PBR/WGSL/decoder modules.
4. Extend runtime module inspection in `bundle-size.spec.ts` so every existing non-MeshLoD scene rejects `/mesh-lod/` and `pbr-mesh-lod-*`.
5. Run targeted unit/integration/build tests.
6. Because engine files changed, run mandatory `pnpm test`; do not run performance tests or change ceilings/goldens.

## Targeted tests

- `mesh-lod-coarse-path.test.ts`
- `mesh-lod-tree-shaking.test.ts`
- Existing bundle-size/parity suite through `pnpm test`.

## Gotchas

- Dynamic chunks emitted but never fetched are acceptable; runtime fetches are the gate.
- Do not raise bundle ceilings.

## Dependencies

- Tasks 3.1–4.4.

## Verification checklist

- [ ] Non-MeshLoD scenes fetch no feature chunks.
- [ ] Coarse render survives unavailable fine data.
- [ ] Targeted tests pass.
- [ ] Mandatory `pnpm test` passes with unchanged ceilings/goldens.
