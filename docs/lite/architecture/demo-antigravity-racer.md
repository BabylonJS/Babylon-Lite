# Module: Antigravity Racer demo

> Source path: `lab/lite/src/demos/antigravity-racer/`
> Entry point: `lab/lite/src/demos/antigravity-racer.ts` + `lab/lite/demo-antigravity-racer.html`
> Reference: Babylon.js playground snippet **WVPVWL#0** (895 lines), node materials **01HFES#76** (track) and **23KY8X#14** (trail).

## Purpose

Reproduce the playground's **look and feel exactly** at its intended 60 Hz tuning, while keeping the
port's modern additions: DOM menus/HUD, pause overlay, QWERTY/AZERTY-independent keyboard, gamepad
support, explicit asset error surfacing, and focused tests.

This document is the formal specification. Every constant, formula and shader listing below is the
contract the implementation must satisfy; the regression tests in
`tests/lite/unit/antigravity-racer-*.test.ts` assert the load-bearing parts of it.

**Simulation model.** The playground ties one simulation step to one rendered frame
(`scene.beforeRender`) and hard-codes 60 Hz constants. The port keeps the _exact per-tick formulas_
and drives them from a fixed 60 Hz accumulator (`FIXED_DT = 1/60`, at most `MAX_STEPS_PER_FRAME = 6`
steps per rendered frame). At 60 Hz the port is tick-for-tick identical to the original; at any other
refresh rate the motion is the same in wall-clock time instead of being refresh-rate dependent. No
per-tick constant is ever converted to a "per second" unit — the previous port's `frameWeightToDt`
rescaling is gone.

Cameras are updated **inside** the fixed step (one camera update per simulation tick), because their
smoothing constants are per-tick quantities in the original.

---

## Public API Surface (demo modules)

```ts
// game.ts
export function runAntigravityRacer(canvas: HTMLCanvasElement): Promise<void>;

// constants.ts — original data + original per-tick tuning (see "Constants" below)

// track.ts
export interface TrackFrame {
    pos: Vec3;
    dir: Vec3;
    up: Vec3;
    right: Vec3;
}
/** The session's ONE spline source: no GPU resource, renderers subscribe to it. */
export interface TrackData {
    readonly controlPoints: Vec3[];
    frames: TrackFrame[];
    curveRatios: number[];
    readonly boostRight: boolean[];
    readonly boostLeft: boolean[];
    rebuild(): void;
    onRebuild(cb: (frames: readonly TrackFrame[], curveRatios: readonly number[]) => void): () => void;
}
/** One scene's GPU track: the undeformed piece + the material pair that bends it. */
export interface TrackRender {
    readonly mesh: Mesh;
    readonly material: TrackMaterial;
    dispose(): void;
}
export function buildTrackFrames(points, ringCount?): { frames: TrackFrame[]; curveRatios: number[] };
export function computeTrackRatios(points, ringCount?): { length: number; lengthPerRow: number; ratios: number[] };
export function buildTrackPiece(): { positions: Float32Array; normals: Float32Array; indices: Uint32Array };
export function frameLocalCoords(frame, worldPos): Vec3;
export function frameToWorld(frame, local): Vec3;
export function advanceSegment(frames, seg, worldPos): number;
export function createTrackSource(controlPoints?: readonly Vec3[]): TrackData;
export function buildTrackRender(engine, textures, shadowGenerator, track: TrackData): TrackRender;
export function addTrackToScene(scene, render: TrackRender): void;

// simulation.ts
export interface ShipControls {
    left: boolean;
    right: boolean;
    accelerate: boolean;
}
export interface ShipState {
    /* see "Ship state" */
}
export function createShipState(track, spawnSegment, lateral, index, isAI, playerSlot): ShipState;
export function tickShip(ship, ships, track, controls, simTime): void;
export function tickAllShips(ships, track, controlsForPlayer, simTime): void;
export function shipEmitterPoint(ship): Vec3;
export function shipSpeedRatio(ship): number;

// camera-rig.ts
export class ChaseCamera {
    constructor(scene, ship);
    cycleOffset(): void;
    tick(): void;
}
export class DemoCamera {
    constructor(scene, track, ships);
    tick(): void;
}

// trail.ts
export interface ShipTrail {
    readonly mesh: Mesh;
    push(pos: Vec3, intensity: number): void;
    dispose(): void;
}
export function createShipTrail(engine, startPos: Vec3): ShipTrail;

// world.ts — session-lifetime resources (built ONCE per page, never per mode)
export interface RenderWorld {
    readonly lights: readonly LightBase[];
    readonly sun: DirectionalLight;
    readonly shadowGenerator: ShadowGenerator;
    readonly track: TrackRender;
    readonly rocks: RockField;
    readonly terrain: Mesh;
    readonly baseCasters: readonly Mesh[];
}
export interface RacerWorlds {
    readonly track: TrackData;
    readonly primary: RenderWorld;
    secondary(): RenderWorld;
    readonly worlds: readonly RenderWorld[];
}
export function createRacerWorlds(engine, assets, controlPoints?): Promise<RacerWorlds>;
export function addWorldToScene(scene, world: RenderWorld): void;
export function setWorldCasters(world: RenderWorld, extra: readonly Mesh[]): void;
```

