# Module: Effect Renderer
> Package path: `packages/babylon-lite/src/effect/`

## Purpose

The effect renderer module provides a Lite-native equivalent of Babylon.js `EffectRenderer` / `EffectWrapper` for fullscreen shader work. It is intentionally WebGPU/WGSL-first and keeps the simplest swapchain path out of the scene frame graph:

- effects are pure-state wrapper handles;
- behaviour is exposed through standalone functions;
- uniforms, textures, and samplers are declared explicitly through `EffectBindingLayout`;
- fullscreen geometry is the standard single triangle generated from `@builtin(vertex_index)`;
- swapchain-only effects register as a direct engine rendering context, so no `SceneContext` or default scene `RenderTask` is needed;
- offscreen render-to-texture effects are scheduled as a `Task` in the existing scene `FrameGraph`;
- uniform-only offscreen effects can use the smaller `UniformEffectWrapper` path when a fullscreen shader needs exactly one uniform buffer and no textures or samplers;
- frame-graph task targets are existing `RenderTarget`s;
- user-facing resources remain Lite handles (`Texture2D`, `RenderTarget`), never raw WebGPU handles.

This module is meant for post-processes, procedural fullscreen passes, render-to-texture effects, copy/blit utilities, and future replacement of ad hoc fullscreen passes.

## Public API Surface (types, functions, constants — full signatures)

```ts
export type EffectBindingKind = "uniform" | "texture" | "sampler";

export interface EffectBindingLayout {
    name?: string;
    binding: number;
    kind: EffectBindingKind;
    visibility?: GPUShaderStageFlags;
    uniformByteLength?: number;
    textureSampleType?: GPUTextureSampleType;
    samplerType?: GPUSamplerBindingType;
    textureBinding?: string | number;
}

export interface EffectWrapperOptions {
    name?: string;
    fragmentWGSL: string;
    vertexWGSL?: string;
    bindings?: EffectBindingLayout[];
    blend?: GPUBlendState;
}

export interface EffectWrapper {
    readonly name: string;
    readonly options: EffectWrapperOptions;
}

// ─── Direct swapchain renderer (no SceneContext / frame graph) ───────

export interface EffectRendererOptions {
    name?: string;
    clear?: boolean;
    clearColor?: GPUColorDict;
}

export interface EffectRenderer extends RenderingContext {
    readonly name: string;
}

export function createEffectRenderer(engine: EngineContext, effect: EffectWrapper, options?: EffectRendererOptions): EffectRenderer;
export function registerEffectRenderer(er: EffectRenderer): void;
export function unregisterEffectRenderer(er: EffectRenderer): void;
export function disposeEffectRenderer(er: EffectRenderer): void;

// ─── Frame-graph task (use for offscreen RTT workflows) ──────────────

export interface EffectRenderTaskConfig {
    name: string;
    effect: EffectWrapper;
    target: RenderTarget;
    clear?: boolean;
    clearColor?: GPUColorDict;
}

export interface EffectRenderTask extends Task {
    readonly name: string;
    readonly _config: EffectRenderTaskConfig;
    readonly _rt: RenderTarget;
}

export function createEffectWrapper(engine: EngineContext, options: EffectWrapperOptions): EffectWrapper;
export function setEffectUniforms(wrapper: EffectWrapper, data: ArrayBuffer | ArrayBufferView | Record<string | number, ArrayBuffer | ArrayBufferView>): void;
export function setEffectTexture(wrapper: EffectWrapper, bindingNameOrIndex: string | number, texture: Texture2D): void;
export function createEffectRenderTask(config: EffectRenderTaskConfig, engine: EngineContext, scene: SceneContext): EffectRenderTask;
export function disposeEffectWrapper(wrapper: EffectWrapper): void;

// ─── Uniform-only frame-graph task (smaller bundle path) ─────────────

export interface UniformEffectWrapperOptions {
    name?: string;
    fragmentWGSL: string;
    vertexWGSL?: string;
    uniformByteLength: number;
}

export interface UniformEffectWrapper {
    readonly name: string;
    readonly options: UniformEffectWrapperOptions;
}

export interface UniformEffectRenderTaskConfig {
    name: string;
    effect: UniformEffectWrapper;
    target: RenderTarget;
    clear?: boolean;
    clearColor?: GPUColorDict;
}

export interface UniformEffectRenderTask extends Task {
    readonly name: string;
    readonly _config: UniformEffectRenderTaskConfig;
    readonly _rt: RenderTarget;
}

export function createUniformEffectWrapper(engine: EngineContext, options: UniformEffectWrapperOptions): UniformEffectWrapper;
export function setUniformEffectUniforms(wrapper: UniformEffectWrapper, data: ArrayBuffer | ArrayBufferView): void;
export function createUniformEffectRenderTask(config: UniformEffectRenderTaskConfig, engine: EngineContext, scene?: SceneContext): UniformEffectRenderTask;
export function disposeUniformEffectWrapper(wrapper: UniformEffectWrapper): void;
```

