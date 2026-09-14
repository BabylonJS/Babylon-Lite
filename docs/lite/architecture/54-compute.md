# Module: Compute

> Package paths: `packages/babylon-lite/src/compute/`, `packages/babylon-lite/src/frame-graph/compute-pass.ts`, `packages/babylon-lite/src/resource/uniform-buffer.ts`

## Purpose

Expose user-authored WebGPU compute without exposing raw GPU handles or creating a second scheduler outside the frame graph.

The public model separates:

- `ComputeShader`: immutable program, binding layout, pipeline variants, async preparation, and device-relative caches.
- `ComputeBindingSet`: immutable reusable resources for one program.
- `ComputeDispatch`: one direct or indirect invocation plus dynamic offsets.
- `ComputeTask`: an ordered reusable dispatch list and its task-owned per-dispatch uniform arena.
- `ComputePass`: one frame-graph pass that records a task's dispatch list into the engine's current frame encoder.

One `ComputeTask` is one scheduling boundary and one WebGPU compute pass. Applications create multiple tasks only where ordering relative to render, copy, or other compute work requires separate passes.

### GPU-produced mesh contract

`createMeshFromStorageBuffer()` returns an ordinary `Mesh`, not a ShaderMaterial-only
special case. Standard, PBR, Node, Shader, and geometry-renderer passes must therefore
consume the same mesh-owned vertex-layout and draw-origin metadata:

- `MeshGPU._vbLayout` is the authoritative per-stream `arrayStride` and attribute
  offset for position, normal, tangent, UV, UV2, and color. Pipeline layouts encode
  those values; every corresponding slab `GPUBuffer` is bound with byte offset zero.
- `MeshGPU._baseVertex` is the authoritative vertex origin for the slot. Direct
  indexed draws pass it as WebGPU's fourth `drawIndexed` argument. Stable thin-instance
  indirect arguments, GPU-culling arguments, and both near/far LOD buckets write the
  same value into indirect word 3.
- Storage meshes also publish `MeshGPU._vertexCount`: the validated number of vertices in
  their slot, independent of the shared buffer's byte capacity. Missing Shader/Node attributes
  use a shared sixteen-byte zero stream with zero vertex stride, not a slab-sized allocation.
  Zero stride preserves constant defaults even with a nonzero indexed `baseVertex`. Shader
  pipeline/group keys distinguish missing attributes, including skin streams and thin instances.
- The storage-mesh factory validates `baseVertex` as a non-negative signed 32-bit integer before
  calculating the required byte range. `indexCount` must be a positive unsigned 32-bit integer
  within the supplied typed-array length or shared storage capacity. Typed indices determine the
  format; an explicit format must match, and every index in the used prefix must be less than
  `vertexCount`. Shared GPU-produced index contents remain the producer's responsibility.
- The mandatory UV stream publishes `hasUv: true`. `hasUv2`, `hasTangent`, and `hasColor` describe
  the optional streams, so material feature detection and recovery do not infer presence from
  stale handles.
- Standard, PBR, and Node layout rewriting plus direct/indirect indexed-draw argument population
  share `mesh/mesh-vertex-layout.ts`. ShaderMaterial keeps the equivalent logic in its existing
  opt-in `shader-vb.ts` hook, so scenes that use only that material family do not fetch the other
  material families' layout adapter.

Because slab allocations are caller-owned, device-loss recovery re-resolves the shared
storage handle and re-points every advertised vertex stream (including tangent, UV2, and
color), plus a shared index allocation when present. Typed-array indices are instead snapshotted
at construction (only the used prefix). The same source descriptor supplies their count, format,
and upload data during construction and device replacement. Recovery uploads a new owned index
buffer once per shared MeshGPU and device without requiring CPU vertex arrays. Releasing the
last mesh owner removes that descriptor and its exact weak registration token, so disposed chunks
neither accumulate recovery entries nor get resurrected. Dead-reference compaction during recovery
remains a fallback for meshes abandoned without explicit disposal.

Thin-instance GPU culling uses CPU positions when available, otherwise a conservative sphere
around finite, ordered object-local `boundMin`/`boundMax`. Analytic bounds are cached by value so
in-place edits invalidate the sphere without allocating or recomputing it on unchanged frames.
Only meshes lacking either usable representation take the full-draw/disabled-LOD fallback.

## Public API Surface

### Binding declarations

