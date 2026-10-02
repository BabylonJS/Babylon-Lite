# Module: Render shaders (custom render passes)

> Package path: `packages/babylon-lite/src/render-shader/`

## Purpose

Expose user-authored render passes (instanced draws, indexed and indirect draws, arbitrary WGSL, any
render-target format) without exposing raw GPU handles and without a second scheduler outside the frame
graph. It is the render-pass sibling of the compute module (`54-compute.md`) and follows its model:

- `RenderShader`: immutable program (WGSL with a vertex and a fragment entry point), binding layout,
  vertex-buffer layouts and fixed-function state. Pipelines are compiled per render-target signature.
- `RenderBindingSet`: immutable reusable resources for one program, declared with the same binding helpers
  as compute (`computeUniformBufferBinding`, `computeStorageBufferBinding`, `computeTextureBinding`, ...).
- `RenderDraw`: one reusable draw (direct, indexed or indirect) with its vertex/index `StorageBuffer`s,
  dynamic offsets and mutable counts.
- `RenderDrawTask`: a frame-graph task that records an ordered draw list into one render pass on one
  borrowed `RenderTarget`, in the frame's command encoder.

## Public API Surface

```ts
export interface RenderShaderOptions {
    readonly name?: string;
    readonly renderSource: string;
    readonly vertexEntryPoint?: string; // default "vertexMain"
    readonly fragmentEntryPoint?: string; // default "fragmentMain"
    readonly bindings?: readonly ComputeBindingDecl[];
    readonly vertexBuffers?: readonly GPUVertexBufferLayout[];
    readonly primitive?: GPUPrimitiveState;
    readonly target?: { readonly blend?: GPUBlendState; readonly writeMask?: GPUColorWriteFlags };
    readonly depth?: { readonly depthWriteEnabled?: boolean; readonly depthCompare?: GPUCompareFunction };
}
export function createRenderShader(engine: EngineContext, options: RenderShaderOptions): RenderShader;
export function prepareRenderShader(shader: RenderShader, target: RenderTarget): Promise<void>;
export function disposeRenderShader(shader: RenderShader): void;
export function createRenderBindingSet(shader: RenderShader, resources: ComputeBindingResources): RenderBindingSet;
export function disposeRenderBindingSet(bindings: RenderBindingSet): void;

export interface RenderDrawOptions {
    readonly vertexCount: number; // index count for indexed draws
    readonly instanceCount?: number;
    readonly firstVertex?: number;
    readonly firstInstance?: number;
    readonly vertexBuffers?: readonly StorageBuffer[]; // created with `vertex: true`
    readonly indexBuffer?: StorageBuffer; // created with `index: true`
    readonly indexFormat?: GPUIndexFormat;
    readonly enabled?: boolean;
}
export function createRenderDraw(shader: RenderShader, bindings: RenderBindingSet, options: RenderDrawOptions): RenderDraw;
export function setRenderDrawCount(draw: RenderDraw, vertexCount: number, instanceCount?: number): void;
export function setRenderDrawDynamicOffset(draw: RenderDraw, bindingName: string, byteOffset: number): void;
export function setRenderDrawIndirect(draw: RenderDraw, buffer: StorageBuffer, byteOffset?: number): void;

export interface RenderDrawTaskConfig {
    readonly name?: string;
    readonly target: RenderTarget;
    readonly clear?: boolean; // default false: draw over the target's contents
    readonly clearColor?: GPUColorDict;
}
export function createRenderDrawTask(engine: EngineContext, config: RenderDrawTaskConfig): RenderDrawTask;
export function addRenderDraw(task: RenderDrawTask, draw: RenderDraw): void;
export function removeRenderDraw(task: RenderDrawTask, draw: RenderDraw): void;
export function setRenderDrawTaskTarget(task: RenderDrawTask, target: RenderTarget): void;
```

## Internal Architecture

- `RenderShader._program` is a `ComputeShader` used only as the shared binding core: declaration
  validation against device limits, slot tables, dynamic-offset bookkeeping and binding-set bind groups.
  `createRenderShader` installs render-visible bind-group layouts and the pipeline layout on it
  immediately (vertex + fragment visibility; writable storage buffers and writable storage textures are
  fragment-only, as WebGPU requires), so `_ensureComputeBindingGroups` never builds compute layouts for it.
- Pipelines: `Map<signatureKey, GPURenderPipeline>` plus a per-target `WeakMap` holding the pipeline and
  a snapshot of its color format, depth/stencil format, effective depth compare, and sample count.
  Compare those scalar fields before reusing a target-identity hit. Unchanged targets allocate nothing
  on the per-frame lookup; a changed signature resolves the matching shared pipeline and refreshes
  the snapshot. Eager attachment rebuilds therefore cannot leave a stale pipeline behind.
