# Module: Camera (ArcRotateCamera + FreeCamera)
> Package path: `packages/babylon-lite/src/camera/`

## Purpose

The Camera module provides two camera implementations as plain data objects with derived matrix methods, plus companion control functions that wire DOM events to mutate camera properties. Cameras are pure data — they know nothing about the scene or DOM until controls are attached. Both cameras implement the shared `Camera` interface and integrate with the scene's world-matrix hierarchy via `IWorldMatrixProvider` / `IParentable`.

## Public API Surface

### `camera.ts` — Shared Camera Contract

```typescript
/** Minimal camera contract — any camera that can provide view/projection matrices.
 *  Both ArcRotateCamera and FreeCamera implement this interface.
 *  Plain data, no scene knowledge (pillar 4b). */
export interface Camera {
    fov: number;
    nearPlane: number;
    farPlane: number;
    getViewMatrix(): Mat4;
    getProjectionMatrix(aspectRatio: number): Mat4;
    getViewProjectionMatrix(aspectRatio: number): Mat4;
    getPosition(): Vec3;
}
```

### `arc-rotate.ts`

```typescript
/** ArcRotateCamera — orbits around a target point.
 *  Uses Babylon.js convention: left-handed, alpha=rotation around Y, beta=elevation.
 *  Plain data + methods. Does NOT know about the scene.
 *
 *  Push-based dirty tracking: alpha/beta/radius use Object.defineProperty,
 *  target uses ObservableVec3. Changes call wm.markLocalDirty() immediately.
 *
 *  Inertia follows the Babylon.js model: input handlers accumulate per-frame
 *  offsets (inertialAlphaOffset, etc.) which are applied and exponentially
 *  decayed each frame by the controls module. */
export interface ArcRotateCamera extends IWorldMatrixProvider, IParentable {
    alpha: number;          // Rotation around Y axis (radians)
    beta: number;           // Elevation angle from Y axis (radians, 0=top, π=bottom)
    radius: number;         // Distance from target
    target: Vec3;           // Orbit center point (ObservableVec3 at runtime)
    fov: number;            // Vertical field of view (radians)
    nearPlane: number;      // Near clipping plane
    farPlane: number;       // Far clipping plane

    inertia: number;        // Inertia for rotation & zoom (0=instant, 0.9=default, 1=no decay)
    panningInertia: number; // Inertia for panning (0=instant, 0.9=default)

    inertialAlphaOffset: number;   // Per-frame accumulated rotation offset
    inertialBetaOffset: number;
    inertialRadiusOffset: number;  // Per-frame accumulated zoom offset
    inertialPanningX: number;      // Per-frame accumulated pan offset
    inertialPanningY: number;

    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;

    getViewMatrix(): Mat4;
    getProjectionMatrix(aspectRatio: number): Mat4;
    getViewProjectionMatrix(aspectRatio: number): Mat4;
    getPosition(): Vec3;
}

/** Create a bare ArcRotateCamera with given params. Pure data, no scene knowledge. */
export function createArcRotateCamera(
    alpha: number, beta: number, radius: number, target: Vec3,
): ArcRotateCamera;
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
export function attachControl(
    camera: ArcRotateCamera,
    canvas: HTMLCanvasElement,
    scene?: SceneContext,
): () => void;
```

### `free-camera.ts`

```typescript
/** FreeCamera — positioned in world space, looking at a target point.
 *  Matches Babylon.js FreeCamera: position + target, left-handed.
 *  Plain data + methods. Does NOT know about the scene.
 *
 *  Push-based dirty tracking: position and target use ObservableVec3,
 *  _yaw/_pitch use Object.defineProperty. */
export interface FreeCamera extends Camera, IWorldMatrixProvider, IParentable {
    position: ObservableVec3;   // World-space position
    target: ObservableVec3;     // Look-at target (auto-updated by controls from yaw/pitch)
    speed: number;              // Movement speed (default 2.0, matches BJS)
    angularSensitivity: number; // Mouse rotation sensitivity (higher=less sensitive, default 2000)
    inertia: number;            // Inertia damping factor (0=instant stop, 0.9=smooth, default 0.9)
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

### `free-camera-controls.ts`

```typescript
/** Attach keyboard + mouse controls to a FreeCamera.
 *  Matches Babylon.js FreeCamera input behavior.
 *  Camera stays plain data — this function reads/writes its properties.
 *  Returns a cleanup function to remove all listeners and the beforeRender hook. */