```ts
export interface ComputeBindingDecl {
    readonly name: string;
    readonly group: number;
    readonly binding: number;
}

export interface ComputeStorageBufferBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly access?: "read" | "read-write";
    readonly dynamicOffset?: boolean;
    readonly minBindingSize?: number;
}

export interface ComputeUniformBufferBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly dynamicOffset?: boolean;
    readonly minBindingSize?: number;
}

export function computeStorageBufferBinding(name: string, options: ComputeStorageBufferBindingOptions): ComputeBindingDecl;
export function computeUniformBufferBinding(name: string, options: ComputeUniformBufferBindingOptions): ComputeBindingDecl;

export interface ComputeTextureBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly sampleType?: "float" | "unfilterable-float" | "depth";
    readonly multisampled?: boolean;
}

export interface ComputeSamplerBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly type?: "filtering" | "non-filtering" | "comparison";
}

export interface ComputeStorageTextureBindingOptions {
    readonly group: number;
    readonly binding: number;
    readonly format: GPUTextureFormat;
}

export function computeTextureBinding(name: string, options: ComputeTextureBindingOptions): ComputeBindingDecl;
export function computeSamplerBinding(name: string, options: ComputeSamplerBindingOptions): ComputeBindingDecl;
export function computeStorageTextureBinding(name: string, options: ComputeStorageTextureBindingOptions): ComputeBindingDecl;
```

The caller supplies complete WGSL, including `@group` / `@binding` declarations. Resource-specific helpers return frozen plain declaration data, install their resolver through a tree-shakable optional seam, and provide stable names for resource assignment. Babylon Lite never parses or rewrites the WGSL.

Importing and calling a helper is the opt-in. There are no separate `enableComputeStorageBuffers()` calls.

Declaration invariants are validated once by `createComputeShader`:

- names are unique WGSL identifiers;
- group and binding indices are non-negative integers;
- each `(group, binding)` pair is unique;
- groups are dense from zero through the highest declared group; missing groups receive an empty internal layout;
- `minBindingSize` is a non-negative multiple of four;
- dynamic offsets are legal only for buffer bindings.

### Shader

```ts
export interface ComputeShaderOptions {
    readonly name?: string;
    readonly computeSource: string;
    readonly entryPoint?: string;
    readonly bindings?: readonly ComputeBindingDecl[];
}

export interface ComputeShader {
    readonly name: string;
}

export function createComputeShader(engine: EngineContext, options: ComputeShaderOptions): ComputeShader;
export function prepareComputeShader(shader: ComputeShader): Promise<void>;
export function disposeComputeShader(shader: ComputeShader): void;
```

`ComputeShader` owns no bound resource and no dispatch parameters. It may be shared by any number of binding sets, dispatches, and tasks belonging to its engine.

`prepareComputeShader` prepares the default pipeline. Override constants live in the separate `compute-pipeline-variant` module and are retained only by scenes that create a variant.

### Uniform buffer

```ts
export interface UniformBuffer {
    readonly byteLength: number;
}

export interface UniformBufferOptions {
    readonly label?: string;
}

export function createUniformBuffer(engine: EngineContext, source: ArrayBufferView | number, options?: UniformBufferOptions): UniformBuffer;
export function updateUniformBuffer(engine: EngineContext, buffer: UniformBuffer, data: ArrayBufferView, byteOffset?: number): void;
export function disposeUniformBuffer(buffer: UniformBuffer): void;
```

`UniformBuffer` is an opaque stable-identity wrapper around a `UNIFORM | COPY_DST` allocation. It retains CPU staging bytes for partial updates and uniform arenas. Updates require four-byte-aligned offsets and lengths and stay within `byteLength`.

Construction requires a non-negative safe integer byte count. The minimum sixteen-byte,
sixteen-byte-aligned capacity must remain a safe integer and fit `maxBufferSize` before any
CPU shadow or GPU allocation is created. Uniform arenas validate positive safe-integer slot
sizes/counts and their aligned-stride product before calling this constructor. An arena can exceed
`maxUniformBufferBindingSize`: that limit applies to each bound range, not the entire allocation.

Raw byte-range updates remain the base resource API. Task-owned typed uniform writers are an optional compute module layered on uniform arenas; they do not attach methods to `UniformBuffer` or move ownership into `ComputeShader`.

### Texture resources

