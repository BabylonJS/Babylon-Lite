# Module: Vertex Animation Texture (VAT)
> Package paths: `packages/babylon-lite/src/vat/` (baker + runtime), `packages/babylon-lite/src/material/pbr/fragments/vat-fragment.ts` (GPU vertex path)

## Purpose

Pre-evaluates a skinned mesh's skeletal animation on the CPU and bakes every frame's bone matrices into ONE `rgba32float` texture (the **Vertex Animation Texture**), then renders the mesh by reading bone matrices from that texture at the current frame row — with **no live CPU skeleton and no per-frame bone upload**. Because the per-frame skeleton work is gone, a baked mesh can be **GPU thin-instanced**: each instance plays its own clip + phase (and can blend two clips for smooth cross-fades) from the one shared texture, so a whole crowd of animated meshes renders in a single draw call and casts CSM shadows.

Strictly opt-in and lazily imported: a scene that never bakes a VAT never loads this module, and the shared PBR renderable carries no VAT-specific code (the VAT extension self-registers when `attachVat` runs), so **non-VAT scenes are byte-identical**.

Mirrors the Babylon.js `VertexAnimationBaker` / `BakedVertexAnimationManager` API shape, adapted to Lite/WebGPU.

## Public API Surface

### Functions (`vat/vat-baker.ts`)

```typescript
export function bakeVat(engine: EngineContext, mesh: Mesh, groups: AnimationGroup[]): VatBakeResult;
export function attachVat(engine: EngineContext, mesh: Mesh, baked: VatBakeResult, clip?: string): VatHandle;
```

- **`bakeVat`** — evaluates each clip in `groups` frame-by-frame (the mesh must still have its live `mesh.skeleton`), stacking the bone matrices into one `rgba32float` texture: width `boneCount*4`, height = total frame count, one animation frame per row. Returns the texture + a per-clip row map.
- **`attachVat`** — sets `mesh.vat`, NULLS `mesh.skeleton` (no more live skinning), builds the 32-byte settings UBO, self-registers the VAT `pbrExt`, and returns a `VatHandle`. `clip` selects the initial clip (defaults to the first baked clip).

### Types (`vat/vat-baker.ts`)

```typescript
export interface VatClip { readonly fromRow: number; readonly frameCount: number; readonly fps: number; }

export interface VatBakeResult {
    readonly texture: GPUTexture;                  // rgba32float, (boneCount*4) x frameCount
    readonly boneCount: number;
    readonly frameCount: number;
    readonly clips: Record<string, VatClip>;       // clip name -> row range
}

export interface VatHandle {
    readonly mesh: Mesh;
    readonly clips: Record<string, VatClip>;
    play(clip: string, opts?: { offset?: number; fps?: number }): void;  // shared (non-instanced) playback
    update(dtSeconds: number): void;                                      // advance the shared clock
    setInstances(params: Float32Array): void;                            // per-instance single clip (4 floats/inst)
    setInstancesBlend(params: Float32Array): void;                       // per-instance dual-clip blend (8 floats/inst)
}
```

### Internal type (`animation/types.ts`, not exported — like `SkeletonData`)

```typescript
export interface VatData {
    boneCount: number;
    texture: GPUTexture;                 // the baked bone texture
    frameCount: number;
    settingsBuffer: GPUBuffer;           // 32-byte UBO: params vec4 + clock vec4
    jointsBuffer: GPUBuffer;             // reused from the (now-dropped) skeleton
    weightsBuffer: GPUBuffer;
    joints1Buffer: GPUBuffer | null;     // 8-bone
    weights1Buffer: GPUBuffer | null;
    instanceTexture?: GPUTexture | null; // per-instance params ((2*instanceCount) x 1, two texels/instance)
}
```

### Mesh feature bits (`material/mesh-features.ts`)

```typescript
export const MSH_VAT = 1 << 9;             // mesh.vat present — the ONLY VAT mesh-feature bit
// "Instanced VAT" needs NO dedicated bit: it is derived in the fragment from
//   (MSH_VAT && MSH_HAS_THIN_INSTANCES)
// so mesh-features.ts (a shared chunk fetched by every scene) is byte-identical for non-VAT scenes
// (zero bundle movement). 8-bone uses the existing MSH_HAS_SKELETON_8.
```

## Internal Architecture

### Baked texture format (identical to the live bone texture)

The per-row layout matches `skeleton/create-skeleton.ts` exactly — 4 texels per bone (one mat4 column each), so `VAT(frame N)` reproduces the live pose at frame N to full float precision (parity MAD ~= 0.000 vs the live skeleton):

- **Dimensions**: `[boneCount * 4, frameCount]` (width × height), `rgba32float`.
- **Row r** = the bone matrices for animation frame `r` (16 floats/bone = 4 texels).
- **Usage**: `TEXTURE_BINDING | COPY_DST`. Uploaded once via `writeTexture` (bytesPerRow = `boneCount*4*16`).

### Baking (`bakeVat`)

