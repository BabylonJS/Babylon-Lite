# Module: Skeleton
> Package path: `packages/babylon-lite/src/skeleton/`

## Purpose

Provides GPU-accelerated skeletal animation infrastructure. Creates bone textures and vertex buffers from parsed glTF skin data, and provides per-frame bone matrix evaluation and GPU upload. Supports both 4-bone and 8-bone skinning paths. The skeleton system is lazily imported — scenes without skinned meshes never load this module.

## Public API Surface

### Functions

```typescript
// create-skeleton.ts
export function createSkeleton(
    device: GPUDevice,
    joints: Uint16Array | Uint8Array,          // 4 joint indices per vertex (JOINTS_0)
    weights: Float32Array,                      // 4 blend weights per vertex (WEIGHTS_0)
    boneCount: number,                          // number of bones (joints)
    boneData: Float32Array,                     // initial bone matrices (16 floats per bone)
    joints1?: Uint16Array | Uint8Array | null,  // JOINTS_1 for 8-bone skinning
    weights1?: Float32Array | null              // WEIGHTS_1 for 8-bone skinning
): SkeletonData;
```

```typescript
// skeleton-updater.ts
export interface AnimationController {
    tick(deltaMs: number, device: GPUDevice): void;
    time: number;                       // current playback time in seconds
    playing: boolean;
    speedRatio: number;                 // default 1
    loop: boolean;                      // default true
    readonly _debugWorldMat?: Float32Array;
    readonly _debugNodeNames?: string[];
}

export function createAnimationController(animData: GltfAnimationData): AnimationController;
```

### Types (from `animation/types.ts`)

```typescript
export interface SkeletonData {
    readonly boneTexture: GPUTexture;
    readonly boneCount: number;
    readonly jointsBuffer: GPUBuffer;
    readonly weightsBuffer: GPUBuffer;
    readonly joints1Buffer: GPUBuffer | null;
    readonly weights1Buffer: GPUBuffer | null;
}
```

## Internal Architecture

### Bone Texture Format

Each bone is stored as a 4×4 matrix in a 1D `rgba32float` texture:
- **Texture dimensions**: `[boneCount * 4, 1]` (width × height)
- **Layout**: 4 texels per bone (one per matrix column), each texel = rgba32float (4 floats)
- **Total**: 16 floats per bone = 64 bytes per bone
- **Usage flags**: `TEXTURE_BINDING | COPY_DST`

The vertex shader samples this texture using `textureLoad(boneTex, vec2<i32>(boneIdx * 4 + col, 0), 0)` to reconstruct bone matrices.

### Vertex Buffer Layout

Joint indices are expanded from `Uint8Array`/`Uint16Array` to `Uint32Array` because the pipeline reads `uint32x4` vertex format. Both joints and weights buffers use:
- **Usage**: `VERTEX | COPY_DST`
- **Minimum size**: 4 bytes (to satisfy WebGPU minimum buffer size)
- **Mapped at creation**: Data is copied via `mappedAtCreation: true` for efficient upload

### 4-Bone vs 8-Bone Skinning

- **4-bone**: Uses `JOINTS_0` + `WEIGHTS_0` → `jointsBuffer` + `weightsBuffer`
- **8-bone**: Additionally uses `JOINTS_1` + `WEIGHTS_1` → `joints1Buffer` + `weights1Buffer`
- Detection: Presence of `joints1`/`weights1` parameters (sourced from glTF `JOINTS_1`/`WEIGHTS_1` attributes)
- The skeleton `ShaderFragment` generates different WGSL for 4 vs 8 bones

### Per-Frame Bone Matrix Computation — `skeleton-updater.ts`

The `AnimationController.tick()` method performs these steps each frame:

#### 1. Reset to Rest Pose
Copy rest-pose TRS from `GltfAnimationData.nodes[]` into pre-allocated `currentTRS` scratch buffer.
Layout per node: 12 floats (`TRS_STRIDE = 12`):
- `[0..2]` = translation (T_OFF = 0)
- `[3..6]` = rotation quaternion xyzw (R_OFF = 3)
- `[7..9]` = scale (S_OFF = 7)
- `[10..11]` = padding

