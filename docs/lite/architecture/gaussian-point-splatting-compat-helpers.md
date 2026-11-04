# Module: Gaussian Point Splatting Compat Helpers

> Package path: `packages/babylon-lite/src/math/gaussian-point-splatting-compat-helpers.ts`

## Purpose

Provide the two deterministic CPU calculations used by Babylon.js's Gaussian
Point Splatting renderer so the compat package can forward its public root
exports without owning renderer behavior.

## Internal API Surface

```ts
function _hasGaussianPointSplattingProjectedDepth(projection: Mat4): boolean;
function _getGaussianPointSplattingPackedShBytesPerSplat(shDegree: number): number;
```

Both exports are marked `@internal` and are removed from the published Lite
declarations. They remain available at runtime through the single root entry
point for the separately published compat package.

## Internal Architecture

The module is stateless and allocation-free. Projected-depth detection reads
the four projection elements that couple clip-space depth or homogeneous W to
view-space X/Y. Packed SH sizing maps degrees 1-4 to coefficient dimensions
3, 8, 15, and 24, then rounds three 8-bit color channels per coefficient to a
four-byte boundary. Degree 0 and negative values require no SH storage.

## Pipeline Configuration

Not applicable.

## Shader Logic

Not applicable.

## State Machine / Lifecycle

No retained state or lifecycle.

## Babylon.js Equivalence Map

- `_hasGaussianPointSplattingProjectedDepth` backs
  `_HasGaussianPointSplattingProjectedDepth`.
- `_getGaussianPointSplattingPackedShBytesPerSplat` backs
  `_GetPackedShBytesPerSplat`.

## Dependencies

- `Mat4` from `math/types.ts`

## Test Specification

- Standard perspective projections report no X/Y-dependent projected depth.
- Off-axis depth and W terms report projected depth.
- SH degrees 0-4 return the exact packed byte counts.

## File Manifest

- `packages/babylon-lite/src/math/gaussian-point-splatting-compat-helpers.ts`
- `tests/lite/unit/gaussian-point-splatting-compat-helpers.test.ts`
