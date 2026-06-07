# Module: Shader Material

> Package path: `packages/babylon-lite/src/material/shader/`

## Purpose

The ShaderMaterial module provides Lite's WGSL-only equivalent of Babylon.js `ShaderMaterial`: user-authored vertex and fragment shaders, explicit vertex attribute lists, typed custom uniforms, texture samplers, compile-time defines, and render-state hints such as alpha blending.

This module is intentionally **not** a GLSL compatibility layer. Babylon.js documentation and playgrounds remain useful as reference scenes and API concepts, but Lite accepts WGSL source only. There is no GLSL parser, no GLSL-to-WGSL transpiler, and no `Effect.ShadersStore` global registry in core.

The design follows the Lite material contract:

- A ShaderMaterial is plain data with a material-owned `_buildGroup`.
- The scene never knows about shader-specific details.
- The renderer only binds group 0 and asks renderables to draw.
- The material owns shader source, bind group layouts, pipelines, bind groups, and resource lifetime.
- Structured GPU layout comes from typed options, never by parsing emitted WGSL.

## Public API Surface

### Factory

```typescript
export function createShaderMaterial(options: ShaderMaterialOptions): ShaderMaterial;
```

`createShaderMaterial` is synchronous and accepts already-resolved WGSL source strings.

```typescript
export interface ShaderMaterialOptions {
    readonly name?: string;
    readonly vertexSource: string;
    readonly fragmentSource: string;
    readonly attributes: readonly ShaderAttributeName[];
    readonly uniforms?: readonly ShaderUniformOption[];
    readonly samplers?: readonly ShaderSamplerOption[];
    readonly defines?: ShaderDefineMap;
    readonly needAlphaBlending?: boolean;
    readonly needAlphaTesting?: boolean;
    readonly backFaceCulling?: boolean;
    readonly depthWrite?: boolean;
    readonly depthCompare?: GPUCompareFunction;
}
```

Supported Babylon route forms:

| Babylon route form | Lite phase 1 handling |
| --- | --- |
| `{ vertexSource, fragmentSource }` | Supported, but source strings must be WGSL. |
| `{ vertex, fragment }` with `Effect.ShadersStore` | Not supported in core; global shader stores violate Lite's no-side-effect rule. |
| `{ vertexElement, fragmentElement }` | Not supported in core. Callers may read DOM text and pass WGSL strings explicitly. |
| `"./COMMON_NAME"` external `.fx` files | Not supported in core. A future helper may fetch WGSL explicitly, but the material factory stays synchronous. |

### Material type

```typescript
export interface ShaderMaterial extends Material {
    readonly name?: string;
    readonly vertexSource: string;
    readonly fragmentSource: string;
    readonly attributes: readonly ShaderAttributeName[];
    readonly uniformDecls: readonly ShaderUniformDecl[];
    readonly samplerDecls: readonly ShaderSamplerDecl[];
    readonly defines: readonly ShaderDefine[];
    readonly needAlphaBlending: boolean;
    readonly needAlphaTesting: boolean;
    readonly backFaceCulling: boolean;
    readonly depthWrite: boolean;
    readonly depthCompare: GPUCompareFunction;
    _uniformValues: Map<string, ShaderUniformSlot>;
    _textureSlots: Map<string, ShaderTextureSlot>;
    _uniformVersion: number;
    _resourceVersion: number;
}
```

`_uboVersion` from the base `Material` mirrors `_uniformVersion` for compatibility with existing dirty tracking. `_resourceVersion` is separate because texture/sampler changes require bind group rebuilds, not just UBO writes.

### Attributes

```typescript
export type ShaderAttributeName = "position" | "normal" | "uv" | "uv2" | "tangent" | "color";
```

The order in `options.attributes` is the vertex buffer binding order and the WGSL `@location` order. Unsupported names throw during material creation. Missing optional mesh buffers use zero-filled buffers, matching NodeMaterial behavior. `position` is required for normal mesh rendering.

### Thin instances and GPU culling

A ShaderMaterial mesh can be hardware-instanced via the standard thin-instance API (`setThinInstances`, `setThinInstanceColors`, `enableThinInstanceGpuCulling` — see `17-thin-instances.md`). No new ShaderMaterial option is required: when a mesh has `thinInstances`, the renderer builds a per-mesh **instance pipeline variant** and auto-injects extra attributes into the generated `VertexInput` struct, appended after the declared attributes (so at `@location(attributes.length)` onward):