#### 2. Evaluate Animation Channels
For each channel in the active clip, evaluate its sampler at current time `t`:
- `PATH_TRANSLATION`: `evaluateSampler(sampler, t, 3, false, currentTRS, base + T_OFF)`
- `PATH_ROTATION`: `evaluateSampler(sampler, t, 4, true, currentTRS, base + R_OFF)`
- `PATH_SCALE`: `evaluateSampler(sampler, t, 3, false, currentTRS, base + S_OFF)`
- `PATH_WEIGHTS`: Evaluate morph weights and upload to GPU buffer (first 16 bytes = weights vec4)

#### 3. Local → World Matrix Computation
Process nodes in topological order (parents before children):
```
for each node in topoOrder:
    localMat[node] = compose(translation, rotation, scale)
    if node has parent:
        worldMat[node] = worldMat[parent] * localMat[node]
    else:
        worldMat[node] = RH_TO_LH * localMat[node]   // root: apply handedness fix
```

The `RH_TO_LH` matrix is `diag(-1, 1, 1, 1)` — converts glTF right-handed to BJS left-handed coordinates.

Topological order is computed once at init via `computeTopoOrder()` using iterative DFS.

#### 4. Bone Matrix Upload
For each skeleton binding:
```
for each bone i:
    boneMatrix[i] = invMeshWorld * worldMat[jointNode[i]] * inverseBindMatrix[i]
```

The multiplication is performed in-place using pre-allocated `boneScratch` arrays:
1. `mat4MultiplyInto(boneData, bi*16, invMeshWorld, 0, worldMat, jointIdx*16)` — temp = invMeshWorld × jointWorld
2. Manual 4-column matrix multiply: temp × IBM → boneData[bi*16]

Upload via: `device.queue.writeTexture({ texture: boneTexture }, boneData.buffer, { bytesPerRow: texWidth * 16 }, { width: texWidth, height: 1 })`

### Pre-Allocated Scratch Buffers

All scratch memory is allocated once in `createAnimationController()`:
- `currentTRS`: `Float32Array(numNodes * TRS_STRIDE)` — animated TRS per node
- `localMat`: `Float32Array(numNodes * 16)` — local transform matrices
- `worldMat`: `Float32Array(numNodes * 16)` — world transform matrices
- `boneScratch`: `Float32Array(boneCount * 16)` per skeleton — bone matrix output
- `morphWeightScratch`: `Float32Array(8)` — temporary morph weight evaluation
- `morphUploadF32`: `Float32Array(4)` — morph weight GPU upload buffer

### Morph Weight Upload

For `PATH_WEIGHTS` channels:
1. Evaluate sampler → `morphWeightScratch[0..targetCount-1]`
2. Copy to `morphUploadF32[0..3]` (max 4 targets)
3. Write to each morph binding's GPU buffer: `device.queue.writeBuffer(mb.weightsBuffer, 0, morphUploadF32.buffer, 0, 16)`

Only the first 16 bytes (weights vec4) are written; count/texWidth/rowsPerBand in the morph UBO are immutable.

## Pipeline Configuration

N/A — Skeleton is a CPU-side module. GPU interaction is write-only (texture/buffer uploads). The skeleton `ShaderFragment` (in `shader/fragments/skeleton-fragment.ts`) handles the vertex shader side.

## Shader Logic

N/A — No shaders in this module. The vertex shader skinning code is provided by the skeleton `ShaderFragment`, which reads the bone texture and computes:
```wgsl
let skinMatrix = w0 * boneMatrix[j0] + w1 * boneMatrix[j1] + w2 * boneMatrix[j2] + w3 * boneMatrix[j3];
// For 8-bone: + w4 * boneMatrix[j4] + ... + w7 * boneMatrix[j7]
finalWorld = mesh.world * skinMatrix;
```