## Internal Architecture (data structures, memory layouts)

`EffectWrapper` is a plain public state object with internal slots hidden from the exported type. Internally it owns:

- one combined WGSL shader module (`vertexWGSL + fragmentWGSL`);
- one bind-group layout derived from the explicit `EffectBindingLayout[]`;
- one pipeline layout;
- a lazy per-wrapper pipeline cache keyed by `targetSignatureKey(RenderTargetSignature)`;
- uniform slots keyed by binding number/name;
- texture slots keyed by binding number/name;
- one cached bind group rebuilt when uniforms/textures change.

No module-level `Map`, `WeakMap`, or `Set` allocation is used. Pipeline caches live on wrappers and are created lazily.

Uniform data is copied into wrapper-owned uniform buffers. `setEffectUniforms(wrapper, data)` supports:

- a single `ArrayBuffer` / typed-array payload, written to the first uniform binding;
- a record whose keys are binding names or numeric binding indices, written to matching uniform bindings.

`setEffectTexture(wrapper, bindingNameOrIndex, texture)` stores the `Texture2D` handle on the texture binding. Sampler bindings use either:

1. the texture identified by `textureBinding`, if supplied;
2. the first texture slot, otherwise.

This allows the common `texture + sampler` pair without exposing `GPUTextureView` or `GPUSampler` in the public API.

`UniformEffectWrapper` is the same fullscreen-triangle effect shape specialized for the smallest uniform-only case: it creates one uniform buffer at group 0 / binding 0, one bind-group layout, one bind group, and one render task. It intentionally omits texture/sampler binding discovery, blend configuration, direct swapchain rendering, and multi-uniform lookup so simple procedural frame-graph demos do not pay for the generic `EffectWrapper` binding machinery.

## Pipeline Configuration (vertex/fragment stages, bind groups, depth/stencil)

Default vertex stage:

```wgsl
struct EffectVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn effectFullscreenVertex(@builtin(vertex_index) vertexIndex: u32) -> EffectVertexOutput {
    var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    let p = positions[vertexIndex];
    var out: EffectVertexOutput;
    out.position = vec4<f32>(p, 0.0, 1.0);
    out.uv = p * 0.5 + vec2<f32>(0.5, 0.5);
    return out;
}
```

Pipeline state:

- topology: `triangle-list`;
- draw count: `3`;
- no vertex/index buffers;
- no depth/stencil attachment;
- color target format and sample count come from the renderer/task target;
- blend is `options.blend` or disabled;
- culling is off.

The fragment entry point is always `effectFragment`.

## Shader Logic (WGSL outline or pseudocode with exact math)

User fragments are supplied as WGSL and must define:

```wgsl
@fragment
fn effectFragment(input: EffectVertexOutput) -> @location(0) vec4<f32> {
    // input.uv follows Babylon.js post-process coordinates:
    // bottom-left triangle vertex maps to (0,0), top-left screen pixels approach y=1.
}
```

If a custom `vertexWGSL` is supplied, it must provide an `@vertex` entry point named `effectFullscreenVertex`.

## State Machine / Lifecycle

### Swapchain-only path (`EffectRenderer`)

1. `createEffectWrapper(engine, options)` returns a pure-state wrapper. Shader/layout objects are created lazily on first use.
2. User code calls `setEffectUniforms` and/or `setEffectTexture`.
3. `createEffectRenderer(engine, effect, options?)` creates an `EffectRenderer` that implements `RenderingContext` directly. It owns an internal swapchain `RenderTarget` and no `SceneContext` is needed.
4. `registerEffectRenderer(er)` registers the renderer with the engine.
5. `startEngine(engine)` starts the render loop. Each frame: `_record()` rebuilds the RT if the canvas resized, patches swapchain views, encodes one draw call.
6. `disposeEffectRenderer(er)` unregisters and frees the swapchain `RenderTarget`.
7. `disposeEffectWrapper(wrapper)` destroys wrapper-owned uniform buffers and clears GPU references.

### Offscreen RTT path (`createEffectRenderTask`)

1. `createEffectWrapper(engine, options)` — same as above.
2. `createRenderTargetTexture(engine, descriptor)` returns `{ rt, texture }` for the offscreen target.
3. `createEffectRenderTask(config, engine, scene)` creates a frame-graph `Task`. If `target` is a `RenderTarget`, the task renders into it; the `Texture2D` from step 2 can then be bound to a scene material.
4. `addTaskAtStart(scene, task)` (or `addTask`) schedules the pass before the scene's default render pass.
5. `registerScene` / `startEngine` as normal.
6. `disposeEffectWrapper(wrapper)` when done.

