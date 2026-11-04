# Module: Bounded inverse interpolation

> Package path: `packages/babylon-lite/src/math/inverse-lerp.ts`

## Purpose and public API

```ts
export function inverseLerp(a: number, b: number, value: number): number;
```

Import `inverseLerp` from `@babylonjs/lite`. It calculates the parameter of `value` between endpoints `a` and `b`, clamped to [0, 1], matching Babylon.js `Scalar.InverseLerp`. Both increasing and decreasing intervals are supported.

## Algorithm and state

If `a === b`, return 0. Otherwise compute `(value - a) / (b - a)` and clamp with `Math.min(1, Math.max(0, parameter))`. The first endpoint yields 0 and the second yields 1; values outside the interval saturate according to endpoint order. Non-finite inputs follow ordinary JavaScript arithmetic, including propagation of NaN from an indeterminate ratio.

The function is pure and allocates nothing. It has no dependencies, import-time initialization, caches, ownership or lifecycle. GPU pipelines and shaders do not apply. Existing `Lerp` and `Normalize` semantics are unchanged.

## Compatibility and isolation

Compat `Scalar.InverseLerp(a, b, value)` forwards to the native root helper without implementing the math. The public names/signatures are preserved; only the incorrect extrapolation outside the interval is corrected. Unused native imports must disappear completely from a consumer bundle.

## Test specification

- Direct native tests cover both interval directions, interior/endpoints, outside-range saturation and degenerate intervals.
- Compat regression/control cases verify the Babylon.js-shaped forwarding API against expected outputs.
- Removing either bound must fail corresponding regressions.
- A root import exposes the helper without engine or GPU entry points; an unused import emits identical code.
- Full declarations, lint/types and focused native scene byte controls preserve the existing public/footprint contracts.

## File manifest

`math/inverse-lerp.ts`, native root `index.ts`, compat `math/scalar.ts`, native unit/build tests, compat math tests, this contract and the Scalar support row.
