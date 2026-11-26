# Module: Babylon-Compatible Quaternion Euler Conversion

> Package path: `packages/babylon-lite/src/math/quat-babylon-euler.ts`

## Purpose

Provide opt-in quaternion conversion helpers with Babylon.js's yaw/pitch/roll and
alpha/beta/gamma semantics. The module exists separately from Lite's intrinsic
XYZ conversion so compat can match Babylon.js without changing any existing Lite
scene path or bundle.

## Public API Surface

```ts
quatToBabylonEulerTuple(qx: number, qy: number, qz: number, qw: number): [number, number, number]
quatToBabylonAlphaBetaGammaTuple(qx: number, qy: number, qz: number, qw: number): [number, number, number]
```

## Internal Architecture

Both functions are allocation-free except for their returned tuple and depend
only on scalar `Math` operations. They keep the quaternion's scale in the pole
test so non-normalized and zero quaternions follow Babylon.js behavior.

## Pipeline Configuration

None.

## Shader Logic

None.

## State Machine / Lifecycle

None. The helpers are pure functions with no module-level state or side effects.

## Babylon.js Equivalence Map

- `quatToBabylonEulerTuple` mirrors `Quaternion.toEulerAnglesToRef`, including
  the precision-preserving `atan2` pitch calculation and exact-pole threshold.
- `quatToBabylonAlphaBetaGammaTuple` mirrors
  `Quaternion.toAlphaBetaGammaToRef`.

## Dependencies

None.

## Test Specification

- Round-trip yaw/pitch/roll values close to positive and negative 90-degree
  pitch and verify the represented quaternion rotation.
- Verify the exact-pole result and zero-quaternion behavior.
- Verify alpha/beta/gamma conversion against fixed values.

## File Manifest

- `packages/babylon-lite/src/math/quat-babylon-euler.ts`
- `packages/babylon-lite/src/index.ts`
- `tests/lite/unit/math-api-contract.test.ts`
