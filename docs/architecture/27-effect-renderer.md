# Module: Effect Renderer
> Package path: `packages/babylon-lite/src/effect/`

## Purpose

The effect renderer module provides a Lite-native equivalent of Babylon.js `EffectRenderer` / `EffectWrapper` for fullscreen shader work. It is intentionally WebGPU/WGSL-first and frame-graph-native:

- effects are pure-state wrapper handles;
- behaviour is exposed through standalone functions;
- fullscreen geometry is the standard single triangle generated from `@builtin(vertex_index)`;
- render work is scheduled as a `Task` in the existing `FrameGraph`;
- targets are either the swapchain or an existing `RenderTarget`;
- user-facing resources remain Lite handles (`Texture2D`, `RenderTarget`), never raw WebGPU handles.

This module is meant for post-processes, procedural fullscreen passes, copy/blit utilities, and future replacement of ad hoc fullscreen passes.

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

export interface EffectRenderTaskConfig {
    name: string;
    effect: EffectWrapper;
    target?: "swapchain" | RenderTarget;
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
- color target format and sample count come from the task target;
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

1. `createEffectWrapper(engine, options)` returns a pure-state wrapper. It validates binding declarations and creates GPU shader/layout objects lazily.
2. User code calls `setEffectUniforms` and/or `setEffectTexture` at setup time or per frame.
3. `createEffectRenderTask(config, engine, scene)` creates a frame-graph task. If `target` is `"swapchain"` or omitted, the task creates an internal swapchain `RenderTarget`; otherwise it uses the provided `RenderTarget`.
4. The task's `record()` builds the render target and cached render-pass descriptor.
5. Each `execute()` patches swapchain views/clear state, gets the wrapper pipeline for the target signature, gets/rebuilds the bind group, and encodes one draw call.
6. `disposeEffectWrapper(wrapper)` destroys wrapper-owned uniform buffers and clears GPU references. The task disposes only its internally-created swapchain target; caller-provided render targets remain caller-owned.

## Babylon.js Equivalence Map

| Babylon.js | Babylon Lite |
| --- | --- |
| `EffectWrapper` | `EffectWrapper` pure-state handle |
| `EffectRenderer.render(wrapper, outputTexture?)` | `createEffectRenderTask({ effect, target })` scheduled in `FrameGraph` |
| fullscreen quad/index buffer | vertex-index fullscreen triangle |
| `onApplyObservable` | user calls `setEffectUniforms` / `setEffectTexture` before the pass executes |
| current framebuffer / RTT | `"swapchain"` / `RenderTarget` |

The API intentionally does not implement Babylon.js shader-store lookup, GLSL include processing, observables, raw render-target wrappers, or WebGL compatibility.

## Dependencies

- `engine/engine.ts` for `EngineContext` / internal device access;
- `engine/render-target.ts` for `RenderTarget`, `buildRenderTarget`, `disposeRenderTarget`, and `targetSignatureKey`;
- `frame-graph/task.ts` for task polymorphism;
- `resource/gpu-pool.ts` for sampler reuse through `Texture2D.sampler`;
- `scene/scene-core.ts` for scene ownership and frame-graph scheduling;
- `texture/texture-2d.ts` for public texture handles.

## Test Specification

- Scene 74 renders a deterministic fullscreen procedural effect through Babylon.js `EffectRenderer` and Babylon Lite's effect task.
- The parity test captures/uses `reference/scene74-effect-renderer/babylon-ref-golden.png`, screenshots `lab/scene74.html`, and asserts full-image MAD against `scene-config.json`.
- Bundle-size accounting gets a new scene-specific `maxRawKB` entry only; existing ceilings are untouched.

## File Manifest

- `packages/babylon-lite/src/effect/effect-renderer.ts`
- `docs/architecture/27-effect-renderer.md`
- `lab/src/bjs/scene74.ts`
- `lab/babylon-ref-scene74.html`
- `lab/src/lite/scene74.ts`
- `lab/scene74.html`
- `tests/parity/scenes/scene74-effect-renderer.spec.ts`
- `reference/scene74-effect-renderer/babylon-ref-golden.png`
- `lab/public/thumbnails/scene74.png`
