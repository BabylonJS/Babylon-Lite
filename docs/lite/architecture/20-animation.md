# Module: Animation
> Package path: `packages/babylon-lite/src/animation/`

## Purpose

Provides a zero-allocation keyframe animation system for glTF animations and user-authored property animations. Supports skeletal joint transforms, morph target weights, KHR_animation_pointer channels, and manual tracks bound to object property paths such as `position.x`, `position`, `rotationQuaternion`, or `scaling`. Each evaluated clip is wrapped in an `AnimationGroup` and can be driven by a standalone `AnimationManager`, by a scene render loop, or by explicit deterministic updates. Evaluation runs LINEAR, STEP, and CUBICSPLINE interpolation using pre-allocated scratch buffers, with no per-frame heap allocation.

## Public API Surface

### Constants

```typescript
// Interpolation modes (numeric for hot-path comparison)
export const INTERP_LINEAR      = 0;
export const INTERP_STEP        = 1;
export const INTERP_CUBICSPLINE = 2;

// Target paths (numeric)
export const PATH_TRANSLATION = 0;
export const PATH_ROTATION    = 1;
export const PATH_SCALE       = 2;
export const PATH_WEIGHTS     = 3;
```

### Types

```typescript
export type InterpMode  = 0 | 1 | 2;
export type TargetPath  = 0 | 1 | 2 | 3;

export interface AnimationSampler {
    readonly input: Float32Array;          // keyframe timestamps (seconds, monotonically increasing)
    readonly output: Float32Array;         // packed values; CUBICSPLINE: [inTangent, value, outTangent] per key
    readonly interpolation: InterpMode;
}

export interface AnimationChannel {
    readonly samplerIdx: number;
    readonly nodeIdx: number;
    readonly path: TargetPath;
}

export interface AnimationClip {
    readonly name: string;
    readonly channels: readonly AnimationChannel[];
    readonly samplers: readonly AnimationSampler[];
    readonly duration: number;             // max of all sampler input times (seconds)
    readonly frameRate?: number;           // defaults to 60 for glTF clips
}

export interface NodeRest {
    readonly parentIdx: number;            // -1 for root nodes
    tx: number; ty: number; tz: number;    // translation
    rx: number; ry: number; rz: number; rw: number; // rotation quaternion
    sx: number; sy: number; sz: number;    // scale
}

export interface SkeletonBinding {
    readonly jointNodes: readonly number[];
    readonly inverseBindMatrices: Float32Array;
    readonly invMeshWorld: Mat4;
    readonly boneTexture: GPUTexture;
    readonly boneCount: number;
}

export interface MorphBinding {
    readonly nodeIdx: number;
    readonly weightsBuffer: GPUBuffer;
    readonly targetCount: number;          // max 4 supported
}

export interface GltfAnimationData {
    readonly clips: readonly AnimationClip[];
    readonly nodes: readonly NodeRest[];
    readonly skeletons: readonly SkeletonBinding[];
    readonly morphBindings: readonly MorphBinding[];
}

export type AnimationKeyframeValue = number | readonly number[];

export interface AnimationKeyframe {
    /** Timestamp in seconds. Mutually exclusive with `frame`. */
    readonly time?: number;
    /** Frame index converted with `frameRate`. Mutually exclusive with `time`. */
    readonly frame?: number;
    readonly value: AnimationKeyframeValue;
}

export type PropertyAnimationInterpolation = "linear" | "step";

export interface PropertyAnimationTrackOptions {
    readonly path: string;
    readonly keys: readonly AnimationKeyframe[];
    readonly frameRate?: number;
    readonly interpolation?: PropertyAnimationInterpolation;
    /** Forces quaternion-aware interpolation for vec4 tracks. Inferred for `rotationQuaternion` paths. */
    readonly quaternion?: boolean;
}

export interface PropertyAnimationClipOptions {
    readonly frameRate?: number;
}

export interface PropertyAnimationTrack {
    readonly path: string;
    readonly sampler: AnimationSampler;
    readonly stride: number;
    readonly quaternion: boolean;
}

export interface PropertyAnimationClip {
    readonly name: string;
    readonly tracks: readonly PropertyAnimationTrack[];
    readonly duration: number;
    readonly frameRate: number;
}

export interface AnimationManagerOptions {
    /** Optional engine enables glTF skeleton/morph GPU uploads when manager is not scene-hosted. */
    readonly engine?: EngineContext;
    /** Fixed step in ms. `0` means caller-supplied / rAF delta. */
    readonly fixedDeltaMs?: number;
    /** Called after each autonomous tick, e.g. to render a custom view. */
    readonly onUpdate?: (deltaMs: number) => void;
}

export interface AnimationTask {
    readonly _entityType: "animation-task";
    active: boolean;
}

export type AnimationTaskUpdate = (manager: AnimationManager, deltaMs: number, task: AnimationTask) => void;
export type AnimationTaskCategoryHandler = (manager: AnimationManager, deltaMs: number) => boolean;

export interface AnimationTaskOptions {
    readonly category?: string;
    readonly dispose?: (manager: AnimationManager) => void;
}

export interface AnimationManager {
    animations: AnimationTask[];
    fixedDeltaMs: number;
    running: boolean;
    readonly engine?: EngineContext;
    readonly onUpdate?: (deltaMs: number) => void;
    _rafId: number;
    _lastTime: number;
}

export interface SkeletonData {
    readonly boneTexture: GPUTexture;
    readonly boneCount: number;
    readonly jointsBuffer: GPUBuffer;
    readonly weightsBuffer: GPUBuffer;
    readonly joints1Buffer: GPUBuffer | null;  // 8-bone skinning
    readonly weights1Buffer: GPUBuffer | null;
}

export interface MorphTargetData {
    readonly texture: GPUTexture;
    readonly count: number;
    readonly weightsBuffer: GPUBuffer;
}
```