```ts
export interface ComputeTextureResource {
    readonly texture: Texture2D;
    readonly sampleType: "float" | "unfilterable-float" | "depth" | "sint" | "uint";
    readonly multisampled: boolean;
    readonly viewDimension: GPUTextureViewDimension;
}

export function createComputeTextureResource(
    engine: EngineContext,
    texture: Texture2D,
    options?: {
        sampleType?: ComputeTextureResource["sampleType"];
    }
): Promise<ComputeTextureResource>;

export function invalidateComputeTextureResource(resource: ComputeTextureResource): void;

export function createComputeTextureViewResource(
    engine: EngineContext,
    texture: Texture2D,
    options: {
        viewDimension: GPUTextureViewDimension;
        sampleType?: ComputeTextureResource["sampleType"];
        multisampled?: boolean;
    }
): Promise<ComputeTextureResource>;

export function computeTextureViewBinding(
    name: string,
    options: ComputeTextureBindingOptions & {
        readonly viewDimension: GPUTextureViewDimension;
    }
): ComputeBindingDecl;

export interface ComputeSampler {
    readonly type: "filtering" | "non-filtering" | "comparison";
}

export function createComputeSampler(engine: EngineContext, descriptor?: GPUSamplerDescriptor): ComputeSampler;

export interface ComputeStorageTexture2D {
    readonly width: number;
    readonly height: number;
    readonly format: "rgba8unorm" | "rgba8snorm" | "rgba16float" | "r32float" | "rgba32float";
    readonly sampledTexture: Texture2D;
    readonly computeTexture: ComputeTextureResource;
    readonly computeSampler: ComputeSampler;
}

export function createComputeStorageTexture2D(
    engine: EngineContext,
    options: {
        width: number;
        height: number;
        format: "rgba8unorm" | "rgba8snorm" | "rgba16float" | "r32float" | "rgba32float";
        label?: string;
    }
): ComputeStorageTexture2D;

export function disposeComputeStorageTexture2D(resource: ComputeStorageTexture2D): void;
export function cloneComputeStorageTexture2D(
    resource: ComputeStorageTexture2D,
    transform: Partial<Pick<Texture2D, "uScale" | "vScale" | "uOffset" | "vOffset" | "uAng">>
): Texture2D;

export interface ComputeStorageTexture {
    readonly width: number;
    readonly height: number;
    readonly depthOrArrayLayers: number;
    readonly viewDimension: "1d" | "2d" | "2d-array" | "3d";
    readonly format: GPUTextureFormat;
    readonly accesses: readonly GPUStorageTextureAccess[];
    readonly sampledTexture: Texture2D | null;
    readonly computeTexture: ComputeTextureResource | null;
    readonly computeSampler: ComputeSampler | null;
}

export interface ComputeStorageTextureOptions {
    readonly width: number;
    readonly height?: number;
    readonly depthOrArrayLayers?: number;
    readonly viewDimension: ComputeStorageTexture["viewDimension"];
    readonly format: GPUTextureFormat;
    readonly access?: GPUStorageTextureAccess | readonly GPUStorageTextureAccess[];
    readonly sampled?: boolean;
    readonly sampler?: GPUSamplerDescriptor;
    readonly mipMaps?: boolean;
    readonly label?: string;
    readonly invertY?: boolean;
}

export function createComputeStorageTexture(engine: EngineContext, options: ComputeStorageTextureOptions): Promise<ComputeStorageTexture>;
export function disposeComputeStorageTexture(resource: ComputeStorageTexture): void;
export function computeStorageTextureViewBinding(
    name: string,
    options: {
        readonly group: number;
        readonly binding: number;
        readonly format: GPUTextureFormat;
        readonly access: GPUStorageTextureAccess;
        readonly viewDimension: ComputeStorageTexture["viewDimension"];
    }
): ComputeBindingDecl;
```

`createComputeTextureResource` validates an existing 2D `Texture2D` through a temporary WebGPU validation error scope, so wrong-device views are rejected without adding ownership metadata to ordinary texture wrappers. It derives float/depth/integer sample compatibility from the real GPU format. Full or stencil-only depth-stencil views are rejected, while a wrapper explicitly exposing a depth-only view is accepted and validated by WebGPU. Array and 3D views use the dedicated advanced helper. `invalidateComputeTextureResource` is required only when an application replaces that wrapper's `view` on the same device.

`createComputeTextureViewResource` and `computeTextureViewBinding` are the advanced opt-in path for `1d`, `2d-array`, `cube`, `cube-array`, and `3d` views. The ordinary 2D helpers do not import them. The resource helper validates the caller-selected view dimension and multisampling through a temporary bind group; Babylon Lite never exposes the underlying GPU view.

Color and depth attachments returned by `createRenderTargetTexture` may be adapted independently. This supports render → compute → present pipelines without making render targets storage-writable: compute samples the rendered color and depth, writes a separate `ComputeStorageTexture2D`, and a later render/effect task presents that output.

`ComputeSampler` owns its sampler outside the shared render sampler cache, keeping comparison/LOD semantics compute-local.

`ComputeStorageTexture2D` owns an empty `STORAGE_BINDING | TEXTURE_BINDING | COPY_SRC | COPY_DST` texture, compute texture/sampler resources, and a stable render-facing `Texture2D` facade. A compute pass binds the resource itself for storage writes; later compute passes use `computeTexture` plus `computeSampler`, while render materials use `sampledTexture`.

`createComputeStorageTexture2D` remains the compact synchronous path for write-only, sampleable 2D output. The advanced asynchronous `createComputeStorageTexture` validates arbitrary storage-capable formats, `1d` / `2d` / `2d-array` / `3d` dimensions, and every requested `write-only` / `read-only` / `read-write` access mode through WebGPU error scopes. Its optional sampler descriptor configures both the render-facing sampled facade and the compute sampler while preserving one stable sampler identity. The separate `computeStorageTextureViewBinding` module opts a shader into those advanced declarations. Formats or access modes gated by WebGPU features must be requested before engine creation through `EngineOptions.requiredFeatures` (for example `bgra8unorm-storage`, `texture-formats-tier1`, or `texture-formats-tier2`). Unsupported features reject during engine creation; unsupported format, dimension, or access combinations reject during resource creation rather than failing later during dispatch.

