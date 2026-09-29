# Task 9.1: Complete Full Validation and Traceability

## Goal

Run the complete converter/runtime/demo validation matrix, prove every requirement, and leave repository artifacts ready for review.

## Requirements addressed

REQ-INT-8, REQ-VERIFY-1, REQ-VERIFY-2, REQ-VERIFY-3, REQ-VERIFY-4, REQ-VERIFY-5, REQ-VERIFY-6

## Background

All implementation milestones are complete. This task changes tests/docs only when a traceability gap is found; it must not weaken thresholds, goldens, or validation.

## Files to modify/create

- `docs/lite/architecture/mesh-lod/validation.md` — requirement-to-command/test evidence.
- `mesh-lod-tool/README.md` — final verified commands/serving notes.
- Existing tests/fixtures only to close identified coverage gaps.
- Generated per-scene bundle manifests required by `pnpm test`.

## APIs and structs involved

- Entire public API and v1 binary/GPU contracts.

## Implementation details

1. Clean configure/build/CTest the converter and validate repeat statue conversion byte equality.
2. Run targeted MeshLoD unit, integration, build, no-WebGPU, and demo suites.
3. Build/package the standalone demo and verify copied assets.
4. Run `pnpm run lint:fix`, `pnpm run lint`, then mandatory `pnpm test`.
5. Inspect runtime bundle-info/manifests: existing scenes fetch no MeshLoD runtime/PBR/WGSL/decoder chunks.
6. Inspect trimmed declarations for no raw GPU handles and exact public API.
7. Confirm all parity MAD and bundle ceilings pass unchanged and no golden references changed.
8. Record every `REQ-*` against concrete passing evidence and note unsupported perf validation as user/CI-only.
9. Remove temporary/debug artifacts and review `git status --short`.

## Targeted tests

- Native CTest.
- MeshLoD Vitest/integration/build/no-WebGPU suites.
- MeshLoD demo Playwright workflow.
- `pnpm test` (build + parity/bundle guardrails).

## Gotchas

- Never run `pnpm test:perf`.
- Never raise ceilings or change golden references.
- Commit regenerated per-scene manifests only when produced by the mandatory engine validation.

## Dependencies

- All prior tasks.

## Verification checklist

- [ ] Every requirement has passing evidence.
- [ ] Converter output is deterministic.
- [ ] All targeted suites pass.
- [ ] Mandatory `pnpm test` passes with no MAD/bundle regression.
- [ ] No temporary files remain.