### AnimationGroup Interface

```typescript
export interface AnimationGroup {
    readonly name: string;
    readonly duration: number;             // seconds
    readonly frameRate: number;            // used by goToFrame()
    isPlaying: boolean;
    currentFrame: number;                  // current time in seconds (not frames!)
    speedRatio: number;                    // default 1
    loopAnimation: boolean;               // default true
    weight: number;                        // default 1
    _stopped: boolean;
    readonly _ctrl?: AnimationController;
}
```

### Functions

```typescript
export function createAnimationGroups(animData: GltfAnimationData): AnimationGroup[];
export function goToFrame(group: AnimationGroup, frame: number, engine?: EngineContext): void;
export function createAnimationManager(options?: AnimationManagerOptions): AnimationManager;
export function createAnimationTask(update: AnimationTaskUpdate, options?: AnimationTaskOptions): AnimationTask;
export function addAnimationTask(manager: AnimationManager, task: AnimationTask): void;
export function removeAnimationTask(manager: AnimationManager, task: AnimationTask): void;
export function setAnimationTaskCategoryHandler(manager: AnimationManager, category: string, handler: AnimationTaskCategoryHandler): void;
export function addAnimationGroup(manager: AnimationManager, group: AnimationGroup): void;
export function addAnimationGroups(manager: AnimationManager, groups: readonly AnimationGroup[]): void;
export function removeAnimationGroup(manager: AnimationManager, group: AnimationGroup): void;
export function getAnimationGroups(manager: AnimationManager): readonly AnimationGroup[];
export function updateAnimationManager(manager: AnimationManager, deltaMs: number): void;
export function startAnimationManager(manager: AnimationManager): void;
export function stopAnimationManager(manager: AnimationManager): void;
export function setAnimationWeight(group: AnimationGroup, weight: number): void;
export function enablePropertyAnimationBlending(manager: AnimationManager): void;
export function fadeAnimationWeight(manager: AnimationManager, group: AnimationGroup, options: FadeAnimationWeightOptions): void;
export function crossFadeAnimationGroups(manager: AnimationManager, fromGroup: AnimationGroup, toGroup: AnimationGroup, options: CrossFadeAnimationGroupsOptions): void;
export function enableAnimationBlending(manager: AnimationManager): void;
export function setAnimationAdditive(group: AnimationGroup, options?: AnimationAdditiveOptions): void;

export function createPropertyAnimationClip(
    name: string,
    tracks: readonly PropertyAnimationTrackOptions[],
    options?: PropertyAnimationClipOptions
): PropertyAnimationClip;

export function createPropertyAnimationGroup(
    manager: AnimationManager,
    target: object,
    clip: PropertyAnimationClip,
    options?: {
        readonly loop?: boolean;
        readonly speedRatio?: number;
        readonly fromFrame?: number;
        readonly toFrame?: number;
        readonly fromTime?: number;
        readonly toTime?: number;
    }
): AnimationGroup;

export function evaluateSampler(
    sampler: AnimationSampler,
    t: number,
    stride: number,          // 3 for vec3, 4 for quat
    isQuat: boolean,         // true → uses slerp for LINEAR, normalizes for CUBICSPLINE
    dst: Float32Array,
    dstOffset: number
): void;
```