`mipMaps: true` allocates the complete legal mip chain for 2D, array, and 3D textures.
The combination with `viewDimension: "1d"` is rejected before allocation, including width one.
Mip allocation does not imply render-target usage: `RENDER_ATTACHMENT` is added only for
sampled 2D `rgba8unorm` and `rgba16float` outputs, plus `rgba8snorm` when the device has
`texture-formats-tier1`. Callers request that feature explicitly through `requiredFeatures`;
it is not enabled opportunistically. Other formats/dimensions, or a missing required feature,
retain their mip chains without render-attachment usage, and the render mip task rejects them
deterministically.
`createComputeStorageTextureMipmapsTask`
prepares reusable views, bind groups, and pass descriptors once, then regenerates supported
filterable-float 2D chains inside the frame graph without per-frame WebGPU object creation.

The advanced resource accepts any storage-capable format enabled on the engine's device. Optional WebGPU format tiers remain device capabilities rather than compute-module code; unsupported formats reject during the resource's validation scope.

Storage-texture creation resolves the sample type once from the format and enabled device
features. `r32float`, `rg32float`, and `rgba32float` use `float` when `float32-filterable` is
enabled, otherwise `unfilterable-float`. Filtering samplers are rejected for unfilterable
float and integer outputs; comparison samplers require depth textures. Nearest filtering
remains the default, including for the compact 2D constructor.
The advanced constructor snapshots its sampler descriptor and validates the exact sampled
view and sampler that the returned resource will use. Final construction reuses those
objects and the validated sample type instead of reclassifying the format after an await.
An explicitly unfilterable declaration can still consume a `float` resource with a
non-filtering sampler. Storage-only resources create no sampling pair.

Disposal is rejected while the sampled facade or a compute-specific clone still has external texture owners. Release those consumers first, then dispose the storage resource.

### Binding sets

```ts
export interface ComputeBufferRange<T> {
    readonly buffer: T;
    readonly offset?: number;
    readonly size?: number;
}

export type ComputeStorageBufferRange = ComputeBufferRange<StorageBuffer>;
export type ComputeUniformBufferRange = ComputeBufferRange<UniformBuffer>;
export function readStorageBuffer(buffer: StorageBuffer): Promise<ArrayBuffer>;
export type ComputeBindingResources = Readonly<Record<string, unknown>>;

export interface ComputeBindingSet {
    readonly shader: ComputeShader;
}

export function createComputeBindingSet(shader: ComputeShader, resources: ComputeBindingResources): ComputeBindingSet;
export function disposeComputeBindingSet(bindings: ComputeBindingSet): void;
```

A binding set is immutable. Resource contents may change, but changing resource identity requires another binding set. This preserves A/B/A reuse without destroying either A or B's bind groups.

Buffer binding validation checks:

- resource kind matches the declaration;
- resource belongs to the shader's engine and is live;
- writable storage declarations receive a writable `StorageBuffer`;
- static offset and size are aligned, in bounds, and satisfy `minBindingSize`;
- uniform and storage offset alignment follows the owning device's limits;
- dynamic bindings reserve enough range for every legal dynamic offset.

Each resource family owns its declaration creation, validation, and live-handle resolution. The common binding-set code only invokes the resolver installed by the declaration helper. Raw WebGPU handles are rejected.

`readStorageBuffer` is the explicit opt-in readback path for writable storage allocations. It
submits one copy into a lazily allocated reusable staging buffer and resolves with a detached
`ArrayBuffer`. Concurrent reads of the same allocation share the pending operation. Ordinary
storage users retain no readback code unless they import this helper.

### Dispatches

```ts
export interface ComputeDirectDispatch {
    readonly x: number;
    readonly y?: number;
    readonly z?: number;
}

export interface ComputeDispatchOptions {
    readonly size: ComputeDirectDispatch;
    readonly enabled?: boolean;
}

export interface ComputeIndirectDispatchOptions {
    readonly buffer: StorageBuffer;
    readonly byteOffset?: number;
    readonly enabled?: boolean;
}

export interface ComputeDispatch {
    readonly shader: ComputeShader;
    readonly bindings: ComputeBindingSet;
    enabled: boolean;
}

export function createComputeDispatch(shader: ComputeShader, bindings: ComputeBindingSet, options: ComputeDispatchOptions): ComputeDispatch;
export function setComputeDispatchSize(dispatch: ComputeDispatch, size: ComputeDirectDispatch): void;
export function setComputeDispatchDynamicOffset(dispatch: ComputeDispatch, bindingName: string, byteOffset: number): void;
export function createComputeIndirectDispatch(shader: ComputeShader, bindings: ComputeBindingSet, options: ComputeIndirectDispatchOptions): ComputeDispatch;
export function setComputeIndirectDispatch(dispatch: ComputeDispatch, buffer: StorageBuffer, byteOffset?: number): void;
```

Direct dimensions are non-negative integers and may be zero, matching WebGPU's valid no-op dispatch. Values must not exceed `maxComputeWorkgroupsPerDimension`.

Indirect dispatch requires a live same-engine `StorageBuffer` created with `indirect: true`; `byteOffset` is a non-negative multiple of four and leaves at least 12 bytes available.