---

## Constants (all in ORIGINAL per-tick units)

| Name                       | Value                    | Playground origin                                   |
| -------------------------- | ------------------------ | --------------------------------------------------- |
| `RING_COUNT`               | `256`                    | `texHeight`                                         |
| `MAX_SPEED`                | `0.7`                    | `maxSpeed` (units per tick)                         |
| `MAX_ACCEL`                | `0.004`                  | `maxAccel` (units per tick²)                        |
| `VELOCITY_DRAG`            | `0.99`                   | `Ship.velocity *= 0.99`, applied every tick         |
| `WALL_HIT_DRAG`            | `0.99`                   | extra `*= 0.99` on each wall clamp                  |
| `BOOST_SPEED_KICK`         | `0.3`                    | `Ship.velocity += 0.3`                              |
| `BOOST_DEBOUNCE_SEGMENTS`  | `10`                     | `Math.abs(seg - LastBonusSegment) > 10`             |
| `LAST_BONUS_SEGMENT_INIT`  | `99999`                  | `LastBonusSegment: 99999`                           |
| `MAX_STEER_TILT`           | `0.8`                    | `desiredRotx = ±0.8`                                |
| `MAX_YAW_RATE`             | `0.05`                   | `desiredRotySpeed = ±0.05` (radians per tick)       |
| `UP_BLEND`                 | `0.1`                    | `Vector3.Lerp(Ship.up, n, 0.1)`                     |
| `YAW_BLEND`                | `0.1`                    | `RotYSpeed += (desired - RotYSpeed) * 0.1`          |
| `TILT_BLEND`               | `0.1`                    | `rotation.z += (desiredRotx - rotation.z) * 0.1`    |
| `INERTIA_SPEED_TERM`       | `0.98`                   | `fakeInertiaFactor = 1 - speedRatio * 0.98`         |
| `GRAVITY_NOISE_STRENGTH`   | `0.1`                    | `gravityNoiseStrength`                              |
| `NOISE_TILT_GAIN`          | `3`                      | `desiredRotx += noise.x * strength * 3`             |
| `WOBBLE_Y_OFFSET`          | `0.5`                    | `ShipTransform.position.y = ... + 0.5`              |
| `TICK_TIME`                | `0.0166`                 | `time += 0.0166` (noise clock, NOT `FIXED_DT`)      |
| `FIXED_DT`                 | `1/60`                   | port-only fixed-step accumulator                    |
| `MAX_STEPS_PER_FRAME`      | `6`                      | port-only stall guard                               |
| `WALL_BASE_SLOPE`          | `2.5`                    | `wallSlope = 2.5 + localY`                          |
| `FLOOR_DAMP` / `CEIL_DAMP` | `0.45` / `0.9`           | `localToSegment.y *= (y < 0) ? 0.45 : 0.9`          |
| `AI_AIM_LOOKAHEAD`         | `6`                      | `segmentMatrices[(seg + 6) % 256]`                  |
| `AI_AVOID_LIMIT`           | `6`                      | `GetFirstNextShip(shipIndex, 6)`                    |
| `AI_AVOID_TOLERANCE`       | `0.1`                    | `avoidTolerance`                                    |
| `TOTAL_SHIP_COUNT`         | `8`                      | `initPlay(scene, 8, humanCount)`                    |
| `SPAWN_LATERAL`            | `±1.5` alternating       | `(i & 1) ? 1.5 : -1.5`                              |
| spawn segment              | `i` (0…7)                | `segStart = i`                                      |
| `SHIP_MODEL_YAW`           | `Math.PI`                | `_ShipTransform.rotation.y = Math.PI`               |
| `TRAIL_EMITTER_LOCAL`      | `(0.05, 0, 0.85)`        | `heater` local offset                               |
| `CHASE_CAMERA_OFFSETS`     | `(0,3,-5)`, `(0,2,-2.8)` | `CameraRels`                                        |
| `CHASE_TARGET_LOCAL`       | `(0, 0, 5)`              | `TransformCoordinatesFromFloatsToRef(0,0,5, …)`     |
| `CAMERA_FOV`               | `0.8`                    | `fov += (0.8 - fov) * 0.01` → constant 0.8          |
| `DEMO_CAMERA_SHIP`         | `5`                      | `Ships[5]`                                          |
| `DEMO_CAMERA_LOOKAHEAD`    | `20`                     | `(currentSegment + 20) % 256`                       |
| `DEMO_CAMERA_UP`           | `2`                      | `moveUp`                                            |
| `DEMO_CAMERA_MIN/RANGE`    | `2` / `2`                | `Math.random() * 2 + 2`                             |
| `EDITOR_CAMERA_FAR`        | `1500`                   | `editorCamera.maxZ = 1500`                          |
| `TERRAIN_*`                | 800 / 600 / 0…25 / -2.05 | Original footprint doubled as a presentation change |
| `TERRAIN_UV_SCALE`         | `12`                     | Doubled with size to preserve texture density       |
| `SHADOW_MAP_SIZE`          | `1024`                   | `new CascadedShadowGenerator(1024, light)`          |
| `SHADOW_CASCADES`          | `4`                      | BJS `CascadedShadowGenerator` default               |
| `SHADOW_LAMBDA`            | `1`                      | `shadowGenerator.lambda = 1`                        |
| `SHADOW_BIAS`              | `0.001`                  | `shadowGenerator.bias = 0.001`                      |
| `SHADOW_MAX_Z`             | `1500`                   | `shadowGenerator.shadowMaxZ = 1500`                 |

