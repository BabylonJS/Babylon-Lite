# Module: Vector Spherical Interpolation

> Package path: `packages/babylon-lite/src/math/slerp-vec3-to-ref.ts`

## Purpose

Provide an allocation-free, tree-shakeable spherical interpolation primitive for three-component vectors. The function matches Babylon.js `Vector3.SlerpToRef`, including clamped interpolation, independent magnitude interpolation, and stable handling of opposite or nearly opposite directions.

## Public API Surface

```ts
function slerpVec3ToRef<T extends Vec3>(start: Vec3, end: Vec3, amount: number, result: T): T;
```

`amount` is clamped to `[0, 1]`. The function writes into and returns `result`; it never mutates `start` or `end`.

## Internal Architecture

The module is a standalone pure function with no caches, engine state, or module-level allocations. It imports only the erased `Vec3` type and is re-exported from the package root. Existing Lite modules and scenes do not import it, so consumers pay for it only when selected by tree-shaking.

## Pipeline Configuration

None.

## Shader Logic

None.

## State Machine / Lifecycle

None.

## Babylon.js Equivalence Map

- `slerpVec3ToRef` corresponds to `Vector3.SlerpToRef`.
- Directions use spherical interpolation while magnitudes use linear interpolation.
- Nearly parallel directions use linear direction weights.
- Opposite and nearly opposite directions rotate around the measured cross-product axis, or a deterministic perpendicular axis when the inputs are exactly opposite.
- An interpolation amount of `1` returns the exact end components for the antipodal path.

## Dependencies

- `Vec3` from `math/types.ts` (type-only).

## Test Specification

- Preserves magnitude and advances linearly around the sphere for exactly opposite vectors.
- Follows the side selected by a nearly opposite end direction without numerical blow-up.
- Interpolates vector magnitude independently from direction.
- Clamps amounts below `0` and above `1`.
- Leaves both operands unchanged and returns the supplied result object.

## File Manifest

- `packages/babylon-lite/src/math/slerp-vec3-to-ref.ts` — public pure function.
- `tests/lite/unit/vector-slerp.test.ts` — focused unit coverage.