Dynamic offsets are pre-expanded into one retained numeric array per bind group in WebGPU binding order. Setting an offset mutates the retained slot in place and performs no allocation.

Direct dispatch is the core path. Importing `setComputeDispatchDynamicOffset` opts into dynamic-offset storage. Importing `createComputeIndirectDispatch` opts into indirect dispatch. Neither module is retained by direct, static-offset scenes.

### Pipeline variants

```ts
export type ComputePipelineConstants = Readonly<Record<string, number>>;

export interface ComputePipelineVariant {
    readonly shader: ComputeShader;
    readonly constants: ComputePipelineConstants;
}

export function createComputePipelineVariant(shader: ComputeShader, constants: ComputePipelineConstants): ComputePipelineVariant;
export function prepareComputePipelineVariant(variant: ComputePipelineVariant): Promise<void>;
export function createComputeVariantDispatch(variant: ComputePipelineVariant, bindings: ComputeBindingSet, options: ComputeDispatchOptions): ComputeDispatch;
```

Pipeline constants and their caches belong to the opt-in variant object. Keys may be symbolic WGSL override names or canonical decimal identifiers from `0` through `65535` for overrides declared with `@id(...)`. Symbolic names are passed unchanged to WebGPU, which performs the authoritative WGSL-version-specific validation during pipeline creation. The default `ComputeShader` stores only one pipeline and one pending preparation promise.

### Compute task

```ts
export interface ComputeTask extends Task {
    readonly dispatches: readonly ComputeDispatch[];
}

export function createComputeTask(engine: EngineContext, name?: string): ComputeTask;
export function addComputeDispatch(task: ComputeTask, dispatch: ComputeDispatch): void;
export function removeComputeDispatch(task: ComputeTask, dispatch: ComputeDispatch): void;
export function prepareComputeTask(task: ComputeTask): Promise<void>;
export function submitComputeTasks(tasks: readonly ComputeTask[]): void;
```

`addComputeDispatch` preserves insertion order. Existing dispatches can change dimensions, offsets, enabled state, uniform contents, and storage contents without rebuilding the frame graph.

Adding a dispatch whose pipeline variant has not been prepared after registration requires `prepareComputeTask(task)` before it is enabled. Startup registration calls the task's `_preload()` automatically.

`submitComputeTasks` executes already-recorded same-engine tasks immediately in one command buffer
without acquiring or rendering to a swapchain texture. It is intended for deterministic offscreen
warmup and explicit compute-only work between registered frames; task order is preserved. Calling it
from a frame callback while the engine is recording that frame throws, because a separate immediate
submission could otherwise execute ahead of commands already encoded into the unfinished frame.

One-shot completion is command-encoder scoped. Recording associates the armed generation with the
current encoder, and only successful submission of that same encoder can disable and resolve it.
An exception that abandons a frame or direct encoder leaves the one-shot armed for a later retry;
an unrelated submission cannot resolve work that never reached the GPU.

The task owns its dispatch array and recorded `ComputePass`; it does not own shaders, binding sets, or bound resources.

The optional `compute-one-shot` module provides startup-only execution without adding a second submission path:

```ts
export interface ComputeOneShot {
    readonly task: ComputeTask;
}

export function createComputeOneShot(task: ComputeTask): ComputeOneShot;
export function armComputeOneShot(oneShot: ComputeOneShot): Promise<void>;
export function disposeComputeOneShot(oneShot: ComputeOneShot): void;
```

Creation arms the task immediately. Recording marks the one-shot only after its pass was actually visited; a zero-work pass marks a submitted no-op without opening a compute pass. The module installs one optional engine post-submit hook while one-shots exist. A successful `queue.submit()` invokes that hook, disables every recorded shot before the next animation frame, and resolves each arm promise after `queue.onSubmittedWorkDone()`. If a later rendering context aborts the frame before submission, the hook is not called and the one-shot remains armed for retry. No extra command submission is added.

### Task-owned uniform arena

```ts
export interface ComputeUniformArena {
    readonly buffer: UniformBuffer;
    readonly slotByteLength: number;
    readonly slotStride: number;
    readonly slotCount: number;
}

export function createComputeUniformArena(task: ComputeTask, slotByteLength: number, slotCount: number, options?: UniformBufferOptions): ComputeUniformArena;

export function getComputeUniformSlotOffset(arena: ComputeUniformArena, slot: number): number;
export function updateComputeUniformSlot(arena: ComputeUniformArena, slot: number, data: ArrayBufferView, byteOffset?: number): void;
```

The arena aligns each slot to `minUniformBufferOffsetAlignment`, retains one CPU staging allocation, and uploads one enclosing dirty range before the task opens its compute pass. Bind `arena.buffer` through a dynamic uniform declaration and use `getComputeUniformSlotOffset` for each dispatch.

### Typed uniform writers

