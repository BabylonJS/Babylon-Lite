# Module: Camera (ArcRotateCamera + FreeCamera)

> Package path: `packages/babylon-lite/src/camera/`

## Purpose

The Camera module provides two camera implementations as plain data objects, plus standalone matrix helpers and companion control functions that wire DOM events to mutate camera properties. Cameras are pure data — they know nothing about the scene or DOM until controls are attached. Both cameras implement the shared `Camera` interface and integrate with the scene's world-matrix hierarchy via `IWorldMatrixProvider` / `IParentable`.

## Public API Surface

### `camera.ts` — Shared Camera Contract

```typescript
/** Minimal camera contract — any camera with world and projection state.
 *  Both ArcRotateCamera and FreeCamera implement this interface.
 *  Plain data, no scene knowledge (pillar 4b). */
export interface Camera {
    fov: number;
    nearPlane: number;
    farPlane: number;
    viewport?: NormalizedViewport;
    children: SceneNode[];
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
    ortho?: OrthographicBounds | null;
}

export function getViewMatrix(camera: Camera): Mat4;
export function getProjectionMatrix(camera: Camera, aspectRatio: number): Mat4;
export function getViewProjectionMatrix(camera: Camera, aspectRatio: number): Mat4;
export function getCameraPosition(camera: Camera): Vec3;
```

### `arc-rotate.ts`

```typescript
/** ArcRotateCamera — orbits around a target point.
 *  Uses Babylon.js convention: left-handed, alpha=rotation around Y, beta=elevation.
 *  Plain data. Does NOT know about the scene.
 *
 *  Push-based dirty tracking: alpha/beta/radius use Object.defineProperty,
 *  target uses ObservableVec3. Changes call wm.markLocalDirty() immediately.
 *
 *  Inertia follows the Babylon.js model: input handlers accumulate per-frame
 *  offsets (inertialAlphaOffset, etc.) which are applied and exponentially
 *  decayed each frame by the controls module. */
export interface ArcRotateCamera extends IWorldMatrixProvider, IParentable {
    alpha: number; // Rotation around Y axis (radians)
    beta: number; // Elevation angle from Y axis (radians, 0=top, π=bottom)
    radius: number; // Distance from target
    target: Vec3; // Orbit center point (ObservableVec3 at runtime)
    fov: number; // Vertical field of view (radians)
    nearPlane: number; // Near clipping plane
    farPlane: number; // Far clipping plane

    inertia: number; // Inertia for rotation & zoom (0=instant, 0.9=default, 1=no decay)
    panningInertia: number; // Inertia for panning (0=instant, 0.9=default)

    inertialAlphaOffset: number; // Per-frame accumulated rotation offset
    inertialBetaOffset: number;
    inertialRadiusOffset: number; // Per-frame accumulated zoom offset
    inertialPanningX: number; // Per-frame accumulated pan offset
    inertialPanningY: number;

    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

/** Create a bare ArcRotateCamera with given params. Pure data, no scene knowledge. */
export function createArcRotateCamera(alpha: number, beta: number, radius: number, target: Vec3): ArcRotateCamera;
```

**Default values** (set in `createArcRotateCamera`):

- `fov = 0.8` (~45.8°)
- `nearPlane = 0.1`
- `farPlane = 1000`
- `inertia = 0.9`
- `panningInertia = 0.9`

### `arc-rotate-controls.ts`

```typescript
/** Attach orbit/zoom/pan controls to an ArcRotateCamera.
 *  Matches Babylon.js ArcRotateCameraPointersInput behavior with inertia.
 *  Input handlers accumulate into the camera's inertial offset properties.
 *  Inertia is applied each frame via scene._beforeRender (single RAF loop).
 *  Returns a cleanup function to remove all event listeners and the beforeRender hook. */
export function attachControl(camera: ArcRotateCamera, canvas: HTMLCanvasElement, scene?: SceneContext): () => void;
```

### `free-camera.ts`

```typescript
/** FreeCamera — positioned in world space, looking at a target point.
 *  Matches Babylon.js FreeCamera: position + target, left-handed.
 *  Plain data. Does NOT know about the scene.
 *
 *  Push-based dirty tracking: position and target use ObservableVec3,
 *  _yaw/_pitch use Object.defineProperty. */
export interface FreeCamera extends Camera, IWorldMatrixProvider, IParentable {
    position: ObservableVec3; // World-space position
    target: ObservableVec3; // Look-at target (auto-updated by controls from yaw/pitch)
    speed: number; // Movement speed (default 2.0, matches BJS)
    angularSensitivity: number; // Mouse rotation sensitivity (higher=less sensitive, default 2000)
    inertia: number; // Inertia damping factor (0=instant stop, 0.9=smooth, default 0.9)
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

/** @internal FreeCamera with internal yaw/pitch state. Not re-exported from index.ts. */
export interface FreeCameraInternal extends FreeCamera {
    _yaw: number;
    _pitch: number;
}

/** Create a FreeCamera at the given position looking at target. Pure data, no scene knowledge. */
export function createFreeCamera(position: Vec3, target: Vec3): FreeCamera;
```

