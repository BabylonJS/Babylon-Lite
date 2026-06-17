# Module: Geospatial Camera

> Package paths:
> `packages/babylon-lite/src/camera/geospatial-camera.ts`
> `packages/babylon-lite/src/camera/geospatial-limits.ts`
> `packages/babylon-lite/src/camera/geospatial-camera-controls.ts`
> `packages/babylon-lite/src/camera/geospatial-camera-fly.ts`

## Purpose

A globe-orbit camera matching Babylon.js `GeospatialCamera`. It orbits a spherical
planet centred at the world origin and is fully described by four parameters:

- `center` — the anchored point on the globe (ECEF coordinates) the camera looks at,
- `yaw` — rotation about the geocentric up axis (0 = north, π/2 = east),
- `pitch` — tilt from looking straight down at the planet centre (0) to the horizon (π/2),
- `radius` — distance from the camera eye to `center` (distinct from `planetRadius`).

Setting any of these recomputes the derived eye `position`, `upVector`, and the
camera's world matrix. The camera is **pure state** (Lite pillar 4b): it never
references the scene; all behaviour lives in standalone functions.

## Public API Surface

```ts
interface GeospatialCameraOptions {
    planetRadius: number;
}

// Core
function createGeospatialCamera(options: GeospatialCameraOptions): GeospatialCamera;
function setGeospatialOrientation(camera: GeospatialCamera, orientation: GeospatialOrientation): void;
//   GeospatialOrientation = { yaw?, pitch?, radius?, center? } — omitted fields keep their value.

// Limits
function createGeospatialLimits(planetRadius: number): GeospatialLimits;
function getEffectivePitchMax(limits: GeospatialLimits, currentRadius: number): number;
function clampZoomDistance(limits, zoomDistance, currentRadius, distanceToTarget?): number;

// Controls (interactive) — returns a disposer
function attachGeospatialControls(
    camera: GeospatialCamera, canvas: HTMLCanvasElement, scene: SceneContext,
    options?: { zoomToCursor?: boolean; checkCollisions?: boolean }
): () => void;

// Animation
function flyGeospatialCameraToAsync(
    camera: GeospatialCamera, scene: SceneContext, options: GeospatialFlyOptions
): Promise<void>;
//   GeospatialFlyOptions = { yaw?, pitch?, radius?, center?, durationMs?, centerHopScale? }

// Math helpers (exported for reuse / testing)
function computeLocalBasis(worldPos, refEast, refNorth, refUp): void;
function computeLookAtFromYawPitch(yaw, pitch, center, result): Vec3;
function computeYawPitchFromLookAt(lookAt, center, currentYaw, result): { x, y };
function clampCenterFromPoles(center): Vec3;
function normalizeRadians(angle: number): number;
```

Usage:

```ts
const cam = createGeospatialCamera({ planetRadius: 100 });
cam.fov = 0.8;
cam.nearPlane = 1;
cam.farPlane = 100 * 16;
setGeospatialOrientation(cam, { center: { x: 100, y: 0, z: 0 }, radius: 170, yaw: 0.6, pitch: 0.85 });
scene.camera = cam;

// Interactive:
const dispose = attachGeospatialControls(cam, canvas, scene, { zoomToCursor: true });
// Animated:
await flyGeospatialCameraToAsync(cam, scene, { yaw: 1.2, radius: 250, durationMs: 1500 });
```

## Internal Architecture

`GeospatialCamera extends Camera, IWorldMatrixProvider, IParentable`. The camera
stores `center/yaw/pitch/radius` plus derived `position`, `upVector`, and a private
`_lookAt`. The public scalar properties (`yaw`, `pitch`, `radius`, `center`) are
getters/setters that re-run the orientation math via the internal
`_setOrientation(yaw, pitch, radius, center)` closure.

### World matrix (Camera contract)

Like `FreeCamera`, the camera produces a **local-world matrix** built from a
`LookAtLH(position, position + lookAt, upVector)` view, transposed back to a
camera-to-world rotation with `position` as the translation column. The shared
`getViewMatrix(camera)` (in `camera.ts`) re-derives the view matrix from
`worldMatrix` (`R = transpose(world.R)`, `t = -R · eye`), so no bespoke view-matrix
code is needed. `worldMatrixVersion` is bumped on every orientation change via the
shared `world-matrix-state` helper, which feeds the view/projection caches.

