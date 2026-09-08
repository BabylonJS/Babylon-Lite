# Module: World-to-Screen Projection

> Package path: `packages/babylon-lite/src/camera/world-to-screen.ts`

## Purpose

The world-to-screen projection module converts a world-space `Vec3` into canvas backing-store pixels and canvas-relative CSS pixels. It is a pure CPU math helper: it does not create or position DOM overlays, read global browser state, or retain camera/surface state.

The caller supplies the camera's view matrix and view-projection matrix. This keeps the hot projection function general-purpose and lets a caller cache the matrices once per frame. The existing camera and viewport helpers derive the active render state:

```typescript
const backingWidth = surface.canvas.width;
const backingHeight = surface.canvas.height;
const view = getViewMatrix(camera);
const viewProjection = getViewProjectionMatrix(camera, getEffectiveAspectRatio(camera, backingWidth, backingHeight));
const viewport = resolveCameraViewport(camera, backingWidth, backingHeight);
```

For a DOM canvas, pass its current canvas-relative CSS dimensions as `cssWidth` and `cssHeight` (normally `clientWidth` / `clientHeight`, or `getBoundingClientRect()` dimensions when CSS transforms must be included). For an `OffscreenCanvas`, the host supplies the visible canvas's CSS dimensions alongside the backing size. Omitting the CSS dimensions makes CSS coordinates equal backing-pixel coordinates.

## Public API Surface

```typescript
export interface ScreenProjectionOptions {
    /** Active viewport in canvas backing pixels, with top-left origin. */
    viewport: PixelViewport;
    /** Full canvas backing-store dimensions in device pixels. */
    backingWidth: number;
    backingHeight: number;
    /** Canvas-relative CSS dimensions. Both must be supplied together. */
    cssWidth?: number;
    cssHeight?: number;
}

export interface ScreenProjectionResult extends Vec3 {
    /** Canvas backing-pixel X coordinate. */
    x: number;
    /** Canvas backing-pixel Y coordinate. */
    y: number;
    /** WebGPU NDC depth. In Lite's reverse-Z cameras, near=1 and far=0. */
    z: number;
    /** Canvas-relative CSS pixel coordinate. */
    cssX: number;
    cssY: number;
    /** Homogeneous clip-space W before perspective divide. */
    clipW: number;
    /** True when the point's left-handed view-space Z is <= 0. */
    behindCamera: boolean;
    /** True when the point is outside any WebGPU clip plane or is non-finite. */
    clipped: boolean;
    /** True when the point cannot appear inside the viewport's 2D rectangle. */
    offscreen: boolean;
}

export function projectWorldToScreenToRef<T extends ScreenProjectionResult>(
    point: Vec3,
    view: Mat4,
    viewProjection: Mat4,
    options: ScreenProjectionOptions,
    result: T
): T;

export function projectWorldToScreen(
    point: Vec3,
    view: Mat4,
    viewProjection: Mat4,
    options: ScreenProjectionOptions
): ScreenProjectionResult;
```

`projectWorldToScreenToRef` performs no allocations and returns the exact `result` object supplied by the caller. `projectWorldToScreen` is the convenience form and allocates one result object.

## Projection Contract

Babylon Lite matrices are column-major and cameras are left-handed. For world point `(x, y, z)`, the helper computes:

```text
viewZ = view[2]*x + view[6]*y + view[10]*z + view[14]

clipX = vp[0]*x + vp[4]*y + vp[8]*z  + vp[12]
clipY = vp[1]*x + vp[5]*y + vp[9]*z  + vp[13]
clipZ = vp[2]*x + vp[6]*y + vp[10]*z + vp[14]
clipW = vp[3]*x + vp[7]*y + vp[11]*z + vp[15]

ndcX = clipX / clipW
ndcY = clipY / clipW
ndcZ = clipZ / clipW
```

The view matrix is required separately because homogeneous W identifies the camera-facing half-space for perspective projections but remains `1` for orthographic projections. Left-handed `viewZ <= 0` identifies behind-camera points correctly for both.

NDC maps into the active top-origin backing-pixel viewport:

```text
canvasX = viewport.x + (ndcX + 1) * viewport.width  / 2
canvasY = viewport.y + (1 - ndcY) * viewport.height / 2
```