**Default values** (set in `createFreeCamera`):

- `fov = 0.8` (~45.8°)
- `nearPlane = 1`
- `farPlane = 10000`
- `speed = 2.0`
- `angularSensitivity = 2000`
- `inertia = 0.9`

**glTF-loader consumer**: after `enableGltfCameras()` is called, `gltf-feature-camera.ts` (see
module 04, "glTF `camera` Node Property") builds every embedded glTF camera as a `FreeCamera` at
`(0,0,0)` looking toward `(0,0,-1)` — glTF's own local -Z-forward/+Y-up convention — parented
through a `fixupNode` that cancels the engine's RH→LH root mirror. Each imported camera primes its
world transform back to unit scale so the default rigid view inverse remains exact; projection
parameters remain in source glTF units. Zero/non-uniform or animated ancestor scale is not
supported. The loader then exposes the result via `AssetContainer.cameras`.

### `free-camera-controls.ts`

```typescript
/** Attach keyboard + mouse controls to a FreeCamera.
 *  Matches Babylon.js FreeCamera input behavior.
 *  Camera stays plain data — this function reads/writes its properties.
 *  Returns a cleanup function to remove all listeners and the beforeRender hook. */
export function attachFreeControl(camera: FreeCamera, canvas: HTMLCanvasElement, scene?: SceneContext): () => void;
```

### `orthographic.ts` — Opt-in Orthographic Projection

```typescript
/** Live orthographic view-volume extents, in world units. Mutable and animatable:
 *  every setter invalidates the camera's projection cache. A plane left `null` is
 *  derived from `halfHeight` (horizontally scaled by the render aspect ratio). */
export interface OrthographicBounds {
    halfHeight: number;
    left: number | null;
    right: number | null;
    bottom: number | null;
    top: number | null;
}

/** Initial extents — every field optional, omitted planes derived from `halfHeight` (default 1). */
export interface OrthographicBoundsOptions {
    halfHeight?: number;
    left?: number | null;
    right?: number | null;
    bottom?: number | null;
    top?: number | null;
}

/** Switch a camera to an orthographic projection; returns the live `camera.ortho` bounds. */
export function enableOrthographicCamera(camera: Camera, bounds?: OrthographicBoundsOptions): OrthographicBounds;

/** Switch a camera back to its perspective projection. */
export function disableOrthographicCamera(camera: Camera): void;
```

Works with any camera that satisfies the `Camera` contract (ArcRotate, Free, Geospatial) — the projection is orthogonal to how the camera is positioned. Depth still comes from `camera.nearPlane` / `camera.farPlane`; `camera.fov` has no effect in this mode, so an orthographic camera zooms by changing `halfHeight`.

#### Changing extents at runtime

`enableOrthographicCamera` is called once. The bounds it returns (also reachable as `camera.ortho`) stay live, so extents can be driven every frame:

```typescript
const ortho = enableOrthographicCamera(camera, { halfHeight: 6 });
onBeforeRender(scene, () => {
    ortho.halfHeight = 6 + Math.sin(t) * 2; // zoom
});
```

Each field is an accessor that invalidates the camera's projection state on change. That matters because the projection cache is keyed on `_cameraChangeKey` + aspect ratio — neither moves when only the extents do, so without the accessor the new bounds would not be picked up until the camera moved.

Invalidation goes through a dedicated projection revision, **not** merely clearing `_projVer` / `_vpVer` and **not** by marking the camera transform dirty. Clearing the matrix caches alone fixes the getters but not the frame: per-frame consumers gate their GPU uploads on a camera change key, and the forward pass's `_writePassSceneUBO` returns early while `[camera, fog, changeKey, aspect, envRotationY, exposure, contrast, envTextures]` are unchanged (ShaderMaterial, text, clustered lighting, TAA and CSM have equivalent gates). Changing a view volume moves none of those, so a steady-state scene would keep rendering the previously uploaded view-projection even though `getProjectionMatrix` returned a fresh matrix.