## Orientation Math (`geospatial-camera.ts`)

This is a faithful left-handed port of Babylon.js `GeospatialCamera._setOrientation`
and `ComputeLocalBasisToRefs` / `ComputeLookAtFromYawPitchToRef`.

`_setOrientation(yaw, pitch, radius, center)`:
1. `yaw = NormalizeRadians(yaw)`, `pitch = NormalizeRadians(pitch)`, copy `center`.
2. **Clamp to limits:** `yaw → [yawMin, yawMax]`, `pitch → [pitchMin, getEffectivePitchMax(radius)]`,
   `radius → [radiusMin, radiusMax]`, then `clampCenterFromPoles(center)`.
3. **Local basis** at `center` (left-handed): `up = normalize(center)`,
   `east = cross(up, +Z)` (with `cross(up, +X)` fallback at the poles),
   `north = cross(east, up)`.
4. **lookAt:** `horiz = north·cos(yaw) + east·sin(yaw)`;
   `lookAt = normalize(horiz·sin(pitch) − up·cos(pitch))`.
5. **Camera up:** `right = cross(up, lookAt)` (fallback `cross(horiz, lookAt)` when
   looking straight down); `upVector = normalize(cross(lookAt, right))`.
6. **Eye:** `position = center − lookAt·radius`; mark the world matrix dirty.

`computeYawPitchFromLookAt` is the exact inverse (used by the controls' pan/zoom
recentre path): `cosPitch = −(lookAt · up)`, `pitch = acos(cosPitch)`,
`lookHorizontal = lookAt + up·cosPitch`, and `yaw = atan2(lookHorizontal·east, lookHorizontal·north)`.

### Handedness note

Babylon's left-handed branch defines `east = cross(up, worldNorth)` with
`worldNorth = +Z` (`LeftHandedForwardReadOnly`). Lite is left-handed
(`useRightHandedSystem = false`), so this branch is used verbatim — the
right-handed cross-product order is intentionally **not** ported.

## Limits (`geospatial-limits.ts`)

Mirrors Babylon defaults: `radiusMin = 10`, `radiusMax = planetRadius·4`,
`pitchMin = ε (0.001)`, `pitchMax = π/2 − 0.01`, `yawMin/Max = ∓∞`,
`pitchDisabledRadiusScale = { x: 2, y: 4 }`.

`getEffectivePitchMax(radius)` linearly fades the allowed pitch from `pitchMax`
down to `pitchMin` as the radius grows from `x·planetRadius` to `y·planetRadius`,
so a fully zoomed-out camera looks straight down. **Consequence:** when setting
pose imperatively via individual setters, set `radius` before `pitch` (or use
`setGeospatialOrientation`, which applies all four radius-aware in one call).

## Movement / Controls (`geospatial-camera-controls.ts`)

`attachGeospatialControls` ports Babylon's framerate-independent physics model
(`GeospatialCameraMovement` + `CameraMovement`): per-frame input pixel deltas
accumulate into velocities that decay with per-axis inertia
(`frameDecay = inertia^(Δt / (1000/60))`), integrated once per frame from
`scene._beforeRender` (which receives the frame `deltaMs`).

Interactions:
- **Left-drag** — pan; the cursor stays anchored to the globe via a drag-plane
  (a plane tangent at the picked surface point), recentring with
  `computeYawPitchFromLookAt`.
- **Middle/right-drag** — rotate (yaw + pitch/tilt) at `π/500` rad per pixel.
- **Wheel** — zoom; toward the cursor by default (`zoomToCursor`), else along the
  look vector. Zoom speed scales with distance to the target and is suppressed
  while dragging/rotating. `zoomInertia = 0.9` (others 0 by default).
- **Touch** — single-finger drag pans (via pointer events); a two-finger pinch
  zooms toward the centroid (analytic raycast) and promotes to a pan once the
  centroid drifts ≥ 20 px. Pointer-driven pan/rotate is suppressed while two
  fingers are down, and `gesture*`/native pinch-zoom are prevented.
- **Keyboard** — arrows pan (drag from the canvas centre), Ctrl+arrows tilt
  (pitch/yaw), +/− zoom along the look vector.
- **Collision** (`checkCollisions`) — clamps the eye so it cannot dip below the surface.

