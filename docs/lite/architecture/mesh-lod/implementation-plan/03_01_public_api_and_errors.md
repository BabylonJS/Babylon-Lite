# Task 3.1: Add Public State APIs and Stable Errors

## Goal

Create the tree-shakable MeshLoD facade, exact v1 public state types, option validation, and stable error model without loading runtime implementation.

## Requirements addressed

REQ-INT-1, REQ-INT-3, REQ-INT-5, REQ-INT-6, REQ-NAME-1

## Background

Phase 2 created deterministic assets. Public values must be plain state, contain no scene references, expose no WebGPU handles, and dynamically import runtime behavior only when called.

## Files to modify/create

- `packages/babylon-lite/src/mesh-lod/mesh-lod.ts` — exact public declarations and lazy standalone functions.
- `packages/babylon-lite/src/mesh-lod/mesh-lod-errors.ts` — codes/context/type guard.
- `packages/babylon-lite/src/index.ts` — grouped facade exports.
- `packages/babylon-lite/package.json` — optional internal testing subpath only.
- `tests/lite/unit/mesh-lod/mesh-lod-api.test.ts`
- `tests/lite/no-webgpu/mesh-lod-import.test.ts`

## APIs and structs involved

All `MeshLoDSource`, option/state/metadata/diagnostics/asset/instance/error types and functions listed in architecture section 5.

## Implementation details

1. Copy the architecture signatures exactly, placing internal state directly on public objects with `@internal`.
2. Implement facade functions as dynamic imports of `mesh-lod-runtime.ts`/scene/runtime modules.
3. Validate numeric/default relationships before starting network work.
4. Implement `MeshLoDError` construction and `isMeshLoDError` with stable contextual fields.
5. Ensure import alone allocates no `Map`, `Set`, `WeakMap`, registers nothing, and does not dereference WebGPU globals.
6. Add declaration tests/scans proving raw GPU handles do not appear in public MeshLoD declarations.

## Targeted tests

- API shape/default/error tests.
- No-WebGPU package import test.
- Build declaration inspection after later package build.

## Gotchas

- Do not split `MeshLoDAsset` into public/internal companion types.
- Do not statically import runtime, PBR, WGSL, or decoder modules.

## Dependencies

- Phase 2 format decisions.

## Verification checklist

- [ ] Public signatures match architecture.
- [ ] Importing the facade has no side effects.
- [ ] Invalid options return `MLOD_INVALID_OPTION`.
- [ ] Public types expose no raw GPU handles.