## Internal Architecture

### Data Layout

All animation data uses flat typed arrays for GPU-friendly memory layout:

- **NodeRest**: 10 fields per node (tx,ty,tz, rx,ry,rz,rw, sx,sy,sz) stored in `GltfAnimationData.nodes[]`
- **AnimationSampler.output**: Packed contiguously:
  - LINEAR/STEP: `[value0, value1, ...]` — `stride` floats per keyframe
  - CUBICSPLINE: `[inTangent0, value0, outTangent0, inTangent1, value1, outTangent1, ...]` — `stride * 3` floats per keyframe

### Keyframe Search

`evaluateSampler()` clamps `t <= input[0]` to the first key and `t >= input[last]` to the final key before searching. For interior samples, `findKeyframe(input, t)` performs binary search to find index `i` such that `input[i] <= t < input[i+1]`.

### Scratch Buffer: `_quat`

A module-level `[0,0,0,1]` array is reused for quaternion slerp output to avoid per-call allocation.

### Frame Timing Model

- `AnimationGroup.currentFrame` stores time in **seconds** (not frame numbers, despite the name — matches BJS convention)
- `goToFrame(frame)` converts frame number to seconds with the group's `frameRate`, immediately evaluates the pose when possible, then pauses
- `tickAnimation(group, deltaMs, engine?)` advances `group.currentFrame += (deltaMs / 1000) * speedRatio` and syncs the internal controller only for evaluation/upload
- Duration is in seconds (max sampler input timestamp)
- Looping wraps via modulo within the active range: `time = from + ((time - from) % (to - from))`
- glTF groups default to 60fps; property groups inherit the `PropertyAnimationClip.frameRate`
- Babylon-style frame ranges are converted once with the clip `frameRate`

### AnimationManager Lifecycle

`AnimationManager` is a standalone owner for generic animation tasks. It has no scene dependency and can be driven three ways:

```typescript
const manager = createAnimationManager();
startAnimationManager(manager);          // autonomous requestAnimationFrame loop
updateAnimationManager(manager, 16.667); // caller-owned loop
goToFrame(group, 20);                    // deterministic seek + pose evaluation
```

A scene may still own loaded animation groups through `scene.animationGroups`. Non-scene code can create a standalone manager directly and register whichever animatable adapters it wants.

Animation groups are registered through `animation-group-task.ts`: `addAnimationGroup()` stores group ownership outside the generic manager, then adds an internal task that calls `tickAnimation(group, deltaMs, manager.engine)`. Other feature modules can register their own adapters with `createAnimationTask()` / `addAnimationTask()` without making `animation-manager.ts` import those feature modules.

Weighted animation mixers remain animation-group-specific opt-ins. They install a handler for the `animation-group` task category; when that handler blends and advances group tasks for a tick, the manager skips only that category and continues updating unrelated tasks, such as sprite frame animation tasks.

The autonomous `requestAnimationFrame` lifecycle now lives directly in `AnimationManager`. The manager owns `running`, `_rafId`, `_lastTime`, fixed-delta stepping, `onUpdate`, task dispatch, and start/stop scheduling.

### Usage Examples

Manual property animation, matching Babylon.js `beginDirectAnimation(target, [animation], from, to, loop)`:

```typescript
const manager = createAnimationManager();
const clip = createPropertyAnimationClip(
    "xSlide",
    [
        {
            path: "position.x",
            frameRate: 10,
            keys: [
                { frame: 0, value: 2 },
                { frame: 10, value: -2 },
                { frame: 20, value: 2 },
            ],
        },
    ]
);
const group = createPropertyAnimationGroup(manager, box, clip, { fromFrame: 0, toFrame: 20, loop: true });
startAnimationManager(manager);
```