```ts
export type ComputeUniformScalarType = "f32" | "u32" | "i32" | "f16";
export type ComputeUniformVectorType = `vec${2 | 3 | 4}<${ComputeUniformScalarType}>`;
export type ComputeUniformMatrixType = `mat${2 | 3 | 4}x${2 | 3 | 4}<${"f32" | "f16"}>`;
export type ComputeUniformType = ComputeUniformScalarType | ComputeUniformVectorType | ComputeUniformMatrixType;

export interface ComputeUniformField {
    readonly name: string;
    readonly type: ComputeUniformType;
}

export interface ComputeUniformLayout {
    readonly byteLength: number;
}

export interface ComputeUniformWriter {
    readonly arena: ComputeUniformArena;
    readonly slot: number;
    readonly layout: ComputeUniformLayout;
}

export function createComputeUniformLayout(fields: readonly ComputeUniformField[]): ComputeUniformLayout;
export function createComputeUniformWriter(arena: ComputeUniformArena, slot: number, layout: ComputeUniformLayout): ComputeUniformWriter;
export function isComputeF16Supported(): Promise<boolean>;
export function isComputeF16Supported(engine: EngineContext): boolean;
export function createComputeUniformF16Writer(arena: ComputeUniformArena, slot: number, layout: ComputeUniformLayout): ComputeUniformWriter;
export function setComputeUniformF32(writer: ComputeUniformWriter, name: string, value: number): void;
export function setComputeUniformU32(writer: ComputeUniformWriter, name: string, value: number): void;
export function setComputeUniformI32(writer: ComputeUniformWriter, name: string, value: number): void;
export function setComputeUniformF16(writer: ComputeUniformWriter, name: string, value: number): void;
export function setComputeUniformVector(writer: ComputeUniformWriter, name: string, value: ArrayLike<number>): void;
export function setComputeUniformMatrix(writer: ComputeUniformWriter, name: string, value: ArrayLike<number>): void;
export function setComputeUniform(writer: ComputeUniformWriter, name: string, value: number | ArrayLike<number>): void;
```

Layout creation validates non-empty field names and types, rejects duplicate names, and computes uniform-address-space offsets once. Writer creation resolves one arena slot once and retains `Float32Array`, `Uint32Array`, and `Int32Array` views over the arena's staging allocation.

The specialized setters perform one precomputed name lookup, validate the setter category and exact element count, write directly into the retained views, and widen the arena's dirty range. They do not allocate, search declarations, convert shapes, compare previous values, or upload individually. Matrix input is column-major and contiguous; the writer inserts any WGSL column padding directly into the destination.

`setComputeUniform` is the generic validated convenience API for setup and non-critical paths. Hot paths should use the specialized scalar, vector, or matrix setter matching the declared field.

Binary16 is explicitly opt-in because WebGPU features must be requested before device creation:

```ts
if (!(await isComputeF16Supported())) {
    throw new Error("This application requires shader-f16.");
}
const engine = await createEngine(canvas, { requiredFeatures: ["shader-f16"] });
```

Calling `isComputeF16Supported()` before engine creation queries the adapter selected with the same adapter options as `createEngine`. Passing an existing engine checks whether its device actually enabled the feature. Request `shader-f16` per engine through `createEngine(canvas, { requiredFeatures: ["shader-f16"] })`; engine creation validates the requested feature in case adapter availability changes between the capability query and creation.

The `compute-uniform-f16` module owns the capability query, conversion code, and retained scratch `DataView`. Layouts containing f16 fields use `createComputeUniformF16Writer`. Scenes that never import these APIs retain none of the conversion implementation; device feature selection remains the generic per-engine `requiredFeatures` path.

## Internal Architecture

### `ComputeShader`

Internal fields:

```ts
interface ComputeShader {
    /** @internal */ readonly _engine: EngineContext;
    /** @internal */ readonly _source: string;
    /** @internal */ readonly _entryPoint: string;
    /** @internal */ readonly _decls: readonly ComputeBindingDecl[];
    /** @internal */ readonly _slots: Map<string, ComputeBindingSlot>;
    /** @internal */ _device: GPUDevice | null;
    /** @internal */ _module: GPUShaderModule | null;
    /** @internal */ _layouts: GPUBindGroupLayout[] | null;
    /** @internal */ _pipelineLayout: GPUPipelineLayout | null;
    /** @internal */ _pipeline: GPUComputePipeline | null;
    /** @internal */ _pending: Promise<GPUComputePipeline> | null;
    /** @internal */ _destroyed: boolean;
}
```

Every shader captures its owning `GPUDevice` at creation. A mismatch with `engine._device` throws and requires the application to recreate its compute graph; device-owned objects are never silently reconstructed.

Async preparation captures the device before awaiting. A result is published only if the shader remains live and its engine still owns the captured device. Concurrent preparation for the same variant shares one promise.

### `ComputeBindingSet`

Internal fields:

```ts
interface ComputeBindingSet {
    /** @internal */ readonly _shader: ComputeShader;
    /** @internal */ readonly _resources: readonly ComputeResolvedResource[];
    /** @internal */ _device: GPUDevice | null;
    /** @internal */ _groups: GPUBindGroup[] | null;
    /** @internal */ _destroyed: boolean;
}
```

