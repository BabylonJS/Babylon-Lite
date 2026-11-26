# Module: Babylon-Compatible Quaternion Euler Conversion

> Package path: `packages/babylon-lite/src/math/quat-babylon-euler.ts`

## Purpose

Provide opt-in quaternion conversion helpers with Babylon.js's yaw/pitch/roll and
alpha/beta/gamma semantics. The module exists separately from Lite's intrinsic
XYZ conversion so compat can match Babylon.js without changing any existing Lite
scene path or bundle.

## Public API Surface

```ts
quatToBabylonEulerToRef<T extends Vec3>(qx: number, qy: number, qz: number, qw: number, out: T): T
quatToBabylonAlphaBetaGammaToRef<T extends Vec3>(qx: number, qy: number, qz: number, qw: number, out: T): T
```

## Internal Architecture

Both functions are allocation-free and write directly into caller-owned
storage. They depend only on scalar `Math` operations and keep the quaternion's
scale in the pole test so non-normalized and zero quaternions follow Babylon.js
behavior.

## Pipeline Configuration

None.

## Shader Logic

None.

## State Machine / Lifecycle

None. The helpers are pure functions with no module-level state or side effects.

## Babylon.js Equivalence Map

- `quatToBabylonEulerToRef` mirrors `Quaternion.toEulerAnglesToRef`, including
  the precision-preserving `atan2` pitch calculation and exact-pole threshold.
- `quatToBabylonAlphaBetaGammaToRef` mirrors
  `Quaternion.toAlphaBetaGammaToRef`.

## Dependencies

None.

## Test Specification

- Round-trip yaw/pitch/roll values close to positive and negative 90-degree
  pitch and verify the represented quaternion rotation.
- Verify both exact-pole results with nonzero yaw and roll, including a scaled
  non-unit quaternion, plus zero-quaternion behavior.
- Verify alpha/beta/gamma conversion against fixed values.

## File Manifest

- `packages/babylon-lite/src/math/quat-babylon-euler.ts`
- `packages/babylon-lite/src/index.ts`
- `tests/lite/unit/math-api-contract.test.ts`