export function attachFreeControl(
    camera: FreeCamera,
    canvas: HTMLCanvasElement,
    scene?: SceneContext,
): () => void;
```

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

`getPosition()` reads translation from the final world matrix: `{ x: w[12], y: w[13], z: w[14] }`.

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

The FreeCamera's local world matrix is computed via `mat4LookAtLH(position, target, Vec3Up)`, then extracting the camera-to-world rotation (transpose of upper 3×3) plus position.

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

### Projection Matrix

Both cameras: `mat4PerspectiveLH(fov, aspectRatio, nearPlane, farPlane)` — left-handed perspective with reverse-Z zero-to-one depth (`nearPlane` maps to `1`, `farPlane` maps to `0`).

### View-Projection Matrix

Both cameras: `mat4Multiply(projectionMatrix, viewMatrix)`.

---

## ArcRotateCamera Controls — Inertia Model

### Sensibility Constants

| Constant | Value | Description |
|---|---|---|
| `angularSensibility` | `1000` | Babylon default |
| `panningSensibility` | `50` | Pixels per unit |
| `wheelPrecision` | `3` | Wheel delta divisor |

### Inertia Epsilon Thresholds

| Constant | Value | Used for |
|---|---|---|
| `ROTATION_EPSILON` | `0.001` | Alpha/beta offsets |
| `RADIUS_EPSILON` | `0.001` | Radius offset |
| `PANNING_EPSILON` | `0.0001` | Panning X/Y offsets |

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

| Event | Handler | Options |
|---|---|---|
| `pointerdown` | `onPointerDown` | — |
| `pointermove` | `onPointerMove` | — |
| `pointerup` | `onPointerUp` | — |
| `wheel` | `onWheel` | `{ passive: false }` |
| `contextmenu` | `onContextMenu` | — (prevents right-click menu) |
| `touchstart` | `onTouchStart` | `{ passive: true }` |
| `touchmove` | `onTouchMove` | `{ passive: true }` |
| `touchend` | `onTouchEnd` | — |

Pointer capture (`setPointerCapture`/`releasePointerCapture`) keeps drags active outside canvas.

---

## FreeCamera Controls

### Input Bindings

| Key(s) | Action |
|---|---|
| `W` / `ArrowUp` | Move forward (+Z local) |
| `S` / `ArrowDown` | Move backward (−Z local) |
| `A` / `ArrowLeft` | Strafe left (−X local) |
| `D` / `ArrowRight` | Strafe right (+X local) |
| `Space` / `PageUp` | Move up (+Y world) |
| `Shift` / `PageDown` | Move down (−Y world) |
| Mouse drag (any button) | Look around (yaw/pitch) |

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

| Event | Handler | Options |
|---|---|---|
| `pointerdown` | `onPointerDown` | — |
| `pointermove` | `onPointerMove` | — |
| `pointerup` | `onPointerUp` | — |
| `contextmenu` | `onContextMenu` | — |
| `keydown` | `onKeyDown` | — |
| `keyup` | `onKeyUp` | — |

Cleanup removes all 6 event listeners and the `_beforeRender` callback.

---

## Babylon.js Equivalence Map

| Babylon Lite | Babylon.js |
|---|---|
| `Camera` interface | `BABYLON.Camera` base class |
| `createArcRotateCamera(alpha, beta, radius, target)` | `new BABYLON.ArcRotateCamera("cam", alpha, beta, radius, target, scene)` |
| `camera.alpha / beta / radius / target` | Same property names |
| `camera.fov` (default 0.8) | `camera.fov` (default 0.8) |
| `camera.nearPlane` / `camera.farPlane` | `camera.minZ` / `camera.maxZ` |
| `camera.inertia` (default 0.9) | `camera.inertia` (default 0.9) |
| `camera.panningInertia` (default 0.9) | `camera.panningInertia` (default 0.9) |
| `camera.inertialAlphaOffset` | `camera.inertialAlphaOffset` |
| `camera.getViewMatrix()` | `camera.getViewMatrix()` |
| `camera.getProjectionMatrix(aspect)` | `camera.getProjectionMatrix()` |
| `attachControl(camera, canvas, scene)` | `camera.attachControl(canvas, true)` |
| `angularSensibility = 1000` | `camera.inputs.attached.pointers.angularSensibilityX/Y` |
| `panningSensibility = 50` | `camera.inputs.attached.pointers.panningSensibility` |
| `wheelPrecision = 3` | `camera.inputs.attached.mousewheel.wheelPrecision` |
| Left-drag → rotate | `ArcRotateCameraPointersInput` button 0 |
| Right-drag → pan | `ArcRotateCameraPointersInput` button 2 |
| Wheel → zoom radius | `ArcRotateCameraMouseWheelInput` |
| Pinch → zoom radius (direct, no inertia) | `ArcRotateCameraPointersInput` multitouch pinch |
| Beta clamped to `[0.01, π-0.01]` | `camera.lowerBetaLimit / upperBetaLimit` |
| `createFreeCamera(position, target)` | `new BABYLON.FreeCamera("cam", position, scene); camera.setTarget(target)` |
| `camera.speed` (default 2.0) | `camera.speed` (default 2.0) |
| `camera.angularSensitivity` (default 2000) | `camera.inputs.attached.mouse.angularSensibility` |
| `attachFreeControl(camera, canvas, scene)` | `camera.attachControl(canvas)` |
| WASD / Arrow keys | `FreeCameraKeyboardMoveInput` |
| Mouse drag → yaw/pitch | `FreeCameraMouseInput` |
| Pitch clamped to ±(π/2 − 0.01) | BJS `FreeCameraMouseInput` pitch limits |
| `_yaw` / `_pitch` (internal) | BJS internal `_cameraRotationMatrix` |

## Dependencies

- **`camera.ts` imports**: `Vec3`, `Mat4` from `../math/types.js`.
- **`arc-rotate.ts` imports**: `Vec3`, `Mat4` from `../math/types.js`; `Vec3Up` from `../math/vec3.js`; `mat4LookAtLH`, `mat4PerspectiveLH`, `mat4Multiply`, `mat4Identity` from `../math/mat4.js`; `IWorldMatrixProvider`, `IParentable` from `../scene/parentable.js`; `createWorldMatrixState` from `../scene/world-matrix-state.js`; `ObservableVec3` from `../math/observable-vec3.js`.
- **`arc-rotate-controls.ts` imports**: `ArcRotateCamera` from `./arc-rotate.js`; `SceneContext`, `SceneContextInternal` from `../scene/scene.js`.
- **`free-camera.ts` imports**: `Camera` from `./camera.js`; `Vec3`, `Mat4` from `../math/types.js`; `Vec3Up` from `../math/vec3.js`; `mat4LookAtLH`, `mat4PerspectiveLH`, `mat4Multiply`, `mat4Identity` from `../math/mat4.js`; `IWorldMatrixProvider`, `IParentable` from `../scene/parentable.js`; `createWorldMatrixState` from `../scene/world-matrix-state.js`; `ObservableVec3` from `../math/observable-vec3.js`.
- **`free-camera-controls.ts` imports**: `FreeCamera`, `FreeCameraInternal` from `./free-camera.js`; `SceneContext` from `../scene/scene.js`.
- **Depended on by**: `scene.ts` (creates camera), render pipeline (reads camera matrices).

## Test Specification

| Test | Description |
|---|---|
| **ArcRotate** | |
| `getPosition at alpha=-π/2, beta=π/2` | Camera should be at `(target.x, target.y, target.z + radius)` |
| `getPosition at alpha=0, beta=π/2` | Camera at `(target.x + radius, target.y, target.z)` |
| `getViewMatrix is valid LH lookAt` | Multiply view × position should give NDC-like coords |
| `getProjectionMatrix aspect ratio` | Verify `m[0] = tan/aspect`, `m[5] = tan` |
| `getViewProjectionMatrix = proj × view` | Compare with manual multiply |
| `beta clamping` | Inertia application clamps beta to `[0.01, π-0.01]` |
| `wheel zoom proportional` | Large radius → larger absolute change |
| `pan shifts target via inertia` | Accumulated panning offsets move target, radius unchanged |
| `pinch zoom` | Two-touch events correctly scale radius directly |
| `inertia decay` | After input stops, offsets decay by `camera.inertia` per frame |
| `cleanup removes all listeners + beforeRender` | After cleanup, events and RAF hook removed |
| **FreeCamera** | |
| `initial yaw/pitch from position→target` | Verify atan2 computation |
| `WASD movement in local space` | W moves along +Z local, A along −X local |
| `mouse drag rotates yaw/pitch` | Verify angular sensitivity scaling |
| `pitch clamped to ±(π/2 − 0.01)` | Extreme pitch values clamped |
| `inertia decay on accumulators` | Movement/rotation decay by `camera.inertia` |
| `target updated from yaw/pitch` | Target re-derived each frame from orientation |
| `world-to-view matrix consistency` | View = inverse of world matrix |
| `cleanup removes 6 listeners + beforeRender` | All handlers detached |

## File Manifest

| File | Size | Purpose |
|---|---|---|
| `src/camera/camera.ts` | ~15 lines | Shared `Camera` interface contract |
| `src/camera/arc-rotate.ts` | ~198 lines | ArcRotateCamera data + world matrix + dirty tracking |
| `src/camera/arc-rotate-controls.ts` | ~220 lines | ArcRotate pointer/wheel/touch input with inertia model |
| `src/camera/free-camera.ts` | ~152 lines | FreeCamera data + world matrix + dirty tracking |
| `src/camera/free-camera-controls.ts` | ~184 lines | FreeCamera keyboard/mouse input with inertia |