The full backing dimensions are used only to map the absolute canvas coordinate to CSS space, so viewport offsets and partial-canvas viewports scale correctly:

```text
cssX = canvasX * cssWidth  / backingWidth
cssY = canvasY * cssHeight / backingHeight
```

This ratio handles device-pixel ratio, `maxDevicePixelRatio`, explicit backing-store sizing, and non-integer CSS-to-backing scales without reading `globalThis.devicePixelRatio`.

## Clipped and Offscreen Behavior

- `behindCamera` is true when `viewZ <= 0`.
- `clipped` is true when the point is behind the camera, any calculated coordinate is non-finite, `ndcX` or `ndcY` is outside `[-1, 1]`, or `ndcZ` is outside WebGPU's `[0, 1]` depth range.
- `offscreen` concerns only whether the point can appear in the viewport's 2D rectangle. It is true for behind-camera/non-finite points or when `ndcX` / `ndcY` is outside `[-1, 1]`. A point inside the 2D rectangle but clipped only by near/far depth has `offscreen=false` and `clipped=true`.
- Coordinates are not clamped. Finite points outside the viewport retain their extrapolated backing/CSS coordinates so callers can place edge indicators themselves.
- When `clipW` is zero or any input calculation is non-finite, `x`, `y`, `z`, `cssX`, and `cssY` are `NaN`; all state flags except `behindCamera` report non-displayable behavior (`clipped=true`, `offscreen=true`).
- Backing dimensions and viewport width/height must be positive finite numbers, and viewport x/y must be finite. CSS dimensions, when supplied, must both be positive finite numbers. Invalid options throw `RangeError` instead of returning success-shaped coordinates.

## Internal Architecture

The module has no mutable module state, caches, DOM imports, or module-level allocations. The `ToRef` function reads scalar matrix elements directly and writes all result fields on every call, so reusing a result cannot leak stale CSS coordinates or flags.

The allocating wrapper constructs one plain result object and delegates to `projectWorldToScreenToRef`; it owns no separate math path.

## Babylon.js Equivalence Map

| Babylon Lite | Babylon.js |
| --- | --- |
| `projectWorldToScreen(point, view, viewProjection, options)` | `Vector3.Project(point, Matrix.Identity(), scene.getTransformMatrix(), viewport)` plus backing-to-CSS scaling |
| `projectWorldToScreenToRef(..., result)` | `Vector3.ProjectToRef(...)` plus backing-to-CSS scaling and explicit visibility flags |
| `result.z` | projected `Vector3.z` |
| `result.behindCamera` | explicit view-space test not returned by `Vector3.Project` |
| `result.clipped` / `result.offscreen` | explicit status not returned by `Vector3.Project` |

## Dependencies

- `../math/types.js` — `Vec3`, `Mat4`
- `./viewport.js` — `PixelViewport` type only

Both imports are type-only. The module remains a leaf and adds no runtime dependency edge.

## Test Specification

| Test | Expected behavior |
| --- | --- |
| Perspective center | Camera-forward point maps to viewport center |
| Backing/CSS scaling | DPR-like backing-to-CSS ratio scales both axes |
| Partial viewport | NDC corners and center include viewport offset/extent |
| Behind perspective | `behindCamera`, `clipped`, and `offscreen` are true |
| Behind orthographic | Separate view-space test identifies it despite `clipW=1` |
| XY offscreen | Extrapolated coordinates are retained; both clipped/offscreen true |
| Depth-only clip | Clipped true while offscreen remains false |
| Zero clip W | Coordinates are NaN; clipped/offscreen true |
| ToRef reuse | Exact result identity returned; every field overwritten |
| Invalid dimensions | Non-positive/non-finite backing, viewport, or partial CSS size throws |
| Unused tree shaking | Importing another root export retains zero code from this module |

## File Manifest

| File | Purpose |
| --- | --- |
| `src/camera/world-to-screen.ts` | Pure projection functions and result/options contracts |
| `tests/lite/unit/world-to-screen.test.ts` | Focused math, viewport, CSS, status, and validation coverage |
| `tests/lite/build/world-to-screen-treeshake.test.ts` | Root-export unused-retention regression |