## State Machine / Lifecycle

```
glTF load
  │
  ▼
extractSkin() ──► GltfSkinData { jointNodes, IBM, jointWorldMatrices, meshWorldMatrix }
  │
  ▼
computeBoneTextureData() ──► Float32Array (rest-pose bone matrices)
  │
  ▼
createSkeleton() ──► SkeletonData { boneTexture, jointsBuffer, weightsBuffer, ... }
  │                    (attached to mesh.skeleton)
  ▼
parseAnimationData() ──► GltfAnimationData { clips, nodes, skeletons, morphBindings }
  │
  ▼
createAnimationController() ──► AnimationController
  │                               (pre-allocates all scratch buffers)
  ▼
createAnimationGroups() ──► AnimationGroup[]
  │                          (one per clip, wraps controller)
  ▼
Per frame: tickAnimation(group, deltaMs, engine)
  └──► controller.tick() → evaluate → compute matrices → GPU upload
```

### glTF Integration

The glTF loader (`load-gltf.ts`) integrates skeleton creation:
1. Parses `JOINTS_0`, `WEIGHTS_0` (and optionally `JOINTS_1`, `WEIGHTS_1`) vertex attributes
2. For nodes with `skin` property, calls `extractSkin()` to get joint data and inverse bind matrices
3. Calls `computeBoneTextureData()` to compute rest-pose bone matrices
4. Calls `createSkeleton()` to create GPU resources
5. Attaches `SkeletonData` to `mesh.skeleton`
6. After all meshes: `parseAnimationData()` builds `GltfAnimationData` with skeleton bindings pointing to each mesh's `boneTexture`

All skeleton/animation modules are **dynamically imported** — only loaded when glTF contains skins or animations.

## Bone Control (opt-in)

`bone-control.ts` adds a user-facing API to override individual bone transforms on a
loaded skinned model — the Lite equivalent of manipulating `skeleton.bones[i]` in
Babylon.js (e.g. "scale a bone to 0 to hide its sub-tree", or pose a bone the playing
clip does not animate).

It is **opt-in and near-zero bundle cost when unused**: the always-fetched skeleton /
animation chunk references it only through two null hooks (`bone-control-hooks.ts`).
Calling `enableBoneControl()` installs the implementation; until then the whole module
(handle building, eager bake, override application) tree-shakes away.

```typescript
// Public API (index.ts)
export function enableBoneControl(): void;                  // call ONCE before loading
export function getBoneByName(skeleton: Skeleton, name: string): Bone | undefined;
export function setBonePosition(skeleton: Skeleton, bone: Bone, x, y, z): void;
export function setBoneRotationQuaternion(skeleton: Skeleton, bone: Bone, x, y, z, w): void;
export function setBoneScaling(skeleton: Skeleton, bone: Bone, x, y, z): void;
export function setBoneVisible(skeleton: Skeleton, bone: Bone, visible: boolean): void; // scale→0 hide
export function clearBoneOverride(skeleton: Skeleton, bone: Bone): void;
export interface Skeleton { readonly bones: readonly Bone[]; /* +@internal */ }
export interface Bone { readonly name: string; /* +@internal */ }
```

```typescript
enableBoneControl();                                  // ← before loadGltf
const character = await loadGltf(engine, "character.glb");
addToScene(scene, character);
const skel = character.skeletons![0];                 // one per glTF skin
const head = getBoneByName(skel, "Head");
if (head) setBoneVisible(skel, head, false);          // hide the head + everything under it
```

### Semantics

- **Eager bake.** Each `setBone*` immediately recomputes the asset's bone matrices from
  the rest pose + overrides and uploads the bone textures, so overrides apply even with
  **no** animation playing (static models).
- **Animation wins per-component.** When a clip plays, the per-frame tick re-applies
  overrides right after the rest reset and **before** channel evaluation, so any component
  a clip animates overwrites the override; components the clip does not touch keep it.