```wgsl
@location(N)   world0: vec4<f32>,   // instance world matrix columns
@location(N+1) world1: vec4<f32>,
@location(N+2) world2: vec4<f32>,
@location(N+3) world3: vec4<f32>,
@location(N+4) instanceColor: vec4<f32>,   // only when setThinInstanceColors() was called
```

The user shader composes the instance transform itself (matching Babylon.js `instancesVertex`):

```wgsl
let iw = mat4x4<f32>(input.world0, input.world1, input.world2, input.world3);
out.position = shaderSystem.viewProjection * (shaderSystem.world * iw) * vec4<f32>(input.position, 1.0);
// out.vColor = input.instanceColor;  // when instance colors are present
```

The `world` system uniform stays the **mesh** world matrix; for thin instances the effective world is `world * iw`. The baked `worldViewProjection` / `worldView` system uniforms are **not** instance-aware — instanced shaders must use `viewProjection` (+ `world`) and compose with `iw` themselves.

Implementation notes (bundle discipline):

- The instance vertex-buffer layouts, the prelude attribute lines, and the per-mesh instanced renderable live in `material/shader/shader-thin-instance.ts`, **dynamically imported** via `shader-group-builder.ts` → `buildShaderGroup` only when `meshes.some(m => m.thinInstances)`. Non-instanced ShaderMaterial scenes route through the unchanged synchronous `buildShaderMaterialRenderables`.
- The expensive bindings (`group1BGL`, `systemSpec`, `customSpec`) are shared between the non-instanced and instanced variants — instancing is vertex data, not bind groups. Only the vertex buffer layouts and the `VertexInput` struct differ, so `getOrCreateShaderPipeline()` keys instanced pipelines on a variant suffix (`|ti1c{0|1}`).
- Instanced ShaderMaterial meshes render as **one `_direct` renderable per mesh** (not merged), so per-mesh instance buffers are re-bound fresh each frame (avoiding stale render-bundle references when instance capacity grows).
- **Opt-in GPU frustum culling** is wired via the shared `mesh/thin-instance-cull-binding.ts` helper (same as Standard/PBR): when `enableThinInstanceGpuCulling(mesh)` is set, the compute cull pass runs in the binding `update()` and the draw becomes `drawIndexedIndirect`. Opaque instanced ShaderMaterial only; transparent instanced meshes use the normal (non-culled) instanced draw.

### Uniform declarations

```typescript
export type ShaderUniformType = "f32" | "u32" | "i32" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>" | "mat4x4<f32>";

export type ShaderSystemUniformName =
    | "world"
    | "view"
    | "projection"
    | "viewProjection"
    | "worldView"
    | "worldViewProjection"
    | "cameraPosition"
    | "screenSize"
    | "alphaCutoff";

export type ShaderUniformOption = ShaderSystemUniformName | ShaderUniformDecl;

export interface ShaderUniformDecl {
    readonly name: string;
    readonly type: ShaderUniformType;
    readonly defaultValue?: number | readonly number[];
}
```

String uniforms are only accepted for known Babylon-style system uniforms. Custom uniforms must include a type. This keeps the Babylon `uniforms: ["worldViewProjection", "time"]` concept where safe, while rejecting ambiguous custom strings like `"time"` unless the caller provides `{ name: "time", type: "f32" }`.

### Sampler declarations

```typescript
export type ShaderSamplerOption = string | ShaderSamplerDecl;

export interface ShaderSamplerDecl {
    readonly name: string;
    readonly sampleType?: "float" | "unfilterable-float" | "depth";
}
```

Each sampler name maps to a pair of WGSL bindings:

```wgsl
@group(1) @binding(N) var textureSampler: texture_2d<f32>;
@group(1) @binding(N + 1) var textureSamplerSampler: sampler;
```

Depth samplers use `texture_depth_2d` and a filtering sampler is not assumed. Public APIs accept `Texture2D` only, never raw GPU handles.

### Defines

```typescript
export type ShaderDefineValue = boolean | number;
export type ShaderDefineMap = Readonly<Record<string, ShaderDefineValue>>;

export interface ShaderDefine {
    readonly name: string;
    readonly value: ShaderDefineValue;
}
```