### Globe picking — analytic ray-sphere (key simplification)

Because the globe is an origin-centred sphere of `planetRadius`, picking does **not**
require a mesh-picking subsystem. A picking ray from `createPickingRay` is
intersected analytically with the sphere (quadratic `a = 1`, `b = 2·O·D`,
`c = O·O − R²`), taking the nearest positive root. This is the main structural
deviation from Babylon's generic `scene.pick` approach and keeps the module
self-contained.

## Fly-To Animation (`geospatial-camera-fly.ts`)

`flyGeospatialCameraToAsync` tweens `yaw/pitch/radius/center` over `durationMs`
with a cubic ease-in-out (matching `CubicEase` `EASEINOUT`), driven from
`scene._beforeRender`. Yaw takes the shortest angular path; `center` follows a
great-circle (ECEF slerp) with an optional parabolic hop (`centerHopScale`).
Only one flight runs at a time: the camera stores a `_cancelFly` callback that
`attachGeospatialControls` invokes on user input (interrupting the flight) and
that a subsequent `flyGeospatialCameraToAsync` call invokes before starting.

## Babylon.js Equivalence Map

| Babylon.js | Babylon Lite |
|---|---|
| `GeospatialCamera._setOrientation` | `applyOrientation` (closure in `geospatial-camera.ts`) |
| `ComputeLocalBasisToRefs` (LH branch) | `computeLocalBasis` |
| `ComputeLookAtFromYawPitchToRef` | `computeLookAtFromYawPitch` |
| `ComputeYawPitchFromLookAtToRef` | `computeYawPitchFromLookAt` |
| `ClampCenterFromPolesInPlace` | `clampCenterFromPoles` |
| `GeospatialLimits` + `getEffectivePitchMax` | `geospatial-limits.ts` |
| `GeospatialCameraMovement` / `CameraMovement` | physics in `attachGeospatialControls` |
| `scene.pick` against globe mesh | analytic ray-sphere `intersectPlanet` |
| `flyToAsync` + `InterpolatingBehavior` | `flyGeospatialCameraToAsync` |
| `Matrix.LookAtLHToRef(pos, center, up)` | `getViewMatrix` from camera world matrix |

## Bundle Discipline

All geospatial code lives in four new `camera/` modules reached only through their
own `index.ts` exports; scenes that never create a geospatial camera pay zero
bytes. The core (`geospatial-camera.ts` + `geospatial-limits.ts`) has no
dependency on the controls or fly modules, so a static-pose scene need not pull in
the interactive physics.

## Dependencies

`camera` (`Camera`, `getViewProjectionMatrix`), `scene/world-matrix-state`,
`scene/parentable`, `math/_matrix-allocator`, `math/mat4-look-at-lh`,
`math/mat4-invert`, `picking/ray` (`createPickingRay`), `scene/scene-core`
(`SceneContext` type + `_beforeRender`).

## Test Specification

`tests/lite/parity/scenes/scene225-geospatial-camera.spec.ts` — captures the BJS
`GeospatialCamera` oracle (`captureGolden({ force: true })`) and compares the Lite
render of `scene225.html`: a blue globe (`planetRadius = 100`) with six coloured
surface marker cubes, viewed from a fixed deterministic pose
(`center = ECEF(20°, 30°)`, `radius = 170`, `yaw = 0.6`, `pitch = 0.85`) with no
controls attached. The markers break the sphere's rotational symmetry so yaw is
observable. Threshold `maxMad` lives in `scene-config.json`.

## File Manifest

- `camera/geospatial-camera.ts` — interface, factory, orientation math, basis helpers, fly-state fields.
- `camera/geospatial-limits.ts` — `GeospatialLimits` + clamp/effective-pitch helpers.
- `camera/geospatial-camera-controls.ts` — interactive movement physics, analytic picking, pan/zoom/rotate/keyboard/collision.
- `camera/geospatial-camera-fly.ts` — ease-in-out fly-to with ECEF slerp + hop.
- `lab/lite/src/lite/scene225.ts`, `lab/lite/scene225.html` — Lite demo scene.
- `lab/lite/src/bjs/scene225.ts`, `lab/lite/babylon-ref-scene225.html` — BJS oracle.
- `reference/lite/scene225-geospatial-camera/babylon-ref-golden.png` — golden (captured at test time).