`clipFrameCount(group) = round(group.duration * group.frameRate) + 1`. Clips are laid out as contiguous row blocks (clip 0 first); `clips[name] = { fromRow, frameCount, fps }`. For each frame: `goToFrame(group, f, engine)` ticks the controller, then the frame's matrices are read from the `SkeletonBinding` (`group._gltfMixer[2][0].boneMatrices`) and copied into the row. `stopAnimation(group)` after each clip (VAT replaces live playback).

### Settings UBO (32 bytes, `attachVat`)

```
params: vec4<f32> = (fromRow, toRow, frameOffset, fps)   // shared/non-instanced playback
clock:  vec4<f32> = (elapsedSeconds, _, _, _)            // advanced by update()
```

`play(name, opts)` writes `params`; `update(dt)` accumulates `clock.x`. Both `writeBuffer` the 32-byte UBO.

### Per-instance params texture (`setInstances` / `setInstancesBlend`)

A separate `rgba32float` texture of `texels × 1`, read in the vertex shader by `@builtin(instance_index)`. Chosen over a storage buffer / uniform array / vertex attribute so there is **no new binding kind, no pipeline fragmentation, and zero touch to the shared instancing/draw path** — it rides the existing VAT bind hook exactly like the bone texture.

- **`setInstances`** (single clip): `params.length = 4 * instanceCount` = `(fromRow, toRow, timeOffset, fps)` per instance. Internally expanded to the dual-clip layout (clip B == A, blend 0), so there is ONE instanced shader variant.
- **`setInstancesBlend`** (dual clip): `params.length = 8 * instanceCount` — texel `2i` = A `(fromRow, toRow, offset, fpsA)`, texel `2i+1` = B `(fromRow, toRow, blend, fpsB)` (B reuses A's offset). `blend` in `[0,1]` lerps A→B. **The texture is always TWO texels per instance.**

The texture grows in place (capacity in texels); the shared clock still drives the crowd while per-instance offsets stagger the phase.

## Pipeline Configuration

The VAT `pbrExt` (`vat-fragment.ts`) is a **vertex-phase** PBR extension. It is **self-registered** by `attachVat` via `_registerPbrExt` (mirroring `enableMaterialPlugins`) — the shared `pbr-renderable` has no VAT import. `pbrExt.frag(ctx)` is gated on `MSH_VAT` and returns the fragment for the variant `(has8Bones, instanced)`, where `instanced = (ctx._meshFeatures & MSH_HAS_THIN_INSTANCES)` (no dedicated VAT-instanced bit).

### Group-1 vertex bindings (pushed by `pbrExt.bind`, in declaration order)

| binding | resource | when |
|---|---|---|
| b   | `vatSampler` — `texture_2d<f32>` (unfilterable-float), vertex-visible | always (MSH_VAT) |
| b+1 | `vat` — uniform buffer (settings UBO) | always |
| b+2 | `vatInstanceTex` — `texture_2d<f32>` (unfilterable-float) | `MSH_VAT && MSH_HAS_THIN_INSTANCES` (instanceTexture set) |

### Vertex attributes / builtins

- Reuses the skeleton vertex attributes: `joints`/`weights` (`uint32x4`/`float32x4`), plus `joints1`/`weights1` for 8-bone.
- Instanced variants request `@builtin(instance_index)` via `_vertexBuiltins` (only present in the instanced fragment, so non-instanced VAT is unchanged).
- The instanced fragment declares `_dependencies: ["thin-instance"]` so it composes AFTER the thin-instance fragment in the shared `VW` vertex slot — otherwise thin-instance's `finalWorld` write would clobber the skinned+instanced transform. It reads the per-instance world matrix from `world0..3` (declared by the thin-instance fragment).

### Shadow casting (free)

The CSM caster (`shadow/csm-shadow-task-hooks.ts`) renders each caster mesh through its OWN material renderable with a no-color view. That renderable composes the VAT ext from the mesh features, so a VAT (including instanced) mesh produces correct, per-pose depth in the shadow map with **no shadow-pass changes**.

## Shader Logic (vertex `VW` slot, WGSL outline)

```
fn vatFrameRow(p: vec4f, t: f32) -> i32:        // p = (fromRow, toRow, offset, fps)
    span = max(1, p.y - p.x + 1)
    raw  = p.z + t * p.w
    return i32(p.x + (raw - floor(raw / span) * span))   // wrap into [fromRow, toRow]

fn readMatrixFromVat(smp, index, row) -> mat4x4f:        // 4 texels at (index*4 + col, row)

// Variant A — non-instanced (shared UBO):
vatRow = vatFrameRow(vat.params, vat.clock.x)
influence = sum_k readMatrixFromVat(vatSampler, joints[k], vatRow) * weights[k]   // 4 or 8 bones
finalWorld = mesh.world * influence

// Variant B — instanced (ALWAYS the dual-clip path; single-clip is the blend==0 case):
A = textureLoad(vatInstanceTex, (2*instance_index,   0))
B = textureLoad(vatInstanceTex, (2*instance_index+1, 0))
rowA = vatFrameRow(A, clock); rowB = vatFrameRow((B.xy, A.z, B.w), clock)
infA = sum_k read(joints[k], rowA)*w[k]; infB = sum_k read(joints[k], rowB)*w[k]
influence = infA*(1 - B.z) + infB*B.z                     // weighted bone-matrix blend == gait cross-fade
finalWorld = mat4(world0..3) * mesh.world * influence     // instance OUTERMOST = world-space placement
```

Because skinned-mesh `mesh.world` is identity (glTF loader, see `12-thin-instances.md` §world-matrix), the instance matrix carries all placement (position/yaw/scale). The single instanced variant always runs the 2-clip blend (single-clip = blend 0), so there is **no extra mesh-feature bit and zero bundle movement on non-VAT scenes**; the 2× bone reads are negligible vs the one-draw-call win.

## State Machine / Lifecycle

1. Load + animate a skinned glTF (live skeleton present).
2. `bakeVat(engine, mesh, groups)` → texture + clip map (one-time, ~ms/clip).
3. `attachVat(engine, mesh, baked, clip?)` → `mesh.vat` set, `mesh.skeleton = null`, VAT ext registered.
4. (optional) `setThinInstances(mesh, matrices, count)` + `handle.setInstances`/`setInstancesBlend(params)` BEFORE `registerScene` (the first call sets `instanceTexture`, selecting the instanced shader variant). Per-instance params may be re-uploaded in place later.
5. Per frame: `handle.update(dt)` advances the shared clock; per-instance matrices/params are updated via the thin-instance/VAT setters as the simulation changes.

## Babylon.js Equivalence Map

| Babylon.js | Lite VAT |
|---|---|
| `VertexAnimationBaker.bakeVertexData(ranges)` | `bakeVat(engine, mesh, groups)` |
| `BakedVertexAnimationManager` (manager.time, setAnimationParameters) | `VatHandle` (`update`, `play`) |
| `mesh.bakedVertexAnimationManager` | `mesh.vat` (`VatData`) |
| `manager.texture` (VAT texture) | `VatBakeResult.texture` / `VatData.texture` |
| Per-instance via `bakedVertexAnimationSettingsInstanced` buffer | `setInstances` / `setInstancesBlend` → `instanceTexture` (read by `instance_index`) |

## Dependencies

- `animation/animation-group.ts` — `goToFrame`, `stopAnimation`, the `SkeletonBinding` (read at bake).
- `skeleton/create-skeleton.ts` — the live bone texture whose per-row layout VAT mirrors; VAT reuses the skeleton's joints/weights vertex buffers.
- `material/pbr/pbr-flags.ts` — `_registerPbrExt`, `PbrExt` (`frag`/`bind`).
- `material/mesh-features.ts` — `MSH_VAT*` detection.
- `shader/fragments/thin-instance-fragment.ts` — declares `world0..3` (instanced variants depend on it).
- The CSM caster path for shadow casting (no code dependency; works via material renderable reuse).

## Test Specification

- **Parity (`tests/lite/parity/scenes/scene218-vat.spec.ts`)** — scene 218 bakes the scene-11 shark and renders it through the VAT path with NO live skeleton; the golden is the BJS live-skeleton oracle frozen at the same integer frame (`?seekTime`). Asserts full-image MAD ≤ `scene-config.maxMad` (0.02). VAT(frame N) == live(frame N), so MAD ~= 0.000.
- **Manual / lab (`lab/lite/scene219.ts`)** — 36 baked sharks thin-instanced, blending swimming↔circling across the grid and casting CSM shadows, in one draw call per pass. (Dev scene; not a parity scene — instanced VAT has no single-mesh BJS oracle.)
- **Bundle size** — non-VAT scenes are byte-unchanged (self-registration); VAT scene bundles include only the lazily-imported `vat` chunk.

## File Manifest

```
packages/babylon-lite/src/vat/vat-baker.ts                          # bakeVat, attachVat, VatHandle, setInstances(Blend)
packages/babylon-lite/src/material/pbr/fragments/vat-fragment.ts    # pbrExt + 2 vertex variants (non-instanced / instanced dual-clip)
packages/babylon-lite/src/animation/types.ts                        # VatData (internal)
packages/babylon-lite/src/material/mesh-features.ts                 # MSH_VAT (the only VAT feature bit; instanced derived from MSH_HAS_THIN_INSTANCES)
packages/babylon-lite/src/mesh/mesh.ts                              # mesh.vat field
packages/babylon-lite/src/index.ts                                  # exports bakeVat, attachVat, VatBakeResult, VatClip, VatHandle
lab/lite/scene218.html + src/lite/scene218.ts                       # single-mesh VAT parity scene
lab/lite/scene219.html + src/lite/scene219.ts                       # instanced + blended + shadowed crowd (dev)
tests/lite/parity/scenes/scene218-vat.spec.ts                       # parity test
```