Remote assets (loaded at runtime, never redistributed):

```
HEIGHTMAP_URL = "https://playground.babylonjs.com/textures/heightMap.png"
GROUND_TEXTURE_URL = "https://playground.babylonjs.com/textures/ground.jpg"
```

Failure to fetch either must reject `loadRacerAssets`/`createRacerWorlds` with a readable error that
reaches the demo's error overlay (`canvas.dataset.error`). There is **no** procedural fallback.

---

## Track pipeline (unchanged from the existing port — restated for completeness)

1. Seven control points `DEFAULT_CONTROL_POINTS` define a closed Hermite loop; `sampleLoop` mirrors
   `GetDescToRef` including its `i += 1; i %= 1` fold.
2. `computeControlUps` reproduces `computeDefaultTrackUps`, including the sign-continuity fix.
3. `computeTrackRatios` reproduces the two-pass `computeTrackLength` (256-chord length estimate,
   then `floor(localLength / lengthPerRow)` emitted ratios per chord).
4. `buildTrackFrames` reproduces `createTrackTexture`: frame `i`'s **origin** is the sample at
   `ratios[i-1]` and its forward axis points at the sample at `ratios[i]`; `right = normalize(dir × up)`,
   `up = normalize(right × dir)`. `curveRatios[i] = dot(prevDir, dir)`.
5. `buildTrackPiece` is the merged 256 × 40-vertex extrusion: 10,240 vertices, 15,360 indices.
6. `track-material.ts` bends it on the GPU from a `RING_COUNT × 4` `vec4` storage buffer, whose rows
   are the segment matrix columns `(m0,m4,m8,0) (m1,m5,m9,0) (m2,m6,m10,0) (m12,m13,m14,1)`.
7. Track info rows: `r = curveRatio > 0.9996 ? 0 : 1`, `g = (i & 31) === 2`, `b = (i & 31) === 6`.

`TrackData.rebuild()` recomputes frames from the live control points and re-uploads the SAME storage
buffers in place; the visible material, its shadow-caster material and the simulation all observe the
change without any resource churn.

---

## Ship state

```ts
interface ShipState {
    readonly index: number; // == spawn segment; also the noise phase offset ("Index")
    readonly isAI: boolean;
    readonly playerSlot: number; // 0/1 for humans, -1 for AI
    worldPos: Vec3;
    velocity: number; // units per tick
    velocityDirection: Vec3; // steered heading (unit)
    velocityDirectionEffective: Vec3; // drifting heading — DELIBERATELY NOT normalized
    up: Vec3;
    rotYSpeed: number;
    currentSegment: number;
    lastBonusSegment: number;
    tiltZ: number; // ShipTransform.rotation.z
    wobble: Vec3; // ShipTransform.position
    orientationQuat: Quat; // basis (right, up, direction)
    cameraOffsetIndex: 0 | 1;
}
```

`createShipState(track, segStart, lateral, index, isAI, playerSlot)` mirrors `CreateShip`:

```
frame     = track.frames[segStart]
worldPos  = frameToWorld(frame, (lateral, 0, 0))
velocity  = 0
velocityDirection = velocityDirectionEffective = frame.dir
up        = frame.up
rotYSpeed = 0, tiltZ = 0, wobble = (0, 0.5, 0)
currentSegment  = segStart
lastBonusSegment = 99999
```

---

## `tickShip` — the exact per-tick simulation

Executed once per fixed 60 Hz tick, in ship order.

### 1. Segment advance, wall clamp, adhesion

```
loop:
  next   = (currentSegment + 1) % 256
  local  = frameLocalCoords(frames[next], worldPos)      // == TransformCoordinates(worldPos, invMat[next])
  if local.z > 0: currentSegment = next; continue
  frame  = frames[currentSegment]
  local  = frameLocalCoords(frame, worldPos)
  local.y *= (local.y < 0) ? 0.45 : 0.9                  // vertical adhesion — WRITTEN BACK
  wallSlope = 2.5 + local.y
  if local.x < -wallSlope: local.x = -wallSlope; velocity *= 0.99
  if local.x >  wallSlope: local.x =  wallSlope; velocity *= 0.99
  interpolatedUp = lerp(frame.up, frames[next].up, local.z)   // RAW, UNCLAMPED z, componentwise
  worldPos = frameToWorld(frame, local)                       // damped y + clamped x + raw z
  break
```

Two points the previous port got wrong and that the tests pin:

- **`local.y` is written back**: the damped Y is part of the reconstructed world position. This is
  what glues the ship to the road (and what makes the ceiling/floor asymmetry visible).
- **`local.z` is not clamped** when interpolating the up vector: outside `[0, 1]` the interpolation
  _extrapolates_, which is exactly what the playground's `Matrix.Lerp(M[i], M[i+1], z)` does
  (component-wise, unclamped).

Only the interpolated matrix's up column is ever read, so the port interpolates the up vector alone
rather than materialising a 4×4 matrix.