Autonomous, no-scene animation:

```typescript
const target = { position: { x: -2 } };
const manager = createAnimationManager({ onUpdate: () => draw(target.position.x) });
const group = createPropertyAnimationGroup(manager, target, clip);
startAnimationManager(manager);
```

Unified glTF + manual animation ownership:

```typescript
const shark = await loadGltf(engine, "https://models.babylonjs.com/shark.glb");
for (const entity of shark.entities) {
    addToScene(scene, entity);
}

const manager = createAnimationManager({ engine });
addAnimationGroups(manager, shark.animationGroups ?? []);
createPropertyAnimationGroup(manager, camera, cameraClip, { loop: true });
onBeforeRender(scene, (deltaMs) => updateAnimationManager(manager, deltaMs));
```

Weighted manual animation and deterministic cross-fade:

```typescript
const walk = createPropertyAnimationGroup(manager, box, walkClip);
const run = createPropertyAnimationGroup(manager, box, runClip);

enablePropertyAnimationBlending(manager);
setAnimationWeight(walk, 1);
setAnimationWeight(run, 0);
crossFadeAnimationGroups(manager, walk, run, { durationMs: 300 });
```

Weighted glTF skeleton blend:

```typescript
const xbot = await loadGltf(engine, "https://playground.babylonjs.com/scenes/Xbot.glb");
for (const entity of xbot.entities) {
    addToScene(scene, entity);
}

const manager = createAnimationManager({ engine });
addAnimationGroups(manager, xbot.animationGroups ?? []);

for (const group of xbot.animationGroups ?? []) {
    setAnimationWeight(group, 0);
}
setAnimationWeight(xbot.animationGroups!.find((group) => group.name === "walk")!, 0.5);
setAnimationWeight(xbot.animationGroups!.find((group) => group.name === "run")!, 0.5);
enableAnimationBlending(manager);
onBeforeRender(scene, (deltaMs) => updateAnimationManager(manager, deltaMs));
```

Additive pose/loop layers on top of an override clip:

```typescript
setAnimationWeight(walk, 1);

setAnimationAdditive(headShake, { referenceFrame: 0 });
setAnimationWeight(headShake, 0.6);

setAnimationAdditive(sadPose, { referenceFrame: 0 });
sadPose.currentFrame = 2 / sadPose.frameRate;
pauseAnimation(sadPose);
setAnimationWeight(sadPose, 0.35);

enableAnimationBlending(manager);
```

### AnimationGroup Creation

`createAnimationGroups()` creates one `AnimationGroup` per `AnimationClip`. Each group wraps an `AnimationController` (from `skeleton-updater.ts`) with a single-clip slice of the animation data. All groups auto-play by default (matching BJS behavior).

Manual property clips share sampler evaluation with glTF animation, but they do not masquerade as glTF `AnimationChannel`s. `createPropertyAnimationClip()` stores reusable unresolved property tracks. `createPropertyAnimationGroup()` resolves each track against the target once, builds compact property runtime tracks (`sampler`, `stride`, `quaternion`, `writer`, `mixTarget`, `mixProperty`), and wraps them in an `AnimationGroup`. The hot path remains `evaluateSampler()` plus direct property writers.

### Property Binding

Manual property bindings are resolved once when the group is created:

- scalar paths (`position.x`, `alpha`, `visible`) write directly to the resolved property;
- vector/quaternion paths (`position`, `scaling`, `rotationQuaternion`) call `.set(...)` when the target object exposes a setter method;
- invalid paths throw immediately during `createPropertyAnimationGroup()` so typos never fail silently.

Bindings are target-specific; `PropertyAnimationClip` is reusable, while the generated property runtime tracks are owned by the returned `AnimationGroup`.

### Manual Weight Mixing

Manual property weights are optional and live outside the default direct evaluator. Calling `enablePropertyAnimationBlending(manager)` installs a manager-side mixer for manual property tracks that share the same target and property path. `setAnimationWeight()` only changes the group weight, so glTF-only scenes do not load the manual property mixer. The mixer advances group time once, samples each contributing clip with `evaluateSampler()`, then writes one final weighted value per property so multiple groups do not devolve into last-write-wins behavior.

