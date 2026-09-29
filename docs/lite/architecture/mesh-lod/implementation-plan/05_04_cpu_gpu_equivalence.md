# Task 5.4: Prove CPU/GPU and Render Equivalence

## Goal

Accept GPU selection/rendering only after deterministic equivalence with the CPU oracle and supported ordinary PBR output.

## Requirements addressed

REQ-SEL-2, REQ-VERIFY-3, REQ-RENDER-2, REQ-RENDER-3

## Background

Tasks 5.1–5.3 implement the GPU path. CPU mode remains a diagnostic/reference mode selected by `setMeshLoDSelectionMode`.

## Files to modify/create

- `tests/lite/integration/mesh-lod/mesh-lod-selection-equivalence.test.ts`
- `tests/lite/integration/mesh-lod/mesh-lod-render-equivalence.test.ts`
- `tests/lite/unit/mesh-lod/fixtures/selection-*.json`
- `packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.ts` — normalized testing readback hooks marked internal.

## APIs and structs involved

- `MeshLoDSelectionMode`, selected ID readback, diagnostics.
- Supported PBR material subset.

## Implementation details

1. Run every CPU fixture through GPU selection and compare sorted unique cluster IDs.
2. Compare desired page priorities and hysteresis state transitions.
3. Include perspective/orthographic, frustum boundary, incomplete residency, jitter, and two transformed instances.
4. Instrument render passes to assert one indirect draw per exact asset/material/target/debug key.
5. Compare ordinary decoded geometry and MeshLoD material output in deterministic small rendering fixtures without changing goldens.
6. Keep testing hooks out of trimmed public declarations.
7. Run targeted tests, then mandatory `pnpm test` because engine code changed; never run perf tests.

## Targeted tests

- Named equivalence files above plus existing shader/PBR tests.
- Full `pnpm test`.

## Gotchas

- Ordering may be normalized only if IDs remain unique.
- Do not weaken MAD thresholds or update golden images.

## Dependencies

- Tasks 3.4 and 5.1–5.3.

## Verification checklist

- [ ] All CPU/GPU fixture ID sets match.
- [ ] Page demand/hysteresis state matches.
- [ ] Draw count is batch-scaled, not meshlet-scaled.
- [ ] Mandatory `pnpm test` passes.