Every bounds setter therefore bumps `camera._projRev`, and projection-dependent consumers key on `_cameraChangeKey(camera)`, which sums it with the transform version (and also polls `fov` / `nearPlane` / `farPlane` — see **Projection Change Detection**):

```typescript
camera.worldMatrixVersion + (camera._projRev ?? 0);
```

Both terms are monotonically non-decreasing, so the sum is too and any change in either strictly increases it — it cannot alias. (Same version-summing idiom as `shadow-base.ts` and `gltf-feature-lights-punctual.ts`.)

The revision is deliberately **separate from `worldMatrixVersion`** rather than folded into it. Marking the camera transform dirty would signal camera *motion*, which additionally invalidates the camera's children (the world-matrix state pushes invalidation through `_children`) and, under floating origin, makes `wrapRenderableForFO` rebase **every renderable** in the scene — a per-frame cost if `ortho.halfHeight` is animated, for a change that moved nothing in world space. Transform-only consumers (floating origin, child nodes, mesh UBOs) keep reading `worldMatrixVersion` and are correctly unaffected.

Because the fields are real own enumerable properties (defined via `Object.defineProperty`, not left optional), they also resolve as animation property paths. `resolvePropertyBinding` walks the path with `in` and writes through a plain `target[prop] = value` assignment, which lands on the setter:

```typescript
const clip = createPropertyAnimationClip("orthoZoom", [
    {
        path: "ortho.halfHeight",
        keys: [
            { frame: 0, value: 6 },
            { frame: 60, value: 2 },
        ],
    },
]);
createPropertyAnimationGroup(manager, camera, clip, { fromFrame: 0, toFrame: 60, loop: true });
```