WGSL has no preprocessor. Lite converts defines to const declarations in the generated prelude:

```wgsl
const MyDefine: bool = true;
const Scale: f32 = 2.0;
```

The normalized define set is part of the pipeline cache key. Callers write ordinary WGSL `if (MyDefine) { ... }`; the WGSL compiler can constant-fold the branch. `#define`, `#ifdef`, and string macro replacement are not supported.

### Setters

```typescript
export type ShaderUniformValue = number | readonly number[] | Float32Array;

export function setShaderUniform(material: ShaderMaterial, name: string, value: ShaderUniformValue): void;
export function setShaderTexture(material: ShaderMaterial, name: string, texture: Texture2D | null): void;
```

`setShaderUniform` validates that the name exists, the declared type is custom or settable, and the supplied float count matches the declaration. It increments `_uniformVersion` and `_uboVersion`.

`setShaderTexture` validates that the sampler exists, stores the `Texture2D | null`, and increments `_resourceVersion`. The renderable rebuilds the group-1 bind group when the resource version changes.

Convenience wrappers may be added if they stay small and tree-shakable:

```typescript
export function setShaderFloat(material: ShaderMaterial, name: string, value: number): void;
export function setShaderVector3(material: ShaderMaterial, name: string, value: readonly [number, number, number]): void;
export function setShaderMatrix(material: ShaderMaterial, name: string, value: Float32Array): void;
```

The core implementation should route all wrappers through `setShaderUniform`.

## WGSL Authoring Contract

User WGSL must define complete vertex and fragment entry points. Lite does not rewrite entry point bodies.

Recommended entry point names are `mainVertex` and `mainFragment`, but options may later expose entry point names if needed. Phase 1 can require:

```wgsl
@vertex
fn mainVertex(input: VertexInput) -> VertexOutput { ... }

@fragment
fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> { ... }
```

Lite prepends a generated prelude before user source:

1. `SceneUniforms` from the shared scene group (`@group(0) @binding(0)`).
2. `ShaderSystemUniforms` for requested per-mesh system values (`@group(1) @binding(0)`).
3. Optional `ShaderUniforms` for custom uniforms (`@group(1) @binding(1)`).
4. Texture/sampler declarations for `options.samplers`.
5. WGSL const declarations for `options.defines`.
6. `VertexInput` generated from `options.attributes`.

User WGSL must not declare:

- `@group(0)` bindings.
- `@group(1)` bindings using names generated by the material.
- `struct VertexInput` unless an option explicitly opts out of generated input.
- Duplicate uniform, sampler, or define identifiers.

Generated names intentionally match the names listed in the options where possible:

- System matrix fields are available as `shaderSystem.world`, `shaderSystem.worldViewProjection`, etc.
- Custom uniforms are available as `shaderUniforms.time`, `shaderUniforms.direction`, etc.
- Texture samplers are available as `<name>` and `<name>Sampler`.
- Scene fields remain available through `scene.viewProjection`, `scene.view`, `scene.vEyePosition`, etc.

## Internal Architecture

### File manifest

```text
packages/babylon-lite/src/material/shader/
  shader-material.ts       Public types, factory, setters, validation.
  shader-group-builder.ts  MeshGroupBuilder entry point and lazy renderable import.
  shader-renderable.ts     Per-scene/per-mesh renderables, UBO writes, bind groups.
  shader-pipeline.ts       Generated prelude, BGL creation, pipeline cache.
```

### Group builder

Every material returned by `createShaderMaterial` sets `_buildGroup` to `shaderGroupBuilder`.

```typescript
export const shaderGroupBuilder: MeshGroupBuilder = async (scene, meshes) => {
    const { buildShaderMaterialRenderables } = await import("./shader-renderable.js");
    const result = buildShaderMaterialRenderables(scene, meshes);
    shaderGroupBuilder._rebuildSingle = result.rebuildSingle;
    return result;
};
```

The group builder has no module-level registry and imports renderable code only when a scene actually uses ShaderMaterial.

### Per-material grouping

`buildShaderMaterialRenderables(scene, meshes)` groups meshes by `ShaderMaterial` instance. Each material instance owns:

- Normalized source strings.
- Normalized attributes.
- Normalized uniform/sampler/define declarations.
- Pipeline variant cache for target signatures.
- One custom UBO per material if custom uniforms exist.
- Per-texture slots and resource version.

Opaque ShaderMaterials may batch multiple meshes under one renderable if they share one material instance and target pipeline. Transparent ShaderMaterials should emit one renderable per mesh so frame-graph sorting can use each mesh world center.

### Pipeline cache

Cache scope is per material instance, not module-level. Cross-material pipeline sharing is a non-goal for phase 1 because module-level `Map` allocations violate Lite's tree-shaking guidance. A future device-owned cache may be added if profiling proves it necessary.

The cache key includes:

- Vertex WGSL source.
- Fragment WGSL source.
- Generated prelude key.
- Attribute list/order.
- Uniform layout.
- Sampler layout.
- Define set.
- Alpha/depth/cull state.
- Render target signature: color format, depth/stencil format, sample count, flipY.

### Bind group layout

The pipeline layout is:

| Group | Owner | Bindings |
| --- | --- | --- |
| 0 | Frame graph render task | `SceneUniforms`, scene lights UBO |
| 1 | ShaderMaterial | system UBO, optional custom UBO, textures, samplers |

Group 1 binding order:

1. `ShaderSystemUniforms` at binding 0. Always present so the layout is stable.
2. `ShaderUniforms` at binding 1 if custom uniform declarations exist.
3. Texture/sampler pairs in declaration order.

### UBO layout

Use `computeUboLayout()` from `src/shader/ubo-layout.ts`. Do not split WGSL strings or parse user shader source.

`ShaderSystemUniforms` contains only requested per-mesh values:

| Uniform | Type | Source |
| --- | --- | --- |
| `world` | `mat4x4<f32>` | `mesh.worldMatrix` |
| `worldView` | `mat4x4<f32>` | `view * world` in Lite matrix convention |
| `worldViewProjection` | `mat4x4<f32>` | `scene.viewProjection * world` in Lite matrix convention |
| `projection` | `mat4x4<f32>` | active pass camera projection |
| `screenSize` | `vec2<f32>` | active pass target width/height |
| `alphaCutoff` | `f32` | material/system value, default `0.4` |

Scene-level values should be aliased or read from group 0 rather than copied per mesh when possible:

| Uniform | Preferred source |
| --- | --- |
| `view` | `scene.view` |
| `viewProjection` | `scene.viewProjection` |
| `cameraPosition` | `scene.vEyePosition.xyz` |

If a caller requests the Babylon-style `viewProjection` string, the generated prelude may expose an alias function or const-like local expression in helper code, but it should not allocate a duplicate per-mesh UBO slot.

### Matrix convention

Lite's camera helper computes `viewProjection` as `projection * view`, and material templates currently multiply clip positions by `scene.viewProjection * worldPosition` according to existing engine conventions. ShaderMaterial must use the same convention so it matches Standard, PBR, and NodeMaterial.

## Pipeline Configuration

Defaults match normal Lite mesh rendering:

```typescript
primitive.topology = "triangle-list";
primitive.frontFace = target.flipY ? "cw" : "ccw";
primitive.cullMode = options.backFaceCulling === false ? "none" : "back";
depthStencil.format = target.depthStencilFormat ?? "depth24plus-stencil8";
depthStencil.depthCompare = options.depthCompare ?? "greater-equal";
depthStencil.depthWriteEnabled = options.needAlphaBlending ? false : (options.depthWrite ?? true);
multisample.count = target.sampleCount;
```

Alpha blending:

```typescript
if (needAlphaBlending) {
    blend.color = { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" };
    blend.alpha = { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" };
}
```

Alpha testing:

- `needAlphaTesting` does not auto-inject fragment code.
- The shader must explicitly call `discard`.
- If the shader wants an engine-provided cutoff value, it lists `"alphaCutoff"` in `uniforms` and reads `shaderSystem.alphaCutoff`.

## Shader Logic Outline

The simplest WGSL equivalent of the Babylon docs' basic ShaderMaterial:

```wgsl
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
    return out;
}

@fragment
fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
```

The texture sampler equivalent:

```wgsl
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
    out.uv = input.uv;
    return out;
}

@fragment
fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(textureSampler, textureSamplerSampler, input.uv);
}
```

## State Machine / Lifecycle

