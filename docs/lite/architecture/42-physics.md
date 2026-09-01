# Module: Physics

> Package path: `packages/babylon-lite/src/physics/`

> **Status: Implemented.**
> Behavioral integration of **Havok Physics V2** (the same WASM engine Babylon.js
> uses), re-shaped to Lite idioms: a pure-state `PhysicsWorld` handle plus
> standalone functions, zero module-level side effects, and opt-in feature
> modules (collision events, triggers, heightfields, queries, character
> controller, floating-origin, debug viewer). The **authoritative API is the
> exported TSDoc** in `packages/babylon-lite/src/physics/`.

---

## Purpose

The Physics module drives rigid-body simulation by wrapping the Havok V2 WASM
solver. It owns **no scene graph**: it reads transforms from Lite `SceneNode`s to
seed bodies and writes integrated transforms back each step, but the scene never
holds a reference to the physics world (Pillar 4b — one-way ownership). The
per-frame step is driven by the scene's before-render loop; the world is the
data owner and the scene is the clock source.

The module is **100% opt-in and tree-shakable**. A scene that imports nothing
from `physics/` pays zero bytes, and the Havok WASM binary is loaded lazily by
the caller and only referenced once `createHavokWorld` runs.

---

## Design: pure-state handle + functions

| Concept                    | Babylon Lite                                                         |
| -------------------------- | ------------------------------------------------------------------- |
| `PhysicsEngine` + plugin   | one `PhysicsWorld` state interface + standalone functions           |
| `PhysicsBody` class        | `PhysicsBody` state interface + `createPhysicsBody(...)` etc.        |
| `body.applyForce()`        | `applyPhysicsBodyForce(world, body, ...)`                           |
| `PhysicsViewer` class      | `createPhysicsViewer(...)` + `show*/hide*` functions                |
| Engine-owned step observer | a callback pushed onto `scene._beforeRender` at world creation       |

### Thin-instance rigid bodies

`enableHavokThinInstancePhysics(world)` lazily installs a per-world Havok facade
as `world._hknp`. The lazy context retains the raw Havok module and maps each
thin body's primary handle identity to module-private native handles and reusable
matrix-decomposition scratch values. This explicit enabler owns all
thin-instance detection, validation, fan-out, and matrix synchronization, so
ordinary body state has no thin fields and ordinary physics scenes retain none
of the feature module. After enabling,
`createPhysicsBody(world, mesh, motionType, startsAsleep)` creates one native
Havok body per active matrix while retaining one Lite `PhysicsBody` handle:

- `PhysicsBody._hkBody` remains the first native handle for backwards
  compatibility and single-body consumers.
- Generic body setters, impulses, removal, and release keep their ordinary
  direct Havok calls. The facade recognizes only the exact primary handle object
  and fans those calls out; equivalent cloned tuples delegate once to raw Havok.
- Getter calls on the primary handle naturally read native instance zero.
  Instance resolution returns stable cloned handle tuples, including for index
  zero, so controller contact impulses affect only the struck instance.
- Event-safe deferred release and controller native-transform math remain private
  to the lazy enabler.
- Each native body is initialized from its corresponding matrix translation and
  rotation. The carrier mesh transform is intentionally ignored, matching
  Babylon.js Physics V2 thin-instance semantics.
- Shape, mass, motion, velocity, impulse, force, event-mask, removal, and disposal
  operations that address the Lite body apply to every native instance. Getters
  and APIs that inherently accept one native body use instance zero.
- Constraints and single-body query exclusions use instance zero. Raycast,
  collision, trigger, and character-controller contact resolution recognize
  every native handle by consulting the optional thin resolver before the
  ordinary linear lookup. Collision-style event payloads return the
  shared Lite body plus the zero-based thin-instance index, matching Babylon.js
  `colliderIndex` / `collidedAgainstIndex` semantics; ordinary bodies report
  index `0`.

Dynamic thin-instance bodies synchronize Havok transforms directly into the
existing matrix slab after every step, then dirty the matrix range once through
`flushThinInstances(mesh)`. The update writes a rigid rotation/translation
matrix; authored scale is not preserved after simulation. With TELEPORT
pre-step enabled, every matrix is copied back to its matching Havok body.
TELEPORT is the default. ACTION retains Babylon.js behavior and sends the
carrier node's single target transform to every instance. Public body transform
sets fan out through the facade and rewrite/flush every thin matrix. The core
step retains only three optional synchronization hooks (TELEPORT, ACTION, and
dynamic body-to-matrix sync), while their algorithms stay in the lazy module.

