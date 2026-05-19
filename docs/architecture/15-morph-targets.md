# Module: Morph Targets (Blend Shapes)
> Package path: `packages/babylon-lite/src/` (cross-cutting: loader, animation, material)

## Purpose

Morph targets (aka blend shapes) allow per-vertex position and normal deltas to deform a mesh at runtime, driven by weight values from glTF animations. Used for facial animation, mouth shapes, and other fine-grained mesh deformation. Weights are evaluated per-frame from glTF animation channels and uploaded to a uniform buffer; the vertex shader blends morph deltas before skeletal deformation.

---

## Public API Surface

### Interfaces

```typescript
/** Morph binding — links a node to its morph target weights buffer. */
export interface MorphBinding {
  nodeIdx: number;          // glTF node index this binding belongs to
  targetCount: number;      // number of morph targets (max 4)
  weightsBuffer: GPUBuffer; // 32-byte UBO: vec4<f32> weights + u32 count + u32 texWidth + u32 rowsPerBand + u32 pad
}
```

### Data on Existing Types

```typescript
// GltfAnimationData (animation/types.ts) — extended with:
export interface GltfAnimationData {
  // ...existing fields...
  morphBindings: MorphBinding[];  // alongside skeletons
}

// MeshGPU (mesh/mesh.ts) — extended with morph fields:
interface MeshGPU {
  // ...existing fields...
  morphTexture?: GPUTexture;       // rgba32float tiled texture with all deltas
  morphTextureView?: GPUTextureView;
  morphWeightsBuffer?: GPUBuffer;  // 32-byte UBO
  morphTargetCount?: number;
}
```

### Feature Flag

```typescript
// mesh-features.ts
export const MSH_HAS_MORPH_TARGETS = 1 << 3;
```

---

## Internal Architecture

### Data Flow

```
glTF file
  ↓
load-gltf.ts: parse primitive.targets[]
  ├── Each target has POSITION + NORMAL accessors → Float32Array deltas
  ├── Initial weights from mesh.weights[]
  ├── Pack all deltas into a single rgba32float 2D texture (tiled layout)
  └── Create 32-byte weights UBO with initial values
  ↓
MeshGPU.morphTexture + MeshGPU.morphWeightsBuffer
  ↓
skeleton-updater.ts: per-frame PATH_WEIGHTS evaluation
  └── Writes to first 16 bytes of weights UBO (vec4 weights)
  ↓
pbr-shader.ts: vertex shader blends deltas before skeletal deformation
```

### Tiled Texture Layout

The morph texture uses a 2D tiled layout to handle meshes with more vertices than the WebGPU max texture dimension (8192 default):

| Parameter | Formula |
|---|---|
| `texWidth` | `min(vertexCount, 2048)` |
| `rowsPerBand` | `ceil(vertexCount / texWidth)` |
| Band order | target0-position, target0-normal, target1-position, target1-normal, ... |
| Total height | `numTargets × 2 × rowsPerBand` |
| Vertex lookup | `col = v % texWidth`, `row = bandBase + floor(v / texWidth)` |

GPU format: `rgba32float`, unfilterable-float sample type (same approach as the bone texture).

### Weights UBO Layout — 32 bytes

| Offset (bytes) | Size | Content |
|---|---|---|
| 0 | 16B | `vec4<f32> weights` — morph target weights (max 4) |
| 16 | 4B | `u32 count` — number of active morph targets |
| 20 | 4B | `u32 texWidth` — texture row width in texels |
| 24 | 4B | `u32 rowsPerBand` — rows per (target, attribute) band |
| 28 | 4B | `u32 pad` — padding to 32-byte alignment |

Per-frame updates write only the first 16 bytes (weights). The `count`, `texWidth`, and `rowsPerBand` fields are immutable after creation.

---

## Pipeline Configuration

### Feature Flag Effects (`MSH_HAS_MORPH_TARGETS = 1 << 3`)

When the flag is set:

1. **Shader composition** — Adds morph struct definition, morph texture binding, and blending code to the vertex shader.
2. **Bind group layout** — Adds morph texture entry (unfilterable-float, 2d) and morph weights UBO entry to the per-mesh bind group layout.
3. **Bind group creation** — Adds morph texture view and morph weights buffer to the per-mesh bind group.

### Bind Group Integration (Group 1 — Per-Mesh)

| Binding | Resource | Condition |
|---|---|---|
| 0 | Mesh UBO | Always |
| 1 | Bone texture | If skeleton |
| 2 | Morph texture | If morph targets |
| 3 | Morph weights UBO | If morph targets |
| 4+ | Material textures | Follow |

Exact binding slot indices shift depending on which optional entries are present.

---

## Shader Logic

### WGSL Morph Struct

```wgsl
struct MorphUniforms {
  weights: vec4<f32>,
  count: u32,
  texWidth: u32,
  rowsPerBand: u32,
  pad: u32,
};
```

### Vertex Shader Morph Blending

Applied **before** skeletal deformation:

```wgsl
var morphedPos = position;
var morphedNorm = normal;
let vid = vertexIndex;  // @builtin(vertex_index) — returns index buffer value
let col = i32(vid % morph.texWidth);
let rowInBand = i32(vid / morph.texWidth);
for (var i = 0u; i < morph.count; i = i + 1u) {
    let w = morph.weights[i];
    let posRow = i32(i * 2u) * i32(morph.rowsPerBand) + rowInBand;
    let normRow = i32(i * 2u + 1u) * i32(morph.rowsPerBand) + rowInBand;
    morphedPos += w * textureLoad(morphTargets, vec2<i32>(col, posRow), 0).xyz;
    morphedNorm += w * textureLoad(morphTargets, vec2<i32>(col, normRow), 0).xyz;
}
// Then proceed with skeletal deformation on morphedPos / morphedNorm
```