Weights intentionally use Babylon-style weighted sums for this first layer: `final = sum(group.weight * sampledValue)` for the groups targeting the same property. The mixer does not normalize totals and does not blend toward rest pose. `crossFadeAnimationGroups()` builds on the same weights by scheduling deterministic duration-based fade jobs inside the manager.

### glTF Skeleton Weight Mixing

Weighted glTF skeleton blending is kept behind the generic `enableAnimationBlending(manager)` opt-in so manual-only or direct glTF playback does not load the skeletal mixer. Once enabled, groups sharing the same parsed glTF node array are evaluated into one mixed TRS pose and each affected skeleton uploads its bone texture once per update.

The default blend semantics match Babylon.js weights: translation and scale use weighted sums, rotation uses weighted quaternion accumulation with hemisphere correction and final normalization, and weights are not normalized. The current glTF mixer covers skeleton TRS channels; morph target blending is planned as a follow-on mixer pass.

Additive groups are marked with `setAnimationAdditive(group, { referenceFrame })`. The mixer evaluates override/base groups first, then applies additive deltas in manager order before the single skeleton upload. Translation and scale add `sample - reference` by weight; rotations compute `reference^-1 * sample`, multiply that delta onto the base rotation, then slerp from base to the delta-applied rotation by the additive weight.

## Pipeline Configuration

N/A — Animation is a CPU-side system. GPU interaction is limited to:
- `device.queue.writeTexture()` for bone matrix upload (via `skeleton-updater.ts`)
- `device.queue.writeBuffer()` for morph weight upload

## Shader Logic

N/A — No shaders in this module. Skinning WGSL is in `shader/fragments/skeleton-fragment.ts`.

## State Machine / Lifecycle

```
┌─────────┐  play()   ┌─────────┐  pause()  ┌────────┐
│ STOPPED │ ────────► │ PLAYING │ ────────► │ PAUSED │
│ (t=0)   │ ◄──────── │         │ ◄──────── │        │
└─────────┘  stop()   └─────────┘  play()   └────────┘
                            │
                            │ tickAnimation(group, deltaMs, engine)
                            ▼
                      advance time, wrap/clamp,
                      evaluate channels,
                      upload bone matrices + morph weights
```

- **STOPPED**: `group.isPlaying = false`, `group.currentFrame = 0`, `group._stopped = true`. `tickAnimation()` returns immediately.
- **PLAYING**: `group.isPlaying = true`. Each `tickAnimation()` advances time, evaluates samplers, uploads GPU data.
- **PAUSED**: `group.isPlaying = false`. `tickAnimation()` still evaluates (ensures pose is current) but doesn't advance time.
- **goToFrame(f)**: Sets `group.currentFrame = f / group.frameRate`, evaluates the pose immediately for manual property clips (or engine-backed clips when an engine is provided), then pauses.

## Babylon.js Equivalence Map

| Babylon.js API | Babylon Lite |
|---|---|
| `new Animation(name, "position.x", frameRate, FLOAT, CYCLE)` | `createPropertyAnimationClip(name, [{ path: "position.x", frameRate, keys }])` |
| `animation.setKeys(keys)` | keys passed to `createPropertyAnimationClip()` |
| `scene.beginDirectAnimation(target, [anim], from, to, loop)` | `createPropertyAnimationGroup(manager, target, clip, { fromFrame: from, toFrame: to, loop })` |
| `AnimationGroup` | `AnimationGroup` interface |
| `AnimationGroup.play()` | `playAnimation(group)` |
| `AnimationGroup.pause()` | `pauseAnimation(group)` |
| `AnimationGroup.stop()` | `stopAnimation(group)` |
| `AnimationGroup.goToFrame(f)` | `goToFrame(group, f)` (uses `group.frameRate`) |
| `AnimationGroup.speedRatio` | `group.speedRatio` |
| `AnimationGroup.loopAnimation` | `group.loopAnimation` |
| `AnimationGroup.weight` / `setWeightForAllAnimatables()` | `setAnimationWeight(group, weight)`; call `enableAnimationBlending(manager)` for weighted glTF skeleton clips |
| `AnimationGroup.MakeAnimationAdditive(group, frame)` | `setAnimationAdditive(group, { referenceFrame: frame })` |
| manual property weighted blending | `enablePropertyAnimationBlending(manager)` + `setAnimationWeight(group, weight)` |
| manual weight ramp / blending speed | `fadeAnimationWeight(manager, group, { to, durationMs })` |
| manual cross-fade | `crossFadeAnimationGroups(manager, from, to, { durationMs })` |
| `scene.animationGroups` | `scene.animationGroups` |
| `Animation.ANIMATIONTYPE_QUATERNION` | `PATH_ROTATION = 1` |
| `Animation.ANIMATIONTYPE_VECTOR3` | `PATH_TRANSLATION = 0`, `PATH_SCALE = 2` |