Setting a plane to a number produces an off-center volume (Babylon's `orthoLeft` / `orthoRight` / `orthoBottom` / `orthoTop`); setting it back to `null` returns it to the derived extent.

## Internal Architecture

### Shared World-Matrix Integration

Both camera types use `createWorldMatrixState()` for push-based dirty tracking with the scene's parent–child hierarchy. The camera's local world matrix is computed from its own state (orbital params for ArcRotate, position+target for Free), then optionally multiplied by a parent's world matrix.

The view matrix is derived from the world matrix by transposing the upper 3×3 rotation block and negating the translation:

```
viewMatrix[0..2]   = column 0 of worldMatrix (transposed row 0)
viewMatrix[4..6]   = column 1 of worldMatrix (transposed row 1)
viewMatrix[8..10]  = column 2 of worldMatrix (transposed row 2)
viewMatrix[12..14] = -(rotation^T × eye)
viewMatrix[15]     = 1
```

`getCameraPosition(camera)` reads translation from the final world matrix: `{ x: w[12], y: w[13], z: w[14] }`.

### ArcRotateCamera Position Calculation

The camera's local eye position is computed from spherical coordinates:

```
sinB = sin(beta)    // if sinB == 0, clamp to 0.0001
cosB = cos(beta)
cosA = cos(alpha)
sinA = sin(alpha)

eye.x = target.x + radius * cosA * sinB
eye.y = target.y + radius * cosB
eye.z = target.z + radius * sinA * sinB
```

This is the **Babylon.js left-handed** spherical coordinate convention:

- `alpha` rotates around the Y axis
- `beta` is the polar angle from the +Y axis (0 = looking straight down, π = looking straight up)
- At `alpha = -π/2, beta = π/2`, the camera is on the +Z axis looking at the target

The local world matrix is: transpose(upper 3×3 of view) + eye position.

### ArcRotateCamera Dirty Tracking

`alpha`, `beta`, `radius` use `Object.defineProperty` with setters that call `wm.markLocalDirty()` on change. `target` is an `ObservableVec3` that calls the same dirty callback when any component (x, y, z) is mutated.

### FreeCamera Position & Orientation

The FreeCamera's local world matrix is computed via `mat4LookAtWorldLHToRef(_localMat, position, target, Vec3Up)` — see **World Matrix (all cameras)** below.

Initial yaw/pitch are derived from the position→target direction:

```
dx = target.x - position.x
dy = target.y - position.y
dz = target.z - position.z

_yaw   = atan2(dx, dz)
_pitch = atan2(dy, sqrt(dx² + dz²))
```

### FreeCamera Dirty Tracking

`position` and `target` are `ObservableVec3` instances. `_yaw` and `_pitch` use `Object.defineProperty`. All mutations call `wm.markLocalDirty()`.

### View Matrix

Both cameras use the same world-matrix-to-view inversion (described above). This is equivalent to `mat4LookAtLH(eye, target, Vec3Up)` for their respective eye/target values.

### World Matrix (all cameras)

A camera's local matrix is its **camera-to-world** matrix — cameras parent like any other node, and `getViewMatrix` inverts it per frame. `mat4LookAtWorldLHToRef(out, eye, target, up)` writes it directly as the columns `[xAxis, yAxis, zAxis, eye]`, where the basis is the same one `mat4LookAtLH` derives:

```
zAxis = normalize(target - eye)          // left-handed: +Z looks at the target
xAxis = normalize(cross(up, zAxis))
yAxis = cross(zAxis, xAxis)
```

All three factories (`ArcRotate`, `Free`, `Geospatial`) call it. They previously built a **view** matrix with `mat4LookAtLH` and inverted it back by hand — allocating a `Float32Array`, computing a translation column of three dot products that was immediately overwritten with the eye, then transposing the rotation — with the 17-line transpose block copy-pasted into each factory. Degenerate input (eye on target, or the view direction parallel to `up`) leaves an identity rotation with the eye translation, matching `mat4LookAtLH`'s identity fallback exactly.

### Projection Matrix

Both cameras: `mat4PerspectiveLH(fov, aspectRatio, nearPlane, farPlane)` — left-handed perspective with reverse-Z zero-to-one depth (`nearPlane` maps to `1`, `farPlane` maps to `0`).

### Projection Change Detection

`fov`, `nearPlane` and `farPlane` are plain writable fields on a plain-data camera (pillar 4b′), so a write notifies nobody. Both the matrix caches in `camera.ts` and every projection-dependent per-frame consumer key on `_cameraChangeKey`, which **polls those three by value** and folds any drift into `camera._projRev`:

```typescript
export function _cameraChangeKey(camera: Camera): number {
    if (camera._projFov !== camera.fov || camera._projNear !== camera.nearPlane || camera._projFar !== camera.farPlane) {
        camera._projFov = camera.fov;
        camera._projNear = camera.nearPlane;
        camera._projFar = camera.farPlane;
        camera._projRev = (camera._projRev ?? 0) + 1;
    }
    return camera.worldMatrixVersion + (camera._projRev ?? 0);
}
```

Polling here rather than installing accessors in every camera factory keeps the projection contract in **one** place, costs nothing per camera type, and works for a hand-rolled object satisfying `Camera` — the same reasoning behind `world-matrix-state.ts` polling a foreign parent's version instead of pushing to it. Orthographic bounds are *pushed* instead (see below): that module already owns setters, so pushing is exact and costs the poll nothing.

### Orthographic Projection Seam (zero-cost opt-in)

`camera.ts` holds a module-local `let _orthoProjector = null` plus a single `@internal` setter `_installOrthographicProjector()`, called only from `orthographic.ts`. `getProjectionMatrix` branches on `_orthoProjector !== null && camera.ortho`. When `enableOrthographicCamera` is absent from a bundle the setter tree-shakes, the bundler proves the projector is always `null`, and the entire orthographic branch folds away — perspective-only scenes stay byte-identical. This is the same seam pattern as `_stencilResolver` / `_stdVertexColorFragment` in `standard-pipeline.ts`.

Cache invalidation for live bound changes is deliberately kept out of the shared path: the bounds setters bump `camera._projRev`. Projection-dependent consumers read `_cameraChangeKey(camera)` in place of `camera.worldMatrixVersion`, which is a substitution rather than an extra comparison, so no per-frame gate grows a slot.

`mat4OrthoOffCenterLHToRef` writes a reverse-Z `OrthoOffCenterLH` matrix so orthographic cameras share the engine's reverse-Z depth state (clear `0`, compare `greater`):

```
m[0]  =  2 / (right - left)      m[12] = (left + right) / (left - right)
m[5]  =  2 / (top - bottom)      m[13] = (top + bottom) / (bottom - top)
m[10] = -1 / (far - near)        m[14] = far / (far - near)
m[11] =  0                       m[15] = 1
```

`mat4PerspectiveLHToRef` only writes the terms a perspective matrix needs and relies on the rest of a freshly allocated (zeroed) cache. The orthographic writer overwrites **all 16 elements**, so switching perspective → orthographic on the shared cache is safe unconditionally; the reverse is not symmetric, because `m[12]`, `m[13]` and `m[15]` are written only by the orthographic path, so `disableOrthographicCamera` clears exactly those three before handing `_projCache` back. Optional projectors fully overwriting their output is the contract, so a future third projection type cannot be contaminated by whichever ran before it. That cleanup lives in the lazy module so the shared perspective path pays nothing for it.

### Consumers that still assume a perspective projection

Orthographic support is projection-level; a few features derive screen-space quantities from the projection and need their own handling. Clustered lighting's `projectedSphereBounds` branches on `proj[11] === 0` (1 for perspective, 0 for orthographic — a projection-agnostic discriminator) and uses depth-independent bounds that honour the off-center offsets in `proj[12]` / `proj[13]`; the perspective path divides the silhouette by view depth and ignores those offsets entirely.

Still perspective-only, and therefore **not supported** with an orthographic camera:

| Feature | Assumption |
| --- | --- |
| Gaussian splatting | `1/z` splat sizing and the linear-depth decode in `gs-depth-fragments.ts` |
| Camera gizmo | Always draws a perspective frustum wireframe (`camera-gizmo.ts`) |

Both enable/disable reset the projection state, as does every bounds setter — that is what lets extents change without the camera moving (the projection cache is otherwise keyed on `_cameraChangeKey` + aspect ratio).

### View-Projection Matrix

Both cameras: `mat4Multiply(projectionMatrix, viewMatrix)`.

---

## ArcRotateCamera Controls — Inertia Model

### Sensibility Constants

| Constant             | Value  | Description         |
| -------------------- | ------ | ------------------- |
| `angularSensibility` | `1000` | Babylon default     |
| `panningSensibility` | `50`   | Pixels per unit     |
| `wheelPrecision`     | `3`    | Wheel delta divisor |

### Inertia Epsilon Thresholds

| Constant           | Value    | Used for            |
| ------------------ | -------- | ------------------- |
| `ROTATION_EPSILON` | `0.001`  | Alpha/beta offsets  |
| `RADIUS_EPSILON`   | `0.001`  | Radius offset       |
| `PANNING_EPSILON`  | `0.0001` | Panning X/Y offsets |

### Input Handlers

Input handlers do **not** directly modify camera properties. They accumulate into the camera's `inertial*` offset fields, which are applied and decayed each frame by `applyInertia()`.

#### Left-drag (Rotate)

```
camera.inertialAlphaOffset -= dx / angularSensibility
camera.inertialBetaOffset  -= dy / angularSensibility
```

#### Right-drag (Pan)

```
camera.inertialPanningX += -dx / panningSensibility
camera.inertialPanningY +=  dy / panningSensibility
```

#### Wheel (Zoom)

```
camera.inertialRadiusOffset -= (deltaY * camera.radius) / (wheelPrecision * 1000)
```

Zoom is proportional to current radius (logarithmic feel).

#### Touch Pinch (Zoom — direct, no inertia)

Two-finger pinch directly modifies radius:

```
on touchstart (2 fingers): pinchStartDist = distance between fingers
                            pinchStartRadius = camera.radius
on touchmove (2 fingers):  dist = distance between fingers
                            camera.radius = pinchStartRadius * (pinchStartDist / dist)
                            camera.radius = max(0.01, camera.radius)
```

### Per-Frame Inertia Application (`applyInertia`)

Called each frame via `scene._beforeRender` (or fallback RAF if no scene passed):

```
// Rotation
alpha += inertialAlphaOffset
beta  += inertialBetaOffset
beta = clamp(beta, 0.01, π - 0.01)    // prevent gimbal flip
inertialAlphaOffset *= camera.inertia
inertialBetaOffset  *= camera.inertia
if |offset| < ROTATION_EPSILON: offset = 0

// Zoom
radius -= inertialRadiusOffset
radius = max(0.01, radius)
inertialRadiusOffset *= camera.inertia
if |offset| < RADIUS_EPSILON: offset = 0

// Panning (uses camera.panningInertia, not camera.inertia)
rightX = -sin(alpha)
rightZ =  cos(alpha)
panScale = radius * 0.001
target.x += rightX * inertialPanningX * panScale
target.y += inertialPanningY * panScale
target.z += rightZ * inertialPanningX * panScale
inertialPanningX *= camera.panningInertia
inertialPanningY *= camera.panningInertia
if |offset| < PANNING_EPSILON: offset = 0
```

### Scene Integration

When `scene` is provided to `attachControl`:

- `applyInertia` is registered on `(scene as SceneContextInternal)._beforeRender` — single RAF chain.
- Cleanup removes the callback from `_beforeRender`.

When `scene` is omitted (fallback):

- `applyInertia` self-reschedules via `requestAnimationFrame`.
- Cleanup calls `cancelAnimationFrame`.

### Event Registration

| Event         | Handler         | Options                       |
| ------------- | --------------- | ----------------------------- |
| `pointerdown` | `onPointerDown` | —                             |
| `pointermove` | `onPointerMove` | —                             |
| `pointerup`   | `onPointerUp`   | —                             |
| `wheel`       | `onWheel`       | `{ passive: false }`          |
| `contextmenu` | `onContextMenu` | — (prevents right-click menu) |
| `touchstart`  | `onTouchStart`  | `{ passive: true }`           |
| `touchmove`   | `onTouchMove`   | `{ passive: true }`           |
| `touchend`    | `onTouchEnd`    | —                             |

Pointer capture (`setPointerCapture`/`releasePointerCapture`) keeps drags active outside canvas.

---

## FreeCamera Controls

### Input Bindings

| Key(s)                  | Action                   |
| ----------------------- | ------------------------ |
| `W` / `ArrowUp`         | Move forward (+Z local)  |
| `S` / `ArrowDown`       | Move backward (−Z local) |
| `A` / `ArrowLeft`       | Strafe left (−X local)   |
| `D` / `ArrowRight`      | Strafe right (+X local)  |
| `Space` / `PageUp`      | Move up (+Y world)       |
| `Shift` / `PageDown`    | Move down (−Y world)     |
| Mouse drag (any button) | Look around (yaw/pitch)  |

### Mouse Rotation

Mouse drag accumulates into rotation accumulators:

```
crY += dx / camera.angularSensitivity   // yaw delta
crX += dy / camera.angularSensitivity   // pitch delta
```

### Movement Speed Formula

Matches Babylon.js frame-rate-independent speed calculation:

```
dt = max(deltaMs, 1)
moveSpeed = camera.speed × sqrt(dt² / 100000)
```

### Per-Frame Update

Called each frame via `scene._beforeRender` with `deltaMs`:

```
// 1. Accumulate keyboard input (local space)
cdZ += moveSpeed  (forward/back)
cdX += moveSpeed  (strafe)
cdY += moveSpeed  (up/down)

// 2. Apply rotation
_yaw   += crY
_pitch -= crX
_pitch = clamp(_pitch, -(π/2 - 0.01), π/2 - 0.01)

// 3. Transform local direction → world space
cosY = cos(_yaw),  sinY = sin(_yaw)
position.x += sinY × cdZ + cosY × cdX
position.y += cdY
position.z += cosY × cdZ - sinY × cdX

// 4. Recompute target from yaw/pitch
cosP = cos(_pitch)
target = (position.x + sinY×cosP, position.y + sin(_pitch), position.z + cosY×cosP)

// 5. Decay accumulators (inertia)
cd* *= camera.inertia
cr* *= camera.inertia
if |accumulator| < camera.speed × 0.001: accumulator = 0
```

### Canvas Focus

If the canvas has no `tabindex` attribute, `attachFreeControl` sets `canvas.tabIndex = 0` to make it keyboard-focusable.

### Event Registration

| Event         | Handler         | Options |
| ------------- | --------------- | ------- |
| `pointerdown` | `onPointerDown` | —       |
| `pointermove` | `onPointerMove` | —       |
| `pointerup`   | `onPointerUp`   | —       |
| `contextmenu` | `onContextMenu` | —       |
| `keydown`     | `onKeyDown`     | —       |
| `keyup`       | `onKeyUp`       | —       |

Cleanup removes all 6 event listeners and the `_beforeRender` callback.

---

## Babylon.js Equivalence Map

| Babylon Lite                                         | Babylon.js                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `Camera` interface                                   | `BABYLON.Camera` base class                                                |
| `createArcRotateCamera(alpha, beta, radius, target)` | `new BABYLON.ArcRotateCamera("cam", alpha, beta, radius, target, scene)`   |
| `camera.alpha / beta / radius / target`              | Same property names                                                        |
| `camera.fov` (default 0.8)                           | `camera.fov` (default 0.8)                                                 |
| `camera.nearPlane` / `camera.farPlane`               | `camera.minZ` / `camera.maxZ`                                              |
| `camera.inertia` (default 0.9)                       | `camera.inertia` (default 0.9)                                             |
| `camera.panningInertia` (default 0.9)                | `camera.panningInertia` (default 0.9)                                      |
| `camera.inertialAlphaOffset`                         | `camera.inertialAlphaOffset`                                               |
| `camera.getViewMatrix()`                             | `camera.getViewMatrix()`                                                   |
| `camera.getProjectionMatrix(aspect)`                 | `camera.getProjectionMatrix()`                                             |
| `enableOrthographicCamera(camera, bounds)`           | `camera.mode = Camera.ORTHOGRAPHIC_CAMERA`                                 |
| `camera.ortho.left / right / bottom / top`           | `camera.orthoLeft / orthoRight / orthoBottom / orthoTop`                   |
| `camera.ortho.halfHeight` (aspect-derived width)     | no equivalent — BJS defaults to half the render size in pixels             |
| Animate path `"ortho.halfHeight"`                    | `Animation` on `orthoTop` / `orthoBottom` / …                              |
| `disableOrthographicCamera(camera)`                  | `camera.mode = Camera.PERSPECTIVE_CAMERA`                                  |
| `attachControl(camera, canvas, scene)`               | `camera.attachControl(canvas, true)`                                       |
| `angularSensibility = 1000`                          | `camera.inputs.attached.pointers.angularSensibilityX/Y`                    |
| `panningSensibility = 50`                            | `camera.inputs.attached.pointers.panningSensibility`                       |
| `wheelPrecision = 3`                                 | `camera.inputs.attached.mousewheel.wheelPrecision`                         |
| Left-drag → rotate                                   | `ArcRotateCameraPointersInput` button 0                                    |
| Right-drag → pan                                     | `ArcRotateCameraPointersInput` button 2                                    |
| Wheel → zoom radius                                  | `ArcRotateCameraMouseWheelInput`                                           |
| Pinch → zoom radius (direct, no inertia)             | `ArcRotateCameraPointersInput` multitouch pinch                            |
| Beta clamped to `[0.01, π-0.01]`                     | `camera.lowerBetaLimit / upperBetaLimit`                                   |
| `createFreeCamera(position, target)`                 | `new BABYLON.FreeCamera("cam", position, scene); camera.setTarget(target)` |
| `camera.speed` (default 2.0)                         | `camera.speed` (default 2.0)                                               |
| `camera.angularSensitivity` (default 2000)           | `camera.inputs.attached.mouse.angularSensibility`                          |
| `attachFreeControl(camera, canvas, scene)`           | `camera.attachControl(canvas)`                                             |
| WASD / Arrow keys                                    | `FreeCameraKeyboardMoveInput`                                              |
| Mouse drag → yaw/pitch                               | `FreeCameraMouseInput`                                                     |
| Pitch clamped to ±(π/2 − 0.01)                       | BJS `FreeCameraMouseInput` pitch limits                                    |
| `_yaw` / `_pitch` (internal)                         | BJS internal `_cameraRotationMatrix`                                       |

## Dependencies

- **`camera.ts` imports**: `Vec3`, `Mat4` from `../math/types.js`.
- **`arc-rotate.ts` imports**: `Vec3`, `Mat4` from `../math/types.js`; `Vec3Up` from `../math/vec3.js`; `mat4LookAtWorldLHToRef` from `../math/mat4-look-at-world-lh.js`; `IWorldMatrixProvider`, `IParentable` from `../scene/parentable.js`; `createWorldMatrixState` from `../scene/world-matrix-state.js`; `ObservableVec3` from `../math/observable-vec3.js`.
- **`arc-rotate-controls.ts` imports**: `ArcRotateCamera` from `./arc-rotate.js`; `SceneContext`, `SceneContextInternal` from `../scene/scene.js`.
- **`free-camera.ts` imports**: `Camera` from `./camera.js`; `Vec3`, `Mat4` from `../math/types.js`; `Vec3Up` from `../math/vec3.js`; `mat4LookAtWorldLHToRef` from `../math/mat4-look-at-world-lh.js`; `IWorldMatrixProvider`, `IParentable` from `../scene/parentable.js`; `createWorldMatrixState` from `../scene/world-matrix-state.js`; `ObservableVec3` from `../math/observable-vec3.js`.
- **`free-camera-controls.ts` imports**: `FreeCamera`, `FreeCameraInternal` from `./free-camera.js`; `SceneContext` from `../scene/scene.js`.
- **Depended on by**: `scene.ts` (creates camera), render pipeline (reads camera matrices).

## Test Specification

| Test                                           | Description                                                    |
| ---------------------------------------------- | -------------------------------------------------------------- |
| **ArcRotate**                                  |                                                                |
| `getCameraPosition at alpha=-π/2, beta=π/2`    | Camera should be at `(target.x, target.y, target.z + radius)`  |
| `getCameraPosition at alpha=0, beta=π/2`       | Camera at `(target.x + radius, target.y, target.z)`            |
| `getViewMatrix is valid LH lookAt`             | Multiply view × position should give NDC-like coords           |
| `getProjectionMatrix aspect ratio`             | Verify `m[0] = tan/aspect`, `m[5] = tan`                       |
| `getViewProjectionMatrix = proj × view`        | Compare with manual multiply                                   |
| `beta clamping`                                | Inertia application clamps beta to `[0.01, π-0.01]`            |
| `wheel zoom proportional`                      | Large radius → larger absolute change                          |
| `pan shifts target via inertia`                | Accumulated panning offsets move target, radius unchanged      |
| `pinch zoom`                                   | Two-touch events correctly scale radius directly               |
| `inertia decay`                                | After input stops, offsets decay by `camera.inertia` per frame |
| `cleanup removes all listeners + beforeRender` | After cleanup, events and RAF hook removed                     |
| **FreeCamera**                                 |                                                                |
| `initial yaw/pitch from position→target`       | Verify atan2 computation                                       |
| `WASD movement in local space`                 | W moves along +Z local, A along −X local                       |
| `mouse drag rotates yaw/pitch`                 | Verify angular sensitivity scaling                             |
| `pitch clamped to ±(π/2 − 0.01)`               | Extreme pitch values clamped                                   |
| `inertia decay on accumulators`                | Movement/rotation decay by `camera.inertia`                    |
| `target updated from yaw/pitch`                | Target re-derived each frame from orientation                  |
| `world-to-view matrix consistency`             | View = inverse of world matrix                                 |
| `cleanup removes 6 listeners + beforeRender`   | All handlers detached                                          |
| **Orthographic**                               |                                                                |
| `view volume corners → NDC`                    | Reverse-Z depth (near→1, far→0); x/y independent of depth      |
| `off-center volume`                            | Volume midpoint projects to NDC origin                         |
| `aspect-derived horizontal extent`             | `halfWidth = halfHeight * aspectRatio`                         |
| `revert to perspective`                        | No stale `m[12] / m[13] / m[15]` left in the shared cache      |
| `re-enable re-arms the projection cache`       | Changing `halfHeight` takes effect without a camera move       |
| `live bound mutation`                          | `ortho.halfHeight = x` invalidates proj + viewProj caches      |
| `steady-state scene UBO re-upload`             | Bound change re-opens the real `_writePassSceneUBO` gate       |
| `runtime enable/disable re-upload`             | Toggling after the first frame also re-opens the gate          |
| `projection change is not camera motion`       | `_cameraChangeKey` moves; `worldMatrixVersion`/`worldMatrix` do not |
| `no-op assignment does not re-upload`          | Writing a bound its current value skips the GPU write          |
| `halfHeight is number-only`                    | Planes accept `null`; `halfHeight` cannot go degenerate        |
| `null plane toggles derived/off-center`        | Assigning a number then `null` restores the derived extent     |
| `bounds are own enumerable properties`         | Animation paths like `"ortho.halfHeight"` resolve and write    |
| **Projection parameters**                      |                                                                |
| `fov write rebuilds the projection`            | `m[5] = 1/tan(fov/2)` follows, camera at rest                  |
| `near/far write rebuilds the projection`       | Reverse-Z depth terms `m[10]` / `m[14]` follow                 |
| `propagates through the view-projection cache` | `getViewProjectionMatrix` is not stale either                  |
| `steady-state scene UBO re-upload`             | Each of fov / near / far re-opens the real `_writePassSceneUBO` gate, under perspective and ortho |
| `no-op rewrite does not re-upload`             | Rewriting a parameter with its current value skips the GPU write |

## File Manifest

| File                                 | Size       | Purpose                                                |
| ------------------------------------ | ---------- | ------------------------------------------------------ |
| `src/camera/camera.ts`               | ~15 lines  | Shared `Camera` interface contract                     |
| `src/camera/arc-rotate.ts`           | ~198 lines | ArcRotateCamera data + world matrix + dirty tracking   |
| `src/camera/arc-rotate-controls.ts`  | ~220 lines | ArcRotate pointer/wheel/touch input with inertia model |
| `src/camera/free-camera.ts`          | ~152 lines | FreeCamera data + world matrix + dirty tracking        |
| `src/camera/free-camera-controls.ts` | ~184 lines | FreeCamera keyboard/mouse input with inertia           |
| `src/camera/orthographic.ts`         | ~75 lines  | Opt-in orthographic projection (installs the seam)     |