### 2. Boost pads

```
hit = |currentSegment - lastBonusSegment| > 10 AND
      ((local.x > 1 AND boostRight[currentSegment]) OR (local.x < -1 AND boostLeft[currentSegment]))
if hit: lastBonusSegment = currentSegment; velocity += 0.3
```

`local.x` is the **clamped** value. The playground additionally wrote `camera.fov = 0.9` here, but the
`camera` argument (`Ship.activeCamera`) never existed on the ship object, so the statement was dead —
the port does not reproduce it, and there is no FOV kick anywhere.

### 3. Orientation frame

```
n         = normalize(lerp(up, interpolatedUp, 0.1))
right     = normalize(cross(n, direction))
direction = normalize(cross(right, n))
up        = normalize(cross(direction, right))
orientationQuat = basis(right, up, direction)          // == BJS Vector3.RotationFromAxis(right, up, direction)
```

### 4. Noise, speed ratio, steering intent

```
localTime = simTime + index                            // simTime advances by 0.0166 per tick
noise = (cos(localTime), sin(1.67 * localTime) * cos(localTime * 0.37), sin(localTime * 2.14))
speedRatio = min(1, velocity / 0.7)                    // computed BEFORE acceleration
```

AI (every AI ship uses the same tuning — no speed variance, no personality):

```
aim   = normalize(frames[(currentSegment + 6) % 256].pos - worldPos)
d     = dot(right, aim)
other = nearest ship strictly ahead within 6 segments   // (otherSeg - selfSeg + 256) % 256 < 6
if other:
    ds = dot(right, normalize(other.worldPos - worldPos))
    if |d - ds| < 0.1: d = (ds > d) ? ds + 0.1 : ds - 0.1
desiredTilt = 0.8 * d
desiredYaw  = 0.05 * d
go = true
```