## Dependencies

- `../math/mat4.js` — `quatSlerp` for LINEAR quaternion interpolation
- `../skeleton/skeleton-updater.js` — `createAnimationController`, `AnimationController`
- `../loader-gltf/gltf-animation.ts` — `parseAnimationData` (glTF → `GltfAnimationData`)
- `../loader-gltf/gltf-parser.ts` — `resolveAccessor`, `computeNodeWorldMatrix`, `findParent`
- `./animation-manager.ts` — generic task scheduler; owns update/start/stop/fixed-delta semantics
- `./animation-group-task.ts` — AnimationGroup-to-AnimationTask adapter and ownership state
- `./property-animation.ts` — manual property clip builder and property path binding
- `./weighted-pointer-mixer.ts` — optional manual property weight mixer and duration-based weight fades
- `./weighted-gltf-mixer.ts` — optional glTF skeleton weight mixer, loaded only when explicitly imported/enabled

## Test Specification

1. **LINEAR interpolation**: Verify vec3 lerp and quat slerp produce correct intermediate values
2. **STEP interpolation**: Verify output snaps to keyframe value without blending
3. **CUBICSPLINE interpolation**: Verify Hermite spline evaluation with tangents; verify quaternion normalization
4. **Binary search edge cases**: `t` before first key, after last key, exactly on a key, between keys
5. **AnimationGroup lifecycle**: play → tick → verify time advances; pause → tick → verify time frozen; stop → verify reset to 0
6. **goToFrame**: Verify `goToFrame(120)` sets time to `2.0` seconds, evaluates the pose immediately, and pauses
7. **Looping**: Verify time wraps correctly at duration boundary
8. **Speed ratio**: Verify `speedRatio = 2` doubles playback speed
9. **Morph weight upload**: Verify correct weights written to GPU buffer for PATH_WEIGHTS channels
10. **Manual scalar animation**: Verify `position.x` keyframes reproduce Babylon frame-rate timing
11. **Manual vector animation**: Verify `position` calls `.set(x, y, z)` and marks world matrices dirty
12. **Standalone manager**: Verify `updateAnimationManager()` works without a scene or engine for manual property clips
13. **Bad path failure**: Verify invalid property paths throw during binding
14. **Manual weighted blend**: Verify two groups targeting one scalar write a single weighted result independent of group order
15. **Manual cross-fade**: Verify manager fade jobs update group weights by elapsed duration
16. **glTF weighted skeleton blend**: Verify Xbot walk/run weighted TRS blending matches Babylon.js reference
17. **Additive skeleton blend**: Verify Xbot additive pose/loop layers match Babylon.js reference

## File Manifest

| File | Purpose |
|---|---|
| `types.ts` | All animation data types, interpolation/path constants, GPU-attached data interfaces |
| `evaluate.ts` | Keyframe interpolation engine (LINEAR, STEP, CUBICSPLINE); binary search; zero-allocation |
| `animation-group.ts` | User-facing AnimationGroup factory; wraps AnimationController per clip |
| `animation-manager.ts` | Generic animation task scheduler; no 2D, 3D, glTF, or property-animation runtime imports |
| `animation-group-task.ts` | AnimationGroup-to-AnimationTask adapter, owner tracking, and `getAnimationGroups()` lookup |
| `property-animation.ts` | Manual property animation clip builder and property path binding |
| `weighted-pointer-mixer.ts` | Optional manual property weight mixer plus fade/cross-fade scheduling |
| `weighted-gltf-mixer.ts` | Optional glTF skeleton weighted/additive mixer with single skeleton upload per blended target |