The resolved resource array is sorted by group then binding. Every entry stores the public wrapper and static range, not a raw handle. Bind groups are built lazily or during preparation from current handles. If the shader's engine device changes, later use fails explicitly instead of rebuilding partial state.

### `ComputeDispatch`

Internal fields contain:

- normalized pipeline constant key and retained descriptor;
- direct dimensions or indirect wrapper/offset;
- one retained dynamic-offset array per bind group;
- a direct reference to the immutable binding set;
- enabled state.

No map lookup, descriptor normalization, array creation, or resource-name search occurs during pass execution.

### `ComputeTask` and `ComputePass`

`ComputeTask.record()` creates one `ComputePass`. The pass execute callback:

1. iterates the task's retained dispatch array;
2. skips disabled dispatches;
3. resolves the already-prepared pipeline variant;
4. validates each unique binding set once for this task execution, even when several dispatches reuse it;
5. calls `setPipeline` only when the pipeline differs from the previous dispatch;
6. calls `setBindGroup` only when the bind group or that group's dynamic offsets differ;
7. issues `dispatchWorkgroups` or `dispatchWorkgroupsIndirect`.

The pass is opened once and ended once. It uses `engine._currentEncoder`; it never creates or submits a command encoder.

The shared low-level recorder may also serve internal thin-instance culling, but the public resource abstraction must not add allocations or general binding scans to culling's hot path. A compact group-zero direct-dispatch fast path is retained if measurements show it is smaller or faster.

## Pipeline Configuration

The shader source is passed unchanged to `GPUDevice.createShaderModule`.

Each declared group creates a `GPUBindGroupLayout` whose entries are sorted by binding. Pipeline layout group positions exactly match WGSL group numbers.

Pipeline descriptor:

```ts
{
    label: shader.name,
    layout: shader._pipelineLayout,
    compute: {
        module: shader._module,
        entryPoint: shader._entryPoint,
        constants,
    },
}
```

No render state, material, scene bind group, or render-target signature participates in compute pipeline identity.

## Shader Logic

Babylon Lite does not inject declarations or helper code. A shader is complete WGSL:

```wgsl
struct Params {
    count: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> output: array<vec4<f32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x < params.count) {
        output[id.x] = vec4<f32>(f32(id.x), 0.0, 0.0, 1.0);
    }
}
```

## State Machine / Lifecycle

### Shader

1. Create immutable CPU descriptor.
2. Prepare zero or more pipeline variants asynchronously, or build synchronously at task preparation.
3. Share across binding sets/tasks.
4. If the engine device changes, later use throws and the application recreates the compute graph.
5. Dispose; later preparation or use throws.

### Binding set

1. Validate and retain wrappers/ranges.
2. Build bind groups against the shader's current layouts.
3. Share across dispatches/tasks.
4. If the shader's engine device changes, later use throws.
5. Dispose without disposing resources.

### Dispatch

1. Validate shader/binding-set identity, dimensions, indirect source, constants, and offsets.
2. Add to one or more compatible tasks.
3. Mutate only enabled state, dimensions, indirect offset, and retained dynamic-offset values.
4. Removal from a task does not dispose it.

### Task

1. Create and add ordered dispatches.
2. Add task to a scene or standalone frame graph.
3. `_preload()` prepares unique shader variants and binding sets.
4. `record()` creates one pass.
5. Execute one compute pass each enabled frame.
6. Dispose pass/task-owned uniform storage only.

## Device Loss

Automatic reconstruction of compute state is intentionally out of scope. GPU-produced buffers, indirect arguments, storage textures, simulation state, and temporal data may have no authoritative CPU copy, so recreating handles cannot transparently restore correct contents. If the engine device changes, compute shaders and variants fail explicitly. The application decides whether to reload or recreate its engine, resources, tasks, and domain state.

## Hot-Path Requirements

After preparation, one frame must allocate no:

- command encoder or command buffer per dispatch;
- dispatch descriptor object;
- temporary one-element array;
- resource map;
- bind-group entry array;
- dynamic-offset array;
- `DataView` or converted uniform array;
- pipeline key string.

The steady-state loop is indexed and operates on retained dispatch, pipeline, bind-group, and offset data.

## Tree-Shaking

Compute modules are reachable only through explicitly imported public factories. No engine, scene, render-task, material, or loader module imports the public compute API.

The shared core changes are the concrete `ComputePass` support already anticipated by `Pass` and one optional post-submit short-circuit used only while compute one-shots install its hook. They must not retain compute implementation code in scenes that do not import compute.

All caches are object-owned or lazily initialized. There are no module-level `Map`, `Set`, or `WeakMap` allocations.

## Error Handling

Public creation/mutation boundaries throw for invalid declarations, unknown names, duplicate bindings, wrong resource kind, wrong engine, disposed resources, invalid ranges, invalid offsets, and invalid dispatch dimensions.

No API silently drops a binding, clamps dimensions, substitutes a fallback resource, or treats a failed preparation as success.

## Babylon.js Equivalence Map