Human (binary, exactly like the playground's key map — **right wins when both are held**):

```
if (left)  { desiredTilt = -0.8; desiredYaw = -0.05 }
if (right) { desiredTilt =  0.8; desiredYaw =  0.05 }
go = accelerate
```

Analog gamepad input is converted to this binary intent by the input layer
(`|axis| >= GAMEPAD_STEER_THRESHOLD` ⇒ that direction is "held"); the physics never sees a
fractional steer value.

### 5. Acceleration, drag, drift, integration

```
if (go AND velocity < 0.7): velocity += 0.004 * (1 - speedRatio)
velocity *= 0.99
fakeInertia = 1 - speedRatio * 0.98
velocityDirectionEffective = lerp(velocityDirectionEffective, velocityDirection, fakeInertia)   // NOT normalized
worldPos += velocityDirectionEffective * velocity
rotYSpeed += (desiredYaw - rotYSpeed) * 0.1
velocityDirection = normalize(rotateAroundAxis(velocityDirection, up, rotYSpeed))
```

`velocityDirectionEffective` staying un-normalized is load-bearing: through a corner its length drops
below 1, so the ship loses ground speed while turning. Normalizing it (as the previous port did)
removes the entire corner-braking feel.

### 6. Visual transform

```
desiredTilt += noise.x * 0.1 * 3
tiltZ  += (desiredTilt - tiltZ) * 0.1
wobble  = (noise.x * 0.1, noise.y * 0.1 + 0.5, noise.z * 0.1)
```

### 7. Ship hierarchy and the trail emitter

The playground's two-node hierarchy is reproduced exactly:

```
ShipMesh      : position = worldPos, rotation = basis(right, up, direction)
ShipTransform : position = wobble,   rotation = BJS Euler (0, π, tiltZ)  [yaw-pitch-roll → Ry·Rx·Rz]
instanceMatrix = ShipMesh · ShipTransform         (applied above the glTF root)
```

The trail emitter is `TransformCoordinates((0.05, 0, 0.85), ShipTransform.worldMatrix)`. With
`Rx = I` this folds exactly to

```
p     = ( wobble.x - 0.05 * cos(tiltZ),
          wobble.y + 0.05 * sin(tiltZ),
          wobble.z - 0.85 )
emit  = worldPos + right * p.x + up * p.y + direction * p.z
```

(`Ry(π)` negates x and z; `Rz(tiltZ)` maps `(0.05, 0, 0.85)` to `(0.05·cos, 0.05·sin, 0.85)`.)
`shipEmitterPoint(ship)` implements the folded form; a unit test proves it equals the matrix
composition for random tilts/wobbles.

---

## Cameras

### `ChaseCamera` (one per human ship)

Created as a **banked** free camera (`createBankedFreeCamera`, see below) so it can roll with the
track. Constant `fov = 0.8`, BJS default planes (`nearPlane = 1`, `farPlane = 10000`).

Per tick, with `W` = the ship's `ShipMesh` world matrix (position `worldPos`, basis `right/up/direction`):

```
desiredTarget   = worldPos + direction * 5
desiredPosition = worldPos + right*rel.x + up*rel.y + direction*rel.z     // rel ∈ CameraRels
speedRatio      = min(1, velocity / 0.7)
k               = 0.1 + speedRatio * 0.7
position = lerp(position, desiredPosition, k)
target   = lerp(target,   desiredTarget,   k)
upVector = lerp(upVector, ship.up,         k)
```

Target filtering: BJS `TargetCamera.target` returns `_currentTarget = position + forward·focal`,
which after a `setTarget(t)` with the _already updated_ position is exactly `t`. Storing and lerping
the target point is therefore equivalent to the playground's `Vector3.Lerp(camera.target, …)`, and the
port stores it directly.

`cycleOffset()` advances `rel` through `CameraRels` (C key / gamepad shoulder), reproducing
`CameraIndex`/`CameraIndexArmed`.

### `DemoCamera` (attract mode / menu background — no human ship)

Banked free camera with `farPlane = 1500` (the playground's `editorCamera.maxZ`). Per tick:

```
demoCameraTime -= 0.0166
if (demoCameraTime < 0):
    demoCameraTime = random() * 2 + 2
    F = frames[(ships[5].currentSegment + 20) % 256]
    dirFactor = 3 * (random() > 0.5 ? 1 : -1)
    demoCameraDir = F.dir * dirFactor
    translate = F.pos + F.right*(random() - 0.5) + F.up*(random()*2 - 1) + F.dir*(random()*2 - 1)
    translate *= random() * 0.014
    position = F.pos + F.up * 2 - translate * demoCameraTime
    target   = F.pos + demoCameraDir * 3
    upVector = F.up
else:
    translateBy(translate * 0.0166)      // position AND target move together → fixed orientation dolly
```

`TransformCoordinatesFromFloatsToRef` includes the frame's translation, so `translate` is a _world
point_ scaled by `random()*0.014` — that is the original's behaviour and it is preserved verbatim.
Between anchors the camera only dollies: BJS keeps the rotation fixed when `position` moves without a
`setTarget`, which the port reproduces by translating position and target by the same delta.

---

## Trail rendering

The playground gives every ship a cloned node material (23KY8X#14) plus a `RawTexture` RGBA-float
history of 256 samples, and draws it with a `MeshBuilder.CreateGround({width:0.1, height:0.01,
subdivisionsY:256})` — whose own vertex positions are never used; only its UVs matter.

### History buffer

Per ship: `Float32Array(256 * 4)`, `[x, y, z, intensity]` per row, index `0` = **oldest**, `255` =
**newest**. Each tick:

```
history.copyWithin(0, 4)                        // == data.shift() ×4
history.set([emit.x, emit.y, emit.z, speedRatio], 1020)   // row 255 = (256 - 1) * 4
updateStorageBuffer(engine, buffer, history)    // exactly one upload per tick
```

`speedRatio` is the **pre-acceleration** ratio computed in step 4 of the tick. At spawn the buffer is
filled with the spawn position and `intensity = 0`, which reproduces the original's "grow from
nothing" without relying on its `new Array(1024)` → `NaN` clipping.

### Geometry (static, built once per ship)

The original ground has 257 rows (`v = 1 - row/256`) × 2 columns (`u ∈ {0,1}`). The history texture is
a `RawTexture`, whose address mode is **clamp** on both axes, so rows `0` and `256` sample the same
texel for both `v` and `v + 0.001` ⇒ `normalize(0)` ⇒ `NaN` ⇒ those triangles are discarded. Only rows
`1…255` ever draw. The port therefore builds exactly those rows:

- 255 rows × 2 columns = **510 vertices**
- 254 quads = **1,524 indices**
- row `j` (0…254) carries `v = (255 - j) / 256` and `u ∈ {0, 1}`
- index pattern per quad, matching `CreateGround` so the winding (and therefore back-face culling)
  is identical:

```
(j+1,1) (j,1) (j,0)      (j+1,0) (j+1,1) (j,0)
```

Positions are all zero (the vertex shader positions everything); the mesh publishes the playground's
explicit huge bounding box (`±1000`) so it is never frustum-culled.

### Material

One `ShaderMaterial` per ship (the playground clones the node material per ship) with:

- attributes `["position", "uv"]`
- system uniforms `viewProjection`, `cameraPosition`
- storage buffer `trailHistory : array<vec4<f32>>`
- `needAlphaBlending: true`, `blendMode: "alpha"`, `depthWrite: false`, `backFaceCulling: true`

`sampleHistory(v)` reproduces a clamped, linearly filtered 1×256 float texture fetch:

```wgsl
fn sampleHistory(v: f32) -> vec4<f32> {
  let t  = clamp(v * 256.0 - 0.5, 0.0, 255.0);
  let i0 = u32(floor(t));
  let i1 = min(i0 + 1u, 255u);
  return mix(trailHistory[i0], trailHistory[i1], t - floor(t));
}
```

Vertex stage (exactly the node graph):

```wgsl
let v  = input.uv.y;
let sx = (input.uv.x - 0.5) * 2.0;              // -1 … +1
let s0 = sampleHistory(v);
let s1 = sampleHistory(v + 0.001);              // slightly NEWER sample
let tangent = normalize(s0.xyz - s1.xyz);       // older − newer
let view    = normalize(s0.xyz - shaderSystem.cameraPosition);
let right   = normalize(cross(view, tangent));
let world   = s0.xyz + right * (sx * 0.1);
out.position  = shaderSystem.viewProjection * vec4<f32>(world, 1.0);
out.vv        = v;
out.sx        = sx;
out.intensity = s0.w;
```

Fragment stage:

```wgsl
let alpha = max(0.0, sin(input.sx * 3.14) * sin(input.vv * 1.57) * input.intensity);
return vec4<f32>(1.0 / 255.0, 213.0 / 255.0, 253.0 / 255.0, alpha);
```

The colour is the node material's `color` input `(0.00392156862745098, 0.8352941176470589,
0.9921568627450981)` = `rgb(1, 213, 253)`, identical for every ship (AI and human alike). The `max(0, …)`
clamp replaces the original's negative-alpha half, which made no visible contribution under the
original alpha blend.

`dispose()` releases the per-ship storage buffer; the mesh's GPU geometry is released by `disposeScene`.

---

## World, lighting, sky and shadows

### Lifetime: one world per session, not one per mode

The playground builds its world in `createScene` and every mode reuses it. The port keeps that
lifetime: **`createRacerWorlds(engine, assets)` runs exactly once per page**, and its resources — the
600-subdivision height-mapped ground, the boulder pool, the track pieces, the lights and the CSM
depth arrays — live until the page goes away. A mode owns only its scenes, cameras, HUD and ship
grid, and `addWorldToScene(scene, world)` re-registers the same mesh instances into each new mode
scene (Lite meshes may live in several scenes at once). Nothing is re-fetched and no shadow map is
reallocated on a mode switch.

Because Lite disposes a mesh's shared GPU buffers when it leaves its **last** scene, the world holds
its meshes in a **residency scene**: a `createSceneContext(engine, { defaultRenderTask: false })` that
is never registered with the engine, renders nothing, and exists only so a mode scene can be disposed
without taking the world down with it.

`RacerWorlds` exposes one `RenderWorld` per split-screen pane:

| Per world (pane)                                 | Shared by every world                  |
| ------------------------------------------------ | -------------------------------------- |
| hemispheric + directional light                  | terrain mesh                           |
| CSM generator (its own 1024²×4 depth array)      | boulder pool (`RockField`)             |
| `TrackRender`: track mesh + receiver/caster pair | `TrackData` spline source, ship models |

A CSM generator fits its cascades to **one** camera and owns one shadow-task state, so the two panes
cannot share one: whichever pane rendered last would own the cascades and the other player's shadows
would be wrong or missing. The custom track material must be per-pane for the same reason — it binds
that generator's cascade array and receiver payload. Everything camera-independent (terrain,
boulders, ships) is shared: added to both panes' scenes, Lite builds a **per-scene** renderable that
binds that scene's own generator. `worlds.secondary()` builds pane 2 lazily on the first 2P race and
memoizes it, so single-pane sessions never allocate a second depth array.

`setWorldCasters(world, ships)` re-supplies one world's cascades with its own casters (its track mesh

- the boulders) plus the mode's ships; mode teardown calls it with `[]` so the cascades never
  reference disposed ship meshes. A world's caster list never contains the other pane's track mesh.

```
scene.clearColor      = pure black (0, 0, 0, 1)      // fallback while the HDR sky loads
hemisphericLight      = createHemisphericLight([1, 1, 0], 0.5)    // white diffuse, black ground (defaults)
directionalLight      = createDirectionalLight([-1, -2, -1], 1)
directionalLight.position = (120, 50, 100)
```

As a deliberate post-parity presentation change, every mode loads the exact raw
`https://playground.babylonjs.com/textures/environment.hdr` used by Playground `CGA05F#831`.
Babylon-Lite converts it to a 512-pixel cubemap and uses it for both diffuse/specular IBL and a
1000-unit visible skybox, without tone mapping and at exposure/contrast `1`.

The same presentation layer adds linear blue fog (`start=120`, `end=500`,
`color=(0.08, 0.16, 0.30)`) for atmospheric depth and doubles the terrain footprint while
preserving texture density. The terrain uses those distances as an alpha fade, so its horizon
reveals the HDR environment instead of becoming an opaque fog-colored band:

Terrain:

```
createGroundFromHeightMap(engine, HEIGHTMAP_URL, {
    width: 800, height: 800, subdivisions: 600,
    minHeight: 0, maxHeight: 25, uvScale: [12, 12],
})
terrain.position.y   = -2.05
terrain.material     = standard material + camera-distance alpha plugin
                       diffuseTexture = GROUND_TEXTURE_URL, specularColor = (0,0,0)
terrain.receiveShadows = true
```

Shadows, per world:

```
sun.shadowGenerator = createCsmDirectionalShadowGenerator(engine, sun, {
    mapSize: 1024, numCascades: 4, lambda: 1, bias: 0.001, shadowMaxZ: 1500,
})   // Lite's CSM receiver is PCF5, matching BJS usePercentageCloserFiltering
setShadowTaskCasterMeshes(shadowGenerator, [thisWorldTrackMesh, ...rockPoolMeshes, ...shipPoolMeshes])
await registerSceneWithShadowSupport(scene)
```

Receivers: terrain (standard material, built-in CSM receiver), rocks (PBR, built-in receiver), and the
track (custom receiver, below). Ships are casters only, exactly like the playground. The built-in
receivers resolve their generator from `scene.lights` when the scene's renderables are built, which is
why the shared terrain/rock meshes receive the correct pane's cascades in split-screen.

Caster meshes for the glTF models are the `HierarchyInstancePool.meshes` arrays — the thin-instanced
carrier meshes — so all eight ships / seven boulders cast from a single caster entry per source
primitive. The CSM caster path computes a thin-instance world AABB for those meshes, so the cascade
fit sees every instance.

The Playground replaces the rock glTF root transform before assigning each authored TRS. The port
does the same: it clears the cloned handedness-conversion root before applying the seven literal
position, Euler rotation, and non-uniform scale triples, rather than mirroring the rock geometry.

### Track: casting and receiving

The track's visible material samples the cascade array, so it **cannot** be used as its own shadow
caster: the depth-only caster pass would bind the very texture it renders into. Instead the track owns
a second, sampler-free `ShaderMaterial` with the _same_ vertex source and the _same_ `trackFrames`
storage buffer, wired through the public `setShadowCasterMaterial(visible, caster)`. Both materials
see a track rebuild because they share that GPU buffer, so editing a control point moves the visible
geometry and its shadow in the same frame with no resource churn. There is no CPU-deformed duplicate
mesh.

The spline itself lives in `TrackData` and owns no GPU resource; each pane's `TrackRender` subscribes
with `TrackData.onRebuild` and re-uploads its own frame buffer in place. So an editor drag recomputes
the 256 frames once and refreshes **every** pane's visible + caster buffers — allocating nothing — and
the edited track persists into the modes that follow, exactly like the playground's single global
track.

Receiving is wired through the public CSM receiver seam:

```ts
setShaderTexture(material, "csmShadow", getCsmReceiverTexture(shadowGenerator));
const stop = onCsmReceiverUpdate(shadowGenerator, (data) => updateStorageBuffer(engine, csmBuffer, data));
```

`csmShadow` is declared `{ sampleType: "depth", viewDimension: "2d-array", comparison: true }`; the
80-float receiver payload is mirrored into a `csmReceiver : array<vec4<f32>>` storage buffer
(20 `vec4`s: four `mat4x4` cascade transforms, `viewFrustumZ`, `frustumLengths`, `shadowsInfo`,
`csmParams`). The fragment shader reproduces `csm-shadow-fragment-core`'s cascade select + 5×5 PCF
kernel + cascade blend, and multiplies the directional term by the resulting factor. Syncing inside
`onCsmReceiverUpdate` (not `onBeforeRender`) avoids the documented one-frame cascade lag. Both the
texture and the payload belong to one generator, which is why each split-screen pane builds its own
copy of this material.

---

## Modes

| Mode          | Playground call         | Port                                               |
| ------------- | ----------------------- | -------------------------------------------------- |
| Edit Track    | `initEditing(scene)`    | marker spheres + position gizmo + live `rebuild()` |
| Test Track    | `initPlay(scene, 1, 1)` | 1 human, **no AI**, chase camera                   |
| 1P Race       | `initPlay(scene, 8, 1)` | 1 human + 7 AI                                     |
| 2P split Race | `initPlay(scene, 8, 2)` | 2 humans + 6 AI, one surface per player            |
| Demo          | `initPlay(scene, 8, 0)` | 8 AI + `DemoCamera`                                |

The menu background reuses the Demo mode (`buildRace` with `isMenuBackground: true`). Test Track, 1P,
2P split, Demo and the menu background all share one `buildRace` orchestration function that owns the
scene(s), the fixed-step accumulator (`driveFixedStep`), pause handling, input edge draining and
teardown; each call only supplies `RaceConfig` (human/AI counts, menu-background flag) and builds its
grid/cameras/HUD from it. Edit Track is not a `buildRace` variant: it has no per-tick simulation to
fix-step, so `buildEditor` drives the spline editor, HUD and gizmo through its own variable-delta
`onBeforeRender` callback (`deltaMs` clamped and converted straight to seconds, no accumulator). Single-
pane `buildRace` calls (Test Track, 1P, Demo, menu background) use the primary world only; 2P adds the
secondary world to its second surface's scene. Teardown disposes the mode's scenes, HUD, cameras and
ship grid, and clears the ships from each used world's caster set — never the world itself.

The editor registers its ArcRotate-controlled main scene before its utility layer, ensuring the
position gizmo's swapchain overlay renders on top of the track while both share the same camera.
Idle gizmo hover readbacks are coalesced to one in-flight pick plus the latest pointer position.
The editor camera starts orbiting immediately and yields only after a gizmo drag is confirmed, so
GPU picking and first-use pipeline compilation cannot stall ordinary camera input.

Removed as non-original: lap counting, ranking, the rank HUD readout, boost flash timers, per-AI speed
factors, and the FOV kick.

---

## Engine additions this demo required

### `createBankedFreeCamera` (`src/camera/banked-free-camera.ts`)

```ts
export interface BankedFreeCamera extends FreeCamera {
    /** Mutable world-space up vector used to build the look-at basis. */
    readonly upVector: ObservableVec3;
}
export function createBankedFreeCamera(position: Vec3, target: Vec3, up?: Vec3): BankedFreeCamera;
```

`createFreeCamera` and `createBankedFreeCamera` share one factory in `free-camera.ts`
(`_createFreeCamera(position, target, up: Vec3)`), which always uses whatever `up` it is handed and has
no notion of "banked" — no branch, no `upVector` property. `createFreeCamera` passes the shared `Vec3Up`
constant, so scenes that never import the banked constructor are byte-identical to the pre-banked code.
`createBankedFreeCamera` builds its own `ObservableVec3` up vector, wires its dirty callback to the
camera's world-matrix invalidation, and defines the public `upVector` property — entirely inside
`banked-free-camera.ts` — so writing to it invalidates the world matrix exactly like `position` /
`target` do.

### `setShadowCasterMaterial` (`src/material/set-shadow-caster-material.ts`)

```ts
export function setShadowCasterMaterial(material: Material, casterMaterial: Material | null): void;
```

Public, tree-shakable setter for the existing internal `Material._shadowCasterMaterial` seam already
honoured by both the PCF and CSM caster paths. It lets a material that _receives_ shadows through
resources that alias the shadow map cast through an alternate material instead. Rejects any caster
chain that cycles back to `material` — not just a direct self-reference — by walking `casterMaterial`'s
own `_shadowCasterMaterial` links (the same chain `getNoColorView` recurses through) before assigning.

---

## Test Specification

| Test file                              | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `antigravity-racer-track.test.ts`      | spline length/ratios, 256 orthonormal frames, track piece counts/winding, road artwork, track material compositing, CSM receiver declarations + WGSL (cascade select, 5×5 PCF kernel, `CSM_RECEIVER_VEC4S`), caster twin sharing the frame buffer                                                                                                                                                                                                                                                                                                                                                                                                |
| `antigravity-racer-simulation.test.ts` | vertical adhesion write-back (0.45/0.9), unclamped up extrapolation, wall clamp + 0.99, boost + debounce, accel/drag traces, un-normalized drift + corner speed loss, binary right-wins steering, spawn grid 0..7/±1.5, AI nearest-ahead + avoidance, emitter folded-vs-matrix equality, **the chase + demo camera rigs** (offsets/target/smoothing/FOV/up-roll, anchoring + dolly + re-anchor cadence)                                                                                                                                                                                                                                          |
| `antigravity-racer-trail.test.ts`      | history ordering/copyWithin, spawn seeding, strip vertex/index counts + v mapping + winding, WGSL constants/alpha, blend/depth state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `antigravity-racer-world.test.ts`      | light directions/intensities, terrain parameters + remote URLs, CSM config; and the persistent-world contract exercised against the real engine with a stub device: one 1024²×4 depth array per world and never per mode, terrain + boulders built once per session, the same meshes and lights re-added to every mode scene, per-pane light/generator/track isolation (each pane's material bound to its OWN receiver texture and frame buffer), per-pane caster sets (own track + shared boulders + ships, never the other pane's track, ships cleared on teardown), and an editor edit re-uploading every pane in place with zero allocations |
| `banked-free-camera.test.ts`           | up vector affects the look-at basis, mutation invalidates the world matrix, default matches `createFreeCamera`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `shadow-caster-material.test.ts`       | setter stores/clears the caster material; `getNoColorView` resolves through it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

There is no separate camera test file: the chase and demo camera rigs are covered by the "chase
camera" and "demo camera" suites inside `antigravity-racer-simulation.test.ts`.

---

## File Manifest

| File                                    | Purpose                                                                |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `antigravity-racer.ts`                  | demo entry: loading progress + error overlay                           |
| `antigravity-racer/game.ts`             | engine/input/menu ownership, mode switching, `buildRace`/`buildEditor` |
| `antigravity-racer/constants.ts`        | playground data + per-tick tuning                                      |
| `antigravity-racer/assets.ts`           | glTF models, road artwork, remote terrain assets                       |
| `antigravity-racer/track.ts`            | spline math, frames, procedural piece, `TrackData` + `TrackRender`     |
| `antigravity-racer/track-material.ts`   | deformation + road compositing + CSM receiver + caster material        |
| `antigravity-racer/simulation.ts`       | exact per-tick physics + AI                                            |
| `antigravity-racer/spawn.ts`            | ship grid, per-tick visual sync                                        |
| `antigravity-racer/ship-fleet.ts`       | instanced ship model, `ShipMesh · ShipTransform`                       |
| `antigravity-racer/rocks.ts`            | instanced boulders at the exact transforms                             |
| `antigravity-racer/terrain.ts`          | height-mapped ground from the playground textures                      |
| `antigravity-racer/trail.ts`            | storage-buffer trail strip + WGSL                                      |
| `antigravity-racer/camera-rig.ts`       | `ChaseCamera`, `DemoCamera`                                            |
| `antigravity-racer/world.ts`            | session-lifetime worlds: lights, CSM per pane, residency, casters      |
| `antigravity-racer/editor.ts`           | control-point markers, gizmo, live rebuild                             |
| `antigravity-racer/input.ts`            | keyboard (physical-code) + gamepad → binary ship controls              |
| `antigravity-racer/menu.ts`, `hud.ts`   | DOM menu, HUD, pause overlay, editor toolbar                           |
| `antigravity-racer/gamepad-list-nav.ts` | shared button-list navigation                                          |
| `antigravity-racer/bjs-euler.ts`        | Babylon yaw-pitch-roll Euler → quaternion                              |