1. User calls `createShaderMaterial(options)`.
2. Factory validates attributes, normalizes uniform/sampler/define declarations, creates value slots, and attaches `_buildGroup`.
3. User assigns the material to meshes and adds them to the scene.
4. `registerScene` runs deferred builders; `shaderGroupBuilder` dynamically imports `shader-renderable.ts`.
5. Renderable builder groups meshes by material instance.
6. For each material, `shader-pipeline.ts` builds a generated prelude, shader module, group-1 BGL, and render pipeline for the active target signature.
7. For each mesh, the renderable creates a system UBO and group-1 bind group.
8. Each frame, `DrawBinding.update(context)` refreshes system UBOs when world/camera/target data changes and custom UBOs when `_uboVersion` changes.
9. Draw binds vertex buffers in material attribute order, sets index buffer, sets group 1, and calls `drawIndexed`.
10. If `setShaderTexture` changes a texture, the next update recreates group 1 for affected mesh packets and updates acquired/released texture references.
11. Material swaps use `shaderGroupBuilder._rebuildSingle`, matching Standard/PBR.

## Babylon.js Equivalence Map

| Babylon ShaderMaterial concept | Lite ShaderMaterial equivalent |
| --- | --- |
| `new ShaderMaterial(name, scene, route, options)` | `createShaderMaterial({ name, vertexSource, fragmentSource, ...options })` |
| `scene` constructor argument | Not accepted; scene owns meshes/materials via `addToScene` |
| GLSL shader source | Not supported |
| WGSL shader source | Supported |
| `attributes: ["position", "normal", "uv"]` | Same names, validated against Lite supported attributes |
| `uniforms: ["worldViewProjection"]` | Same for known system uniforms |
| Custom `uniforms: ["time"]` | Use `{ name: "time", type: "f32" }` |
| `samplers: ["textureSampler"]` | Same name, bound with `setShaderTexture` |
| `defines: ["MyDefine"]` | `defines: { MyDefine: true }`, emitted as WGSL const |
| `setFloat`, `setVector3`, `setTexture` methods | `setShaderUniform`, `setShaderTexture` standalone functions |
| `needAlphaBlending` | Transparent renderable + blend pipeline |
| `needAlphaTesting` | Hint only; shader performs discard |

## Dependencies

- `material/material.ts` for base `Material`.
- `render/renderable.ts` for `MeshGroupBuilder`, `Renderable`, `DrawBinding`.
- `render/scene-helpers.ts` for scene bind group layout and default pipeline descriptor.
- `shader/scene-uniforms.ts` for shared scene UBO WGSL.
- `shader/ubo-layout.ts` for typed UBO packing.
- `texture/texture-2d.ts` for public texture resources.
- `resource/gpu-pool.ts` for texture acquire/release and sampler reuse where appropriate.
- `camera/camera.ts` for active pass view/projection data if a per-mesh system uniform requires projection.

## Test Specification

Use Babylon.js doc playgrounds as BJS reference concepts while keeping Lite source WGSL-only.

| Scene | Reference source | Lite coverage |
| --- | --- | --- |
| ShaderMaterial basic color | Doc playground `#5T8G3I` | Position attribute, `worldViewProjection`, solid fragment color |
| ShaderMaterial texture sampler | Doc playground `#D8IDR8` | `uv` attribute, `Texture2D`, sampler pair, `setShaderTexture` |
| ShaderMaterial uniform update | Doc playground `#5T8G3I#16` | Custom scalar/vector/color uniform mutation through `setShaderUniform` |
| ShaderMaterial defines variant | Derived from doc `defines` option | WGSL const define emitted into prelude and included in pipeline key |
| ShaderMaterial alpha | Lite-authored WGSL reference | `needAlphaBlending` and explicit shader-side discard for alpha testing |

Implementation should add lab scenes using the next available scene IDs, plus parity specs and bundle-size ceilings. The BJS side may use Babylon `ShaderMaterial` with GLSL from the docs; the Lite side must use equivalent WGSL and the new Lite `ShaderMaterial`.

Final agent-allowed validation for implementation:

```powershell
pnpm run lint:fix
pnpm run lint
pnpm test
git diff tests/lite/parity/bundle-size.spec.ts
git diff reference/lite/
```

Do not run `pnpm test:perf`.