| Babylon.js                                      | Babylon Lite                                     |
| ----------------------------------------------- | ------------------------------------------------ |
| `ComputeShader` source/pipeline state           | `ComputeShader`                                  |
| `ComputeShader` resource setters                | immutable `ComputeBindingSet`                    |
| direct dispatch                                 | `ComputeDispatch` direct size                    |
| indirect dispatch                               | `ComputeDispatch` indirect size                  |
| frame-graph compute task/pass                   | `ComputeTask` / `ComputePass`                    |
| `UniformBuffer`                                 | opaque `UniformBuffer` plus standalone functions |
| storage buffer with vertex/index/indirect flags | extended `StorageBufferOptions`                  |

Lite deliberately does not copy Babylon.js' mutable shader-owned binding model.

## Test Specification

Focused unit coverage must prove:

1. declaration validation and stable binding ordering;
2. A/B/A immutable binding-set reuse;
3. multiple groups and multiple uniform buffers;
4. static buffer subranges and dynamic offsets;
5. direct, zero-sized, and indirect dispatch validation;
6. 200 differently parameterized dispatches record into one compute pass;
7. pipeline and bind-group deduplication;
8. repeated execution performs no setup-time allocations or name scans;
9. async preparation deduplication, rejection cleanup, disposal races, and device-change rejection;
10. wrong-engine and disposed-resource failures;
11. compute/render/compute task ordering;
12. task disposal does not dispose shared shader/bindings/resources;
13. mixed storage-buffer, UBO, sampled-texture, sampler, and storage-texture groups;
14. texture sample-type, multisampling, sampler-type, format, dimension, ownership, and disposal validation.

Integration coverage:

- the storage-only scene from PR #583 renders several `baseVertex` slots from one CPU-filled vertex-capable storage allocation;
- scene 169 renders a candle into sampled color/depth attachments, uses typed allocation-free uniform setters to drive a depth-aware animated compute flame into a separate storage texture, and presents that texture in a later frame-graph task;
- scene 188 uses a one-shot compute task to fill a vertex-capable storage slab that rendering consumes directly with no readback or copy;
- scene 189 uses one compute pass to produce indirect workgroup counts and a later pass to consume them through `dispatchWorkgroupsIndirect`, with the result rendered from GPU-produced storage.

## File Manifest

- `docs/lite/architecture/54-compute.md`
- `packages/babylon-lite/src/compute/compute-shader.ts`
- `packages/babylon-lite/src/compute/compute-binding.ts`
- `packages/babylon-lite/src/compute/compute-bindings.ts`
- `packages/babylon-lite/src/compute/compute-buffer-binding.ts`
- `packages/babylon-lite/src/compute/compute-dispatch.ts`
- `packages/babylon-lite/src/compute/compute-dynamic-offset.ts`
- `packages/babylon-lite/src/compute/compute-indirect-dispatch.ts`
- `packages/babylon-lite/src/compute/compute-pipeline-variant.ts`
- `packages/babylon-lite/src/compute/compute-sampler-binding.ts`
- `packages/babylon-lite/src/compute/compute-sampler-resource.ts`
- `packages/babylon-lite/src/compute/compute-storage-buffer-binding.ts`
- `packages/babylon-lite/src/compute/compute-storage-texture-binding.ts`
- `packages/babylon-lite/src/compute/compute-storage-texture-view-binding.ts`
- `packages/babylon-lite/src/compute/compute-task.ts`
- `packages/babylon-lite/src/compute/compute-texture-binding.ts`
- `packages/babylon-lite/src/compute/compute-texture-resource.ts`
- `packages/babylon-lite/src/compute/compute-texture-view-binding.ts`
- `packages/babylon-lite/src/compute/compute-texture-view-resource.ts`
- `packages/babylon-lite/src/compute/compute-one-shot.ts`
- `packages/babylon-lite/src/compute/compute-uniform-arena.ts`
- `packages/babylon-lite/src/compute/compute-uniform-buffer-binding.ts`
- `packages/babylon-lite/src/compute/compute-uniform-f16.ts`
- `packages/babylon-lite/src/frame-graph/compute-pass.ts`
- `packages/babylon-lite/src/frame-graph/pass.ts`
- `packages/babylon-lite/src/frame-graph/frame-graph-actions.ts`
- `packages/babylon-lite/src/mesh/mesh-from-storage.ts`
- `packages/babylon-lite/src/mesh/mesh-vertex-layout.ts`
- `packages/babylon-lite/src/resource/uniform-buffer.ts`
- `packages/babylon-lite/src/resource/storage-buffer.ts`
- `packages/babylon-lite/src/resource/compute-storage-texture.ts`
- `packages/babylon-lite/src/resource/compute-storage-texture-view.ts`
- `packages/babylon-lite/src/resource/managed-resource-hooks.ts`
- `packages/babylon-lite/src/engine/engine.ts`
- `packages/babylon-lite/src/index.ts`
- focused tests under `tests/lite/unit/`
- compute integration scenes under `lab/lite/src/`