Thin bodies removed while after-step callbacks are draining remain resolvable
until all callbacks complete. Minimal begin/end hooks bracket that drain; the
facade defers only thin releases until the end hook, while ordinary removals and
all removals outside the drain release immediately.

`getPhysicsBodyInstanceCount(body)` reports the native count (`1` for ordinary
bodies). The active thin-instance count is fixed when the body is created:
callers must populate matrices and explicitly enable thin-instance physics before
body construction. Without the enabler, core body creation performs no
thin-instance detection and follows the ordinary single-body path.
Floating-origin multi-region simulation rejects thin-instance bodies explicitly
until it can track one region per native instance.

### Module files

| File                              | Responsibility                                                        |
| --------------------------------- | --------------------------------------------------------------------- |
| `havok.ts`                        | Core: world create/step/dispose, bodies, shapes, aggregates, forces   |
| `havok-thin-instances.ts`         | Lazy native-body fan-out and matrix synchronization for thin instances |
| `havok-collision.ts`              | Opt-in collision-started/continued/finished events (`onPhysicsCollision`) |
| `havok-trigger.ts`                | Opt-in trigger volume enter/exit events                               |
| `havok-heightfield.ts`            | Heightfield collision shape                                           |
| `havok-queries.ts`                | Raycast, shape-cast, shape-proximity queries                         |
| `havok-floating-origin.ts`        | Multi-region simulation for Large World Rendering (loaded on demand)  |
| `character-controller.ts`         | Kinematic character controller (cast-and-slide)                      |
| `physics-viewer.ts` + `physics-debug-line-material.ts` | Debug wireframe overlay of collider shapes         |

---

## World lifecycle

```ts
import HavokPhysics from "@babylonjs/havok";

const hknp = await HavokPhysics({ locateFile: () => "/HavokPhysics.wasm" });
const world = createHavokWorld(scene, hknp);          // world step defaults to 0 (follows the scene)
// ... create bodies/aggregates ...
disposePhysics(world);                                 // stops stepping, releases native world
```

`createHavokWorld` registers the per-frame step by **unshifting a callback onto
`scene._beforeRender`** and stores a remover in `world._stopStep`. `disposePhysics`
calls that remover and clears `world._afterStep` **before** releasing the native
world — otherwise a still-registered callback would step (and read collision
events from) a freed Havok world, which is both a leak and a use-after-free in the
WASM heap. See `tests/lite/unit/physics-dispose.test.ts`.

---

## Timestep & delta-time propagation

Physics advances on the **same delta-time contract every time-based subsystem in
Lite follows**: the scene resolves one effective delta per frame, and each
subsystem may re-gate it with its own fixed override.

### Stage 1 — the scene resolves one delta per frame

`scene-core.ts` picks the delta once and passes it to every before-render
callback (animation, sprites, **physics**):

```ts
// scene-core.ts (buildScene render step)
const d = ctx.fixedDeltaMs > 0 ? ctx.fixedDeltaMs : eng._currentDelta;
for (const cb of ctx._beforeRender) cb(d);
```

`scene.fixedDeltaMs` (milliseconds, default `0`) is the determinism knob: set it
to a fixed value (e.g. `1000 / 60`) for reproducible playback, or leave it `0` to
use the real `requestAnimationFrame` delta (`engine._currentDelta`).

### Stage 2 — the world re-gates with its own fixed step

The world stores its own **`_fixedDeltaMs` (milliseconds)**, which is **independent
of the scene** — it defaults to `0` at creation and is only set through the
accessors. `_stepWorld` applies the identical `> 0 ? fixed : delta` rule the
animation and sprite managers use:

```ts
// havok.ts _stepWorld(world, deltaMs)
const stepMs = world._fixedDeltaMs > 0 ? world._fixedDeltaMs : deltaMs;
if (!Number.isFinite(stepMs) || stepMs <= 0) return;   // reject NaN / non-positive
const dt = Math.min(stepMs / 1000, 0.1);               // → seconds, clamped (see below)
hknp.HP_World_Step(hkWorld, dt);
```