### Uniform-only frame-graph path (`createUniformEffectRenderTask`)

1. `createUniformEffectWrapper(engine, { fragmentWGSL, uniformByteLength })` creates a smaller effect wrapper with one uniform buffer at binding 0.
2. User code calls `setUniformEffectUniforms(wrapper, data)` before each draw that needs updated uniform data.
3. `createUniformEffectRenderTask(config, engine, scene?)` creates a frame-graph `Task` for an explicit `RenderTarget`. It can be scheduled in a scene frame graph or a standalone `FrameGraphContext`.
4. The task records a single fullscreen triangle pipeline and binds the wrapper's uniform bind group at group 0.
5. `disposeUniformEffectWrapper(wrapper)` destroys the wrapper-owned uniform buffer.

## Babylon.js Equivalence Map

| Babylon.js | Babylon Lite |
| --- | --- |
| `EffectWrapper` | `EffectWrapper` pure-state handle |
| `EffectRenderer.render(wrapper)` (swapchain) | `createEffectRenderer(engine, effect)` + `registerEffectRenderer` — no scene needed |
| `EffectRenderer.render(wrapper, outputTexture)` (RTT) | `createEffectRenderTask({ effect, target: rt })` scheduled in `FrameGraph` |
| uniform-only fullscreen pass | `createUniformEffectWrapper` + `createUniformEffectRenderTask` |
| fullscreen quad/index buffer | vertex-index fullscreen triangle |
| `onApplyObservable` | user calls `setEffectUniforms` / `setEffectTexture` before the pass executes |
| current framebuffer / RTT | direct `EffectRenderer` / frame-graph `RenderTarget` task |
| `effect.setTexture("name", texture)` | `setEffectTexture(wrapper, "name", texture2D)` |

The API intentionally does not implement Babylon.js shader-store lookup, GLSL include processing, observables, raw render-target wrappers, or WebGL compatibility.

## Dependencies

- `engine/engine.ts` for `EngineContext` / internal device access;
- `engine/render-target.ts` for `RenderTarget`, `buildRenderTarget`, `disposeRenderTarget`, and `targetSignatureKey`;
- `frame-graph/task.ts` for task polymorphism;
- `resource/gpu-pool.ts` for sampler reuse through `Texture2D.sampler`;
- `scene/scene-core.ts` for scene ownership and frame-graph scheduling;
- `texture/texture-2d.ts` for public texture handles.

## Test Specification

- Scene 74 renders a deterministic fullscreen procedural effect through Babylon.js `EffectRenderer` and Babylon Lite's direct effect renderer.
- Scene 75 renders an effect into a `RenderTarget` and maps that texture onto a sphere, matching the Babylon.js playground-style RTT workflow.
- Scene 76 binds a `Texture2D` through `setEffectTexture()` and samples it with an associated sampler binding through the direct effect renderer.
- The parity tests capture/use the `reference/lite/scene74-effect-renderer`, `reference/lite/scene75-effect-rtt-sphere`, and `reference/lite/scene76-effect-texture` goldens, then assert full-image MAD against `scene-config.json`.
- Bundle-size accounting uses scene-specific `maxRawKB` entries for the new effect scenes only; existing ceilings are untouched.

## File Manifest

- `packages/babylon-lite/src/effect/effect-renderer.ts`
- `packages/babylon-lite/src/effect/uniform-effect-renderer.ts`
- `docs/lite/architecture/30-effect-renderer.md`
- `lab/lite/src/bjs/scene74.ts`
- `lab/lite/babylon-ref-scene74.html`
- `lab/lite/src/lite/scene74.ts`
- `lab/lite/scene74.html`
- `tests/lite/parity/scenes/scene74-effect-renderer.spec.ts`
- `reference/lite/scene74-effect-renderer/babylon-ref-golden.png`
- `lab/public/thumbnails/scene74.jpg`
- `lab/lite/src/bjs/scene75.ts`
- `lab/lite/babylon-ref-scene75.html`
- `lab/lite/src/lite/scene75.ts`
- `lab/lite/scene75.html`
- `tests/lite/parity/scenes/scene75-effect-rtt-sphere.spec.ts`
- `reference/lite/scene75-effect-rtt-sphere/babylon-ref-golden.png`
- `lab/public/thumbnails/scene75.jpg`
- `lab/lite/src/bjs/scene76.ts`
- `lab/lite/babylon-ref-scene76.html`
- `lab/lite/src/lite/scene76.ts`
- `lab/lite/scene76.html`
- `tests/lite/parity/scenes/scene76-effect-texture.spec.ts`
- `reference/lite/scene76-effect-texture/babylon-ref-golden.png`
- `lab/public/thumbnails/scene76.jpg`