- **One handle per skin, re-bakes every mesh.** A glTF skin split across multiple meshes
  (e.g. Xbot's `Beta_Joints` + `Beta_Surface`) produces one bone texture *per mesh* in
  Lite, hence one `Skeleton` handle per skinned mesh on `container.skeletons`. The override
  map is asset-wide and the eager bake re-bakes **all** of the asset's bone textures, so a
  single `setBone*` updates every mesh that shares the skin — matching Babylon.js's shared
  `Skeleton`.

The internal `BoneOverride` map type is kept off the public API surface: public boundaries
(`createAnimationController`, `GltfAnimationData.boneOverrides`) type it as
`ReadonlyMap<number, unknown>` and the internal hook casts back.

## Babylon.js Equivalence Map

| Babylon.js | Babylon Lite |
|---|---|
| `Skeleton` class | `SkeletonData` plain data + `AnimationController` |
| `Bone[]` hierarchy | `NodeRest[]` flat array + `parentIdx` links |
| `skeleton.getTransformMatrices()` → Float32Array buffer | Bone texture (`rgba32float`, 4 texels/bone) |
| `skeleton.prepare()` per frame | `AnimationController.tick()` |
| `Mesh.useBones` | Presence of `mesh.skeleton` property |
| 4-bone: `matricesIndices`, `matricesWeights` | `jointsBuffer`, `weightsBuffer` |
| 8-bone: `matricesIndicesExtra`, `matricesWeightsExtra` | `joints1Buffer`, `weights1Buffer` |
| `bone.setRotationQuaternion()` / `bone.setScale()` / pose a bone | `setBoneRotationQuaternion()` / `setBoneScaling()` (after `enableBoneControl()`) |
| Scale a bone to 0 to hide its sub-tree | `setBoneVisible(skel, bone, false)` |
| `skeleton.bones.find(b => b.name === ...)` | `getBoneByName(skeleton, name)` |

## Dependencies

- `../animation/types.js` — `GltfAnimationData`, `SkeletonData`, `AnimationClip`, path/interp constants
- `../animation/evaluate.js` — `evaluateSampler()` for keyframe interpolation
- `../math/mat4.js` — `mat4ComposeInto`, `mat4MultiplyInto` for matrix computation

## Test Specification

1. **createSkeleton**: Verify bone texture dimensions = `boneCount * 4` × 1, format `rgba32float`
2. **4-bone path**: Verify joints expanded to Uint32Array, buffers created with correct sizes
3. **8-bone path**: Verify `joints1Buffer` and `weights1Buffer` are non-null when JOINTS_1/WEIGHTS_1 provided
4. **Rest-pose bone matrices**: Verify `computeBoneTextureData()` produces identity for trivial cases
5. **Per-frame evaluation**: Verify `tick()` produces correct bone matrices for a known animation clip
6. **Topological order**: Verify parents are always processed before children
7. **RH→LH transform**: Verify root nodes get `diag(-1,1,1,1)` pre-multiplied
8. **Morph weight upload**: Verify correct 16-byte write to morph weight buffer
9. **Zero-allocation**: Verify no `new Float32Array` calls in `tick()` hot path

## File Manifest

| File | Purpose |
|---|---|
| `create-skeleton.ts` | GPU resource factory: creates bone texture + joint/weight vertex buffers from parsed glTF skin data |
| `skeleton-updater.ts` | Per-frame animation evaluation: keyframe interpolation → hierarchy traversal → bone matrix computation → GPU upload |
| `skeleton-pose.ts` | Shared bake primitives (topo order, rest reset, world matrices, bone-texture upload) used by the opt-in eager bone-control bake |
| `bone-control.ts` | Opt-in bone-control API: `enableBoneControl`, `getBoneByName`, `setBone*`, eager bake + per-frame override applier |
| `bone-control-hooks.ts` | Two null hooks (`_boneBuilder`, `_boneApplier`) so the always-fetched chunk references bone control without bundling it |