Because the world step defaults to `0`, in the common case (no override) the world
**follows the scene**: the `deltaMs` it receives each frame is the value the render
loop already resolved as `scene.fixedDeltaMs > 0 ? scene.fixedDeltaMs :
engine._currentDelta` (Stage 1). Physics therefore steps in **lockstep with
animation** — both resolve to the same fixed value when the scene is deterministic,
or both fall back to the real frame delta when it is not — and any **runtime change
to `scene.fixedDeltaMs` is picked up on the next frame** (no construction-time
snapshot to go stale).

### Units

The stored step is **milliseconds everywhere** (consistent with
`scene.fixedDeltaMs` and the animation/sprite managers). Physics converts to
**seconds only at the Havok boundary**, because `HP_World_Step` and the
force→impulse / displacement→velocity conversions expect seconds. The
after-step callbacks (`onPhysicsAfterStep`) receive this per-step `dt` in seconds.

### Overriding the step

`setPhysicsTimestepMs(world, fixedDeltaMs)` / `getPhysicsTimestepMs(world)` read and
write `_fixedDeltaMs` in **milliseconds**, matching `SceneContext.fixedDeltaMs`. Pass
`0` (the default) to detach physics from a world-level fixed step and follow the
scene's per-frame delta:

```ts
setPhysicsTimestepMs(world, 1000 / 30);   // force a 30 fps physics step
setPhysicsTimestepMs(world, 0);           // back to following the scene's delta
```

`setPhysicsTimestep(world, seconds)` / `getPhysicsTimestep(world)` are the equivalent
**seconds-based** accessors (`setPhysicsTimestep(world, 1 / 30)` is the same as
`setPhysicsTimestepMs(world, 1000 / 30)`); the millisecond accessors are preferred in
new code so units line up with the rest of the engine's delta convention.

This is the physics analogue of assigning `manager.fixedDeltaMs` on an animation
or sprite manager. See `tests/lite/unit/physics-timestep.test.ts`.

### Out-of-loop callers: `worldStepSeconds`

Some physics operations run **outside** the per-frame `_stepWorld` callback and so
never receive the render loop's `deltaMs` argument — for example `applyPhysicsBodyForce`
(force → impulse over one step) and the character controller's `moveWithCollisions`
(displacement → velocity). These call the shared `worldStepSeconds(world)` helper,
which resolves the same effective delta the step would use and returns it in **seconds**:

1. `world._fixedDeltaMs` if a fixed step is set, else
2. `scene.fixedDeltaMs` if the scene runs fixed, else
3. the engine's real per-frame delta (`scene.surface.engine._currentDelta`).

This keeps force and character motion locked to the same delta the world integrates
with, whether the world runs fixed-step or follows the real frame delta. The helper
can return `0` on the very first frame (no delta measured yet); callers guard against
a zero/negative step.

### Why `Math.min(dt, 0.1)`

The step is clamped to a **100 ms ceiling (a 10 fps floor)**. A long hitch — a
backgrounded tab, a GC pause, a hit breakpoint — otherwise hands Havok a single
huge `dt`. Integrating one giant step makes fast bodies **tunnel** through thin
geometry (they teleport past a collider between two solver samples) and can
destabilise the constraint solver. Capping turns a stall into a brief slow-motion
instead of an explosion. Babylon.js caps its physics substep the same way. The
clamp is intentionally *not* a substepping loop: Lite runs a single fixed step per
frame, trading perfect catch-up for simplicity and a stable bundle.

### Consistency with other time-based subsystems

| Subsystem | Gate                                             | Source                        |
| --------- | ------------------------------------------------ | ----------------------------- |
| Scene     | `fixedDeltaMs > 0 ? fixedDeltaMs : currentDelta` | `scene-core.ts`               |
| Animation | `fixedDeltaMs > 0 ? fixedDeltaMs : deltaMs`      | `animation-manager.ts`        |
| Sprites   | `fixedDeltaMs > 0 ? fixedDeltaMs : deltaMs`      | `sprite-animation.ts`         |
| Physics   | `_fixedDeltaMs > 0 ? _fixedDeltaMs : deltaMs`    | `havok.ts` `_stepWorld`       |

The only physics-specific differences are the ms→seconds conversion at the Havok
boundary and the 100 ms tunnelling clamp; the guard against non-finite / negative
steps matches the animation and sprite managers.

---

## Rigid-body angular locks

