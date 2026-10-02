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
- Pipelines: `Map<signatureKey, GPURenderPipeline>` plus a `WeakMap<RenderTarget, GPURenderPipeline>` in
  front of it, so the per-frame lookup allocates nothing (no key string) once a target has been seen.
- `RenderDrawTask` uses the `execute()` fast path (no `Pass` objects). Its `GPURenderPassDescriptor` and
  attachments are built in `record()` (and when `setRenderDrawTaskTarget` changes the attachment set);
  per frame only `view`, `loadOp` and `clearValue` are patched.
- Redundant `setPipeline` / `setBindGroup` calls are skipped as in `ComputeTask`.

## Pipeline Configuration

Color format, depth format, depth compare default and sample count come from the target's
`RenderTargetDescriptor`; blend, write mask, primitive state, depth write and compare come from the shader.

## State Machine / Lifecycle

- A program, its binding sets and draws are device-relative, exactly like compute: after a device change
  they throw "recreate the compute graph" (wording inherited from the shared core). Applications recreate
  them in their device-lost recovery path.
- Targets are borrowed: the task never disposes them. A target that was never allocated is built once in
  `record()` and stays caller-owned.
- When no draw is enabled and `clear` is false, the task opens no pass.

## Dependencies

`compute/compute-shader.ts`, `compute/compute-bindings.ts` (binding core), `engine/render-target.ts`,
`resource/storage-buffer.ts`. Nothing imports this module except the root re-exports, so scenes that do not
use it carry zero bytes of it.

## Test Specification

`tests/lite/unit/render-shader.test.ts`: layout visibility, one pipeline per target format with the
shader's fixed-function state, instanced draws with vertex buffers, no pass when idle, clear on request,
indexed and indirect draws, dynamic offsets, vertex-usage validation, async preparation, device-change
rejection, draw ownership.

## File Manifest

- `render-shader/render-shader.ts`: program, pipelines, binding sets.
- `render-shader/render-draw.ts`: draw records, counts, dynamic offsets.
- `render-shader/render-draw-indirect.ts`: opt-in indirect draws.
- `render-shader/render-draw-task.ts`: frame-graph task.
