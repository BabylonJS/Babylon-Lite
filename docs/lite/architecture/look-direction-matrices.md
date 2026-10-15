# Module: Look-Direction Matrices

> Package paths:
>
> - `packages/babylon-lite/src/math/write-mat4-from-look-direction-into-buffer.ts`
> - `packages/babylon-lite/src/math/write-quat-from-rotation-mat4-into-ref.ts`

## Purpose

Build left- and right-handed orientation matrices from normalized, orthogonal
forward and up directions. The helpers write into caller-owned storage so
Babylon.js-shaped adapters can preserve out-parameter identity without
reimplementing orientation math.

The matrix-to-quaternion companion writes into caller-owned quaternion storage,
allowing adapters to preserve output-reference identity without allocating an
intermediate quaternion.

## Public API Surface

```ts
function writeMat4FromLookDirectionLHIntoBuffer<T extends Float32Array | Float64Array>(out: T, forward: Vec3, up: Vec3): T;

function writeMat4FromLookDirectionRHIntoBuffer<T extends Float32Array | Float64Array>(out: T, forward: Vec3, up: Vec3): T;

function writeQuatFromRotationMat4IntoRef<T extends Quat>(matrix: Mat4, out: T): T;
```

The look-direction functions require normalized, orthogonal inputs. Every
function returns its caller-owned output object.

## Internal Architecture

The modules are allocation-free and stateless. The look-direction writers
compute the remaining basis axis directly from the two inputs and write all 16
matrix elements. The quaternion writer delegates the matrix basis to Lite's
shared `_quatFromRotationBasis` conversion with the caller's output object.

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

- `writeQuatFromRotationMat4IntoRef` matches
  `Quaternion.FromRotationMatrixToRef`, writing the matrix's rotation into the
  supplied quaternion without allocating.

## Dependencies

- `Vec3` from `math/types.ts`
- `Mat4` and `Quat` from `math/types.ts`
- `_quatFromRotationBasis` from `math/create-quat-from-rotation-mat4.ts`

## Test Specification

- Identity orientation for each handedness.
- Nontrivial forward direction maps the documented local axis to `forward`.
- Caller-provided storage is returned and translation is reset.
- Both `Float32Array` and `Float64Array` storage remain supported by the generic
  contract.
- Matrix-to-quaternion conversion returns and mutates caller-owned storage.

## File Manifest

- `packages/babylon-lite/src/math/write-mat4-from-look-direction-into-buffer.ts`
- `packages/babylon-lite/src/math/write-quat-from-rotation-mat4-into-ref.ts`
- `tests/lite/unit/look-direction-matrices.test.ts`