`lockPhysicsBodyRotationAxes(world, body, axes)` locks selected body-local
axes after the collision shape and mass properties have been configured. Havok
represents a locked angular degree of freedom with a zero inertia component. Its
shape-derived inertia is expressed in a rotated principal-axis frame, so the
helper evaluates `R · diag(inertia) · Rᵀ` in body space and zeros the requested
`"x"`, `"y"`, or `"z"` components. A single-axis lock retains the exact coupled
inertia in the remaining free plane through a rotation around the locked axis;
multi-axis locks use an identity inertia orientation. Mass and centre of mass are
preserved. The active lock mask and latest unlocked mass properties are retained
on the body and reapplied by `setPhysicsBodyMass` and
`setPhysicsBodyMassProperties` when they rebuild shape-derived mass properties.
`unlockPhysicsBodyRotationAxes(world, body, axes)` selectively restores axes from
those unlocked properties and removes the internal persistence seam after the
last axis is unlocked.

---

## Feature modules (opt-in)

- **Collision events** (`havok-collision.ts`): `setPhysicsBodyCollisionEventsEnabled`
  + `onPhysicsCollision` register an after-step drain on `world._afterStep`.
  Each event identifies `collider`, `colliderIndex`, `collidedAgainst`, and
  `collidedAgainstIndex`, and reports contact distance in addition to the point,
  normal, and impulse.
- **Triggers** (`havok-trigger.ts`): `setPhysicsShapeIsTrigger`, `onPhysicsTrigger`,
  and body-aware `onPhysicsTriggerBodies`; both subscriptions return a disposer.
  Body-aware events include `bodyAIndex` / `bodyBIndex` (`-1` when an event refers
  to a body that is no longer tracked).
- **Queries** (`havok-queries.ts`): `physicsRaycast`, `shapeCast`, `shapeProximity`.
  Raycasts return the shared Lite `body` plus `bodyIndex`, the zero-based
  thin-instance index resolved from the native hit handle (`0` for ordinary
  bodies and `-1` when no tracked body is resolved), matching Babylon.js.
  Shape casts accept one `ignoreBody`, matching Havok's single optional ignored body
  ID, so callers can sweep a body's own shape without immediately hitting that body.
- **Heightfield** (`havok-heightfield.ts`): `createHeightFieldShape`.
- **Character controller** (`character-controller.ts`): kinematic cast-and-slide
  movement; `moveWithCollisions` uses `worldStepSeconds(world)` (the world's step, or
  the scene's per-frame delta when no fixed step is set) to convert a requested
  displacement into a velocity. `getPhysicsCharacterControllerBody` exposes the
  backing body for queries and event matching.
- **Floating origin** (`havok-floating-origin.ts`): `enableHavokFloatingOrigin`
  opts a world into multi-region simulation for Large World Rendering
  (see [35-large-world-rendering.md](35-large-world-rendering.md)).
  Its `step(world, dt)` receives the same clamped per-step seconds as the single-region path.
- **Debug viewer** (`physics-viewer.ts`): wireframe overlay of collider shapes.

---

## Testing

- `tests/lite/unit/physics-dispose.test.ts` — the step / after-step callbacks are
  registered on creation and fully torn down on dispose (no leak, no use-after-free).
- `tests/lite/unit/physics-timestep.test.ts` — the world's step defaults to `0`
  (independent of `scene.fixedDeltaMs`), follows the scene's per-frame delta when
  unset (respecting runtime changes), is converted to seconds for `HP_World_Step`,
  and is settable via `setPhysicsTimestep` / `setPhysicsTimestepMs`.
- `tests/lite/unit/physics-rotation-axis-locks.test.ts` — selected body-local inertia
  components are zeroed after transforming a non-identity principal inertia frame
  into body space; single-axis locks preserve free-plane coupling, mass updates
  preserve active locks, selective unlocking restores the latest unlocked
  properties, and empty input/native read failures do not write mass properties.
- `tests/lite/unit/physics-thin-instances.test.ts` — matrix-order native body
  creation, shared shape/mass propagation, post-step matrix synchronization, one
  dirty-range publication, complete native-body disposal, and nonzero-instance
  Babylon.js-compatible body and instance-index reporting from native collision
  and character-controller events.
- Parity scenes (physics drop/stack/constraint scenes) set
  `scene.fixedDeltaMs = 1000 / 60` so Lite and Babylon.js step identically.
