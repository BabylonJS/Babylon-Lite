# Module: Look-Direction Matrices

> Package path: `packages/babylon-lite/src/math/write-mat4-from-look-direction-into-buffer.ts`

## Purpose

Build left- and right-handed orientation matrices from normalized, orthogonal
forward and up directions. The helpers write into caller-owned storage so
Babylon.js-shaped adapters can preserve out-parameter identity without
reimplementing orientation math.

## Public API Surface

```ts
function writeMat4FromLookDirectionLHIntoBuffer<T extends Float32Array | Float64Array>(
    out: T,
    forward: Vec3,
    up: Vec3
): T;

function writeMat4FromLookDirectionRHIntoBuffer<T extends Float32Array | Float64Array>(
    out: T,
    forward: Vec3,
    up: Vec3
): T;
```

Both functions require normalized, orthogonal inputs and return `out`.

## Internal Architecture

The module is allocation-free and stateless. It computes the remaining basis
axis directly from the two inputs and writes all 16 matrix elements.

## Pipeline Configuration

Not applicable.

## Shader Logic

Not applicable.

## State Machine / Lifecycle

No retained state or lifecycle.

## Babylon.js Equivalence Map

- `writeMat4FromLookDirectionLHIntoBuffer` matches
  `Matrix.LookDirectionLHToRef`: local `+Z` maps to `forward`, local `+Y` maps
  to `up`, and `right = up × forward`.
- `writeMat4FromLookDirectionRHIntoBuffer` matches
  `Matrix.LookDirectionRHToRef`: local `-Z` maps to `forward`, local `+Y` maps
  to `up`, `back = -forward`, and `left = up × back`.

Both matrices have zero translation and a homogeneous bottom-right value of
one.

## Dependencies

- `Vec3` from `math/types.ts`

## Test Specification

- Identity orientation for each handedness.
- Nontrivial forward direction maps the documented local axis to `forward`.
- Caller-provided storage is returned and translation is reset.
- Both `Float32Array` and `Float64Array` storage remain supported by the generic
  contract.

## File Manifest

- `packages/babylon-lite/src/math/write-mat4-from-look-direction-into-buffer.ts`
- `tests/lite/unit/look-direction-matrices.test.ts`