**Key detail**: `@builtin(vertex_index)` returns the index buffer value for indexed draws, so `vid` correctly maps to the per-vertex morph delta stored in the texture.

---

## State Machine / Lifecycle

### Initialization (in `load-gltf.ts`)

1. Parse `primitive.targets[]` — each target has POSITION and NORMAL accessors
2. Read initial weights from `mesh.weights[]` (default all zeros)
3. Compute tiled layout: `texWidth`, `rowsPerBand`, total height
4. Allocate `rgba32float` 2D texture (`texWidth × totalHeight`)
5. Fill texture row-by-row: for each target, write position band then normal band
6. Create 32-byte weights UBO, write initial weights + immutable layout params
7. Store on `MeshGPU`: `morphTexture`, `morphTextureView`, `morphWeightsBuffer`, `morphTargetCount`
8. Create `MorphBinding` entries for animation system

### Per-Frame (in `skeleton-updater.ts`)

```
For each PATH_WEIGHTS animation channel:
  1. Evaluate weight sampler at current time → vec4 weights
  2. Look up MorphBinding[] by nodeIdx
  3. Write first 16 bytes of weightsBuffer (vec4 weights only)
```

### Rendering (in `pbr-shader.ts` vertex stage)

```
1. Read morphedPos = base position
2. Read morphedNorm = base normal
3. For each active morph target (i < count):
   a. Compute texture coordinates from vertex_index + tiled layout
   b. textureLoad position delta, accumulate weighted
   c. textureLoad normal delta, accumulate weighted
4. Pass morphedPos/morphedNorm to skeletal deformation (if any)
5. Continue with standard vertex transform
```

---

## Babylon.js Equivalence Map

| Babylon Lite | Babylon.js |
|---|---|
| `MorphBinding` interface | `MorphTargetManager` class |
| `morphTexture` (rgba32float tiled) | `MorphTargetManager._textureFloat` |
| `morphWeightsBuffer` (32B UBO) | `MorphTargetManager._influences` uniform |
| Vertex shader `textureLoad` loop | `morphTargets.vertex.fx` shader include |
| `MSH_HAS_MORPH_TARGETS` flag | `#define MORPHTARGETS` in shader defines |
| PATH_WEIGHTS in `skeleton-updater.ts` | `Animation.AllowMatricesInterpolation` + `MorphTargetManager.getTarget().influence` |
| Max 4 targets (vec4 weights) | Configurable via `MorphTargetManager.numTargets` |
| Flat data + functions | Full class hierarchy (`MorphTarget`, `MorphTargetManager`) |

**Same math, minimal code.** No class hierarchy — just a texture, a UBO, and a shader loop.

---

## Dependencies

- WebGPU `rgba32float` texture support (unfilterable-float)
- `@builtin(vertex_index)` in WGSL (returns index buffer value for indexed draws)
- Existing bone texture pattern (same unfilterable-float approach, same bind group slot strategy)
- glTF 2.0 morph target specification (`primitive.targets[]`, `mesh.weights[]`)

---

## Test Specification

| Test | Description |
|---|---|
| Tiled layout math | `vertexCount=5000, texWidth=2048, rowsPerBand=3` — verify dimensions |
| Texture dimensions | 2 targets, 5000 verts → width=2048, height=2×2×3=12 |
| Vertex lookup | Vertex 4097 → col=1, rowInBand=2 (for texWidth=2048) |
| Band ordering | Target 1 normal band starts at row `(1×2+1)×rowsPerBand` |
| UBO layout | Total 32 bytes: 16B weights + 4B count + 4B texWidth + 4B rowsPerBand + 4B pad |
| Initial weights | `mesh.weights = [0.5, 0.3]` → UBO bytes 0–15 contain `[0.5, 0.3, 0, 0]` |
| Immutable fields | Per-frame update writes only first 16 bytes, not count/texWidth/rowsPerBand |
| Feature flag | `MSH_HAS_MORPH_TARGETS = 1 << 3 = 8` |
| Morph-only animation | Animation with PATH_WEIGHTS but no skeleton plays correctly |
| Max targets | More than 4 targets in glTF → only first 4 used |

---

## File Manifest

| File | Role |
|---|---|
| `src/animation/types.ts` | `MorphBinding` interface definition |
| `src/mesh/mesh.ts` | `MeshGPU` morph fields (`morphTexture`, `morphWeightsBuffer`, etc.) |
| `src/loader-gltf/load-gltf.ts` | Parse `primitive.targets[]`, create tiled texture + weights UBO |
| `src/animation/skeleton-updater.ts` | PATH_WEIGHTS evaluation, per-frame weight upload |
| `src/animation/animation-group.ts` | Morph-only animation support (no skeleton required) |
| `src/material/pbr/pbr-shader.ts` | Morph blending in vertex shader, feature flag, WGSL generation |
| `src/material/pbr/pbr-pipeline.ts` | Morph entries in bind group layout and bind group |
| `src/material/pbr/pbr-renderable.ts` | Morph detection and wiring during renderable creation |

---

## Limitations

- **Max 4 morph targets per mesh** — limited by `vec4<f32>` weights in the UBO.
- **POSITION and NORMAL deltas only** — TANGENT deltas from glTF are ignored.
- **PBR pipeline only** — morph targets are not supported in the standard material pipeline.