- Async preparation: a lazy `Map<signatureKey, Promise<GPURenderPipeline>>` shares one compilation
  across concurrent calls, including different targets with the same signature. Settlement removes
  only the matching in-flight promise. Success publishes only while the program remains live on its
  owning device; failure leaves the signature retryable and propagates to every waiting caller.
- `RenderDrawTask` uses the `execute()` fast path (no `Pass` objects). Its `GPURenderPassDescriptor` and
  attachments are built in `record()` (and when `setRenderDrawTaskTarget` changes the attachment set);
  per frame only `view`, `loadOp` and `clearValue` are patched.
- Depth/stencil attachments include operations only for present aspects. `"stencil8"` omits all depth
  operations; `"depth24plus-stencil8"` and `"depth32float-stencil8"` include both depth and stencil.
  Clear/load changes apply to each present aspect, using the target's depth clear default and stencil
  clear value zero. Cache the depth/stencil format used by `buildAttachments`; compare that snapshot
  and the cached color attachment's presence against the synchronized target, not another live target
  descriptor. Selecting the same target after an in-place format change rebuilds the descriptor to
  add or remove aspect operations without another `record()`. An unchanged attachment signature
  preserves descriptor identity.
- Redundant `setPipeline` / `setBindGroup` calls are skipped as in `ComputeTask`.

## Pipeline Configuration

Color format, depth format, depth compare default and sample count come from the target's
`RenderTargetDescriptor`; blend, write mask, primitive state, depth write and compare come from the shader.
A stencil-only pipeline omits depth write/compare state, which is inapplicable to that format. Its
signature does not depend on depth compare.

## Shader Logic

WGSL is supplied by the caller without parsing or rewriting its declarations. The configured vertex
and fragment entry points use the declared binding layouts and vertex buffers. This module supplies
no material lighting or UV conversion.

## State Machine / Lifecycle

- A program, its binding sets and draws are device-relative, exactly like compute: after a device change
  they throw "recreate the compute graph" (wording inherited from the shared core). Applications recreate
  them in their device-lost recovery path.
- Targets are borrowed: the task never disposes them. A target that was never allocated is built once in
  `record()` or when selected by `setRenderDrawTaskTarget`, and stays caller-owned. Every `record()`
  synchronizes eager targets through `buildRenderTarget` before rebuilding the pass attachments.
  Target switches synchronize the new target before changing task state, so an eager resize/recovery
  hook or first allocation is reflected in the very next draw without another graph build.
  Switching a disposed task is rejected before synchronizing or allocating a target.
- When no draw is enabled and `clear` is false, the task opens no pass.
- Disposal clears completed and in-flight pipeline caches. An outstanding compilation cannot
  repopulate a disposed shader, and its waiting preparation rejects instead of reporting success.

## Babylon.js Equivalence Map

Custom render programs and frame-graph draw passes map to user-authored render effects and draw
tasks. Lite shares compute's binding core while retaining a single frame encoder and plain-state draws.

## Dependencies

`compute/compute-shader.ts`, `compute/compute-bindings.ts` (binding core), `engine/render-target.ts`,
`resource/storage-buffer.ts`. Nothing imports this module except the root re-exports, so scenes that do not
use it carry zero bytes of it.

## Test Specification

`tests/lite/unit/render-shader.test.ts`: layout visibility, one pipeline per target format with the
shader's fixed-function state, instanced draws with vertex buffers, no pass when idle, clear on request,
indexed and indirect draws, dynamic offsets, vertex-usage validation, async preparation, device-change
rejection, draw ownership.
Regression cases also cover concurrent same-signature preparation, independent signatures, retry
after rejection, disposal/device replacement during preparation, conditional depth/stencil operations,
clear/load changes, target format switching, stencil-only pipeline state, eager synchronization on
repeated records and target switches, single allocation for borrowed unbuilt targets, and rejection
of target switches after task disposal. Same-format color-to-color and depth-to-depth switches reuse
the pass descriptor while refreshing its attachment view. A mutable descriptor on the real mipmapped
target owner exercises depth-format rebuilds by selecting the same target without another record,
under both clear/load modes. Returning to depth-only removes stencil operations and reuses the
original cached pipeline.

## File Manifest

- `render-shader/render-shader.ts`: program, pipelines, binding sets.
- `render-shader/render-draw.ts`: draw records, counts, dynamic offsets.
- `render-shader/render-draw-indirect.ts`: opt-in indirect draws.
- `render-shader/render-draw-task.ts`: frame-graph task.
