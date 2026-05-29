# Module: Frame-Graph Post-Process
> Package paths: `packages/babylon-lite/src/frame-graph/`, `packages/babylon-lite/src/post-process/`

## Purpose

Frame-graph post-process tasks run a full-screen WGSL fragment pass over a source render-target color texture and write the result into either a caller-provided render target or an internally-owned render target. The helper is intentionally smaller than Babylon.js `FrameGraphPostProcessTask`: it has no `ThinPostProcess`, no shader store lookup, no effect abstraction, and no raw WebGPU handles in the public API.

The reusable helper exists because most post-processes share the same shape:

- one source color texture;
- one sampler selected by `sourceSamplingMode`;
- one optional uniform block;
- one full-screen triangle;
- one color output target;
- optional alpha blending and normalized viewport/scissor.

## Public API Surface (types, functions, constants — full signatures)

```ts
export type PostProcessSamplingMode = "nearest" | "linear";
export type PostProcessAlphaMode = 0 | 1 | 2 | 7;

export interface PostProcessShaderConfig {
    fragmentWGSL: string;
    uniformWGSL?: string;
    uniformByteLength?: number;
    uniformBinding?: number;
    writeUniforms?: (data: Float32Array) => void;
    extraTextureWGSL?: string;
    extraTextures?: readonly RenderTarget[];
}

export interface PostProcessTaskSettings {
    name?: string;
    sourceTexture: RenderTarget;
    sourceSamplingMode?: PostProcessSamplingMode;
    targetTexture?: RenderTarget | null;
    alphaMode?: PostProcessAlphaMode;
    viewport?: NormalizedViewport | null;
    clear?: boolean;
}

export interface PostProcessTaskConfig extends PostProcessTaskSettings {
    _shader: PostProcessShaderConfig;
}

export interface PostProcessTask extends Task, PostProcessTaskSettings {
    readonly name: string;
    sourceSamplingMode: PostProcessSamplingMode;
    targetTexture: RenderTarget | null;
    alphaMode: PostProcessAlphaMode;
    viewport: NormalizedViewport | null;
    outputTexture: RenderTarget;
    updateUniforms(): void;
}

export function createPostProcessTask(config: PostProcessTaskConfig, engine: EngineContext, scene: SceneContext): PostProcessTask;

export interface BlackAndWhitePostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    degree?: number;
}

export interface BlackAndWhitePostProcessTask extends PostProcessTask {
    degree: number;
}

export function createBlackAndWhitePostProcessTask(config: BlackAndWhitePostProcessTaskConfig, engine: EngineContext, scene: SceneContext): BlackAndWhitePostProcessTask;

export interface AnaglyphPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    leftTexture: RenderTarget;
}

export function createAnaglyphPostProcessTask(config: AnaglyphPostProcessTaskConfig, engine: EngineContext, scene: SceneContext): PostProcessTask;

export interface BlurPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    direction?: { x: number; y: number };
    kernel?: number;
}

export interface BlurPostProcessTask extends PostProcessTask {
    direction: { x: number; y: number };
    kernel: number;
}

export function createBlurPostProcessTask(config: BlurPostProcessTaskConfig, engine: EngineContext, scene: SceneContext): BlurPostProcessTask;

export interface ExtractHighlightsPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    threshold?: number;
    exposure?: number;
}

export interface ExtractHighlightsPostProcessTask extends PostProcessTask {
    threshold: number;
    exposure: number;
}

export function createExtractHighlightsPostProcessTask(config: ExtractHighlightsPostProcessTaskConfig, engine: EngineContext, scene: SceneContext): ExtractHighlightsPostProcessTask;

export interface ChromaticAberrationPostProcessTaskConfig extends Omit<PostProcessTaskConfig, "_shader"> {
    aberrationAmount?: number;
    direction?: { x: number; y: number };
    radialIntensity?: number;
    centerPosition?: { x: number; y: number };
}

export interface ChromaticAberrationPostProcessTask extends PostProcessTask {
    aberrationAmount: number;
    direction: { x: number; y: number };
    radialIntensity: number;
    centerPosition: { x: number; y: number };
}

export function createChromaticAberrationPostProcessTask(config: ChromaticAberrationPostProcessTaskConfig, engine: EngineContext, scene: SceneContext): ChromaticAberrationPostProcessTask;

export interface BloomPostProcessTaskConfig extends PostProcessTaskSettings {
    weight?: number;
    kernel?: number;
    threshold?: number;
    exposure?: number;
    bloomScale?: number;
}

export interface BloomPostProcessTask extends Task, PostProcessTaskSettings {
    readonly name: string;
    sourceTexture: RenderTarget;
    targetTexture: RenderTarget | null;
    outputTexture: RenderTarget;
    weight: number;
    kernel: number;
    threshold: number;
    exposure: number;
    readonly bloomScale: number;
    updateUniforms(): void;
}

export function createBloomPostProcessTask(config: BloomPostProcessTaskConfig, engine: EngineContext, scene: SceneContext): BloomPostProcessTask;
```

`PostProcessShaderConfig` and `PostProcessTaskConfig` are implementation-facing types used by concrete post-process factories; `_shader` is intentionally internal and is omitted from public concrete post-process configs.

The Babylon.js property names are preserved on `PostProcessTask`: `sourceTexture`, `sourceSamplingMode`, `targetTexture`, `alphaMode`, `viewport`, and `outputTexture`. The contract is `RenderTarget`-focused because Lite's public `Texture2D` wrapper does not carry enough attachment metadata to create a same-format/same-size render target. `updateUniforms()` is the shared explicit hook concrete post-processes use when the caller mutates exposed parameters such as `BlackAndWhitePostProcessTask.degree`.

## Internal Architecture (data structures, memory layouts)

`createPostProcessTask` returns a plain task record with internal slots hidden from the exported interface:

- `_internalTarget`: the render target used when `targetTexture` is `null`;
- `_pipeline`: one render pipeline for the current target format/sample count/alpha mode;
- `_bindGroup`: source texture + sampler + optional uniform buffer + optional extra textures;
- `_uniformBuffer`: optional uniform buffer sized by `_shader.uniformByteLength`;
- `_renderPassDescriptor` and `_colorAttachment`: cached render-pass state patched each frame for swapchain targets;
- `_shaderModule`: WGSL module combining the helper vertex stage, source bindings, optional uniform declarations, user `fragmentWGSL`, and the generated fragment entry point.

The helper creates no module-level caches. Pipeline state belongs to the task and is rebuilt during `record()` after the source producer has allocated the source texture and after the target has been allocated.

Uniform memory is caller-defined. If `uniformByteLength` is set, it is rounded up to 16 bytes, a `Float32Array` scratch buffer of that size is created, `writeUniforms(data)` fills it during `record()` and whenever `updateUniforms()` is called. Uniform bytes default to binding `2 + extraTextures.length`, or to `_shader.uniformBinding` when a concrete task needs an explicit slot. Extra textures are implementation-facing `RenderTarget`s paired with `_shader.extraTextureWGSL` declarations; anaglyph binds the left-eye texture, and bloom merge binds the blurred highlight texture.

## Pipeline Configuration (vertex/fragment stages, bind groups, depth/stencil)

Pipeline:

- topology: `triangle-list`;
- draw count: `3`;
- vertex buffers: none;
- depth/stencil: none;
- multisample count: `outputTexture._descriptor.sampleCount`;
- color format: `outputTexture._descriptor.colorFormat`;
- blend: derived from `alphaMode`.

Bind group `0`:

| Binding | Resource | Visibility |
| --- | --- | --- |
| `0` | source sampler (`nearest` or `linear`) | fragment |
| `1` | source color texture (`texture_2d<f32>`) | fragment |
| `2+` | optional extra textures (`texture_2d<f32>`) | fragment |
| `2 + extraTextures.length` or `_shader.uniformBinding` | optional uniform buffer | fragment |

`alphaMode` mapping follows the existing Lite/Babylon.js numeric modes used by node-material pipelines:

- `0`: opaque/no blending;
- `1`: additive (`src-alpha`, `one`);
- `2`: standard combine (`src-alpha`, `one-minus-src-alpha`);
- `7`: premultiplied (`one`, `one-minus-src-alpha`).

`viewport`, when present, is normalized like camera viewports and follows Babylon's bottom-origin convention. It is converted to pixel viewport and scissor rectangles using the output target dimensions. `clear` controls the color attachment load operation and defaults to `true`; multi-viewport demos render several post-process tasks into the same target by clearing only the first task.

## Shader Logic (WGSL outline or pseudocode with exact math)

The helper owns the vertex stage and fragment wrapper:

```wgsl
struct PostProcessVertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn postProcessVertex(@builtin(vertex_index) vertexIndex: u32) -> PostProcessVertexOutput {
    var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    let p = positions[vertexIndex];
    var out: PostProcessVertexOutput;
    out.position = vec4f(p, 0.0, 1.0);
    out.uv = p * 0.5 + vec2f(0.5, 0.5);
    return out;
}

@group(0) @binding(0) var sourceSampler: sampler;
@group(0) @binding(1) var sourceTextureSampler: texture_2d<f32>;

fn readPostProcessSource(position: vec2f) -> vec4f {
    let dims = vec2f(textureDimensions(sourceTextureSampler));
    let uv = (floor(position) + vec2f(0.5)) / dims;
    return textureSampleLevel(sourceTextureSampler, sourceSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
}

fn samplePostProcessSource(uv: vec2f) -> vec4f {
    return textureSampleLevel(sourceTextureSampler, sourceSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
}

// user fragmentWGSL must define:
fn applyPostProcess(color: vec4f, uv: vec2f) -> vec4f;

@fragment
fn postProcessFragment(input: PostProcessVertexOutput) -> @location(0) vec4f {
    return applyPostProcess(samplePostProcessSource(input.uv), input.uv);
}
```

The black-and-white task declares a uniform degree and uses Babylon.js shader math:

```wgsl
let luminance = dot(color.rgb, vec3f(0.3, 0.59, 0.11));
let grayscale = vec3f(luminance);
return vec4f(mix(color.rgb, grayscale, clamp(params.degree, 0.0, 1.0)), color.a);
```

The current concrete post-processes mirror their Babylon.js thin post-process shader math:

- black-and-white mixes the source color with luminance by `degree`;
- anaglyph samples the configured left-eye texture and the source/right-eye texture and combines red/cyan channels;
- blur writes Babylon-style optimized Gaussian offsets/weights into uniforms and samples along `direction / textureDimensions(source)`;
- extract-highlights keeps source pixels whose exposure-scaled luminance is above `threshold^(1/2.2)` and blacks out the rest;
- chromatic aberration applies the Babylon radial channel offsets using `aberrationAmount`, `direction`, `radialIntensity`, `centerPosition`, and the source texture dimensions captured during `record()`.
- bloom is a composite task that records/executes four internal post-process passes: reusable extract-highlights, horizontal Gaussian blur, vertical Gaussian blur, and merge (`source.rgb + blurred.rgb * weight`). Its internal extract/blur render targets are sized to `floor(sourceSize * bloomScale)` on every record, and its `kernel` setter scales the internal blur kernels by `bloomScale`, matching Babylon.js frame-graph bloom.

## State Machine / Lifecycle

1. Caller creates an offscreen scene `RenderTask` or other producer whose target owns a color texture.
2. If the post-process chain owns the final swapchain write, caller creates the scene with `{ defaultRenderTask: false }` so the default `"scene"` swapchain render task does not draw the scene a second time.
3. Caller creates the post-process task with `sourceTexture` set to that producer target. If `targetTexture` is omitted, the task creates an internal color-only target using the source descriptor's format, sample count, and size.
4. Caller schedules tasks in order with `addTask(scene, producer)`, then `addTask(scene, postProcess)`, then any consumer/output task.
5. `FrameGraph.build()` calls the producer `record()` first, allocating source texture resources.
6. Post-process `record()` validates the source color texture, allocates/rebuilds the output target, creates the pipeline, bind group, and optional uniform buffer, initializes uniforms, and records no separate `Pass` because the task executes directly.
7. If a caller mutates exposed post-process parameters after recording, they call `updateUniforms()` to rewrite the task UBO before the next draw.
8. Each frame, `execute()` patches swapchain attachments if needed, applies viewport/scissor if requested, binds pipeline/group, and draws one full-screen triangle.
9. `dispose()` destroys the optional uniform buffer and disposes only the internally-owned target. Caller-owned `sourceTexture` and `targetTexture` lifetimes remain with their owners.

## Babylon.js Equivalence Map

| Babylon.js | Babylon Lite |
| --- | --- |
| `FrameGraphPostProcessTask` | `PostProcessTask` plain task record |
| `sourceTexture` handle | `RenderTarget` source with sampled color attachment |
| `targetTexture` handle | optional `RenderTarget` output |
| auto-created output texture | internal `RenderTarget` copied from source descriptor |
| `sourceSamplingMode` | `"nearest"` / `"linear"` sampler selection |
| `alphaMode` | numeric modes `0`, `1`, `2`, `7` mapped to WebGPU blend state |
| `viewport` | normalized viewport/scissor on the output pass |
| `ThinPostProcess` | not present; shader config is direct WGSL |
| `FrameGraphBlackAndWhiteTask` | `createBlackAndWhitePostProcessTask` |
| `FrameGraphAnaglyphTask` / `ThinAnaglyphPostProcess` | `createAnaglyphPostProcessTask` |
| `FrameGraphBlurTask` / `ThinBlurPostProcess` | `createBlurPostProcessTask` |
| `FrameGraphExtractHighlightsTask` / `ThinExtractHighlightsPostProcess` | `createExtractHighlightsPostProcessTask` |
| `FrameGraphChromaticAberrationTask` / `ThinChromaticAberrationPostProcess` | `createChromaticAberrationPostProcessTask` |
| `FrameGraphBloomTask` / `BloomEffect` | `createBloomPostProcessTask` |

## Dependencies

- `engine/engine.ts` for internal device/encoder/swapchain state;
- `engine/render-target.ts` for source/output target allocation and disposal;
- `resource/samplers.ts` for shared nearest/linear samplers;
- `scene/scene-core.ts` for task ownership;
- `camera/camera.ts` only for the public `NormalizedViewport` type.

## Test Specification

- Scene 142 renders a deterministic colored mesh scene into offscreen `RenderTarget`s, then writes four viewport quadrants with black-and-white, anaglyph, 128px blur, and chromatic aberration. The Babylon.js reference uses the matching Babylon post-process classes.
- Scene 143 renders Sponza through two 16px blur tasks (`direction=(1,0)` then `direction=(0,1)`) followed by chromatic aberration, demonstrating post-process pipelining through internally-created intermediate targets. The Babylon.js reference uses the matching camera-attached Babylon post-process classes.
- Scene 144 renders the Tarisland dragon asset from Babylon.js Playground `#SUEU9U#114`, freezes `Qishilong_attack01` at frame 180, and runs the composite bloom post-process with weight `2`, threshold `0.1`, kernel `64`, and bloom scale `0.5`. The Babylon.js reference uses `BloomEffect` through a `PostProcessRenderPipeline`.
- The parity spec `tests/parity/scenes/scene142-black-and-white-post-process.spec.ts` captures/uses `reference/scene142-post-process-viewports/babylon-ref-golden.png` and compares Lite output against `scene-config.json`.
- The parity spec `tests/parity/scenes/scene143-pipelined-post-processes.spec.ts` captures/uses `reference/scene143-pipelined-post-processes/babylon-ref-golden.png` and compares Lite output against `scene-config.json`.
- The parity spec `tests/parity/scenes/scene144-bloom-post-process.spec.ts` captures/uses `reference/scene144-bloom-post-process/babylon-ref-golden.png` and compares Lite output against `scene-config.json`.
- Bundle-size coverage adds Scene 142, Scene 143, and Scene 144 ceiling entries without changing existing ceilings.

## File Manifest

- `packages/babylon-lite/src/frame-graph/post-process-task.ts`
- `packages/babylon-lite/src/post-process/black-and-white.ts`
- `packages/babylon-lite/src/post-process/anaglyph.ts`
- `packages/babylon-lite/src/post-process/blur.ts`
- `packages/babylon-lite/src/post-process/extract-highlights.ts`
- `packages/babylon-lite/src/post-process/chromatic-aberration.ts`
- `packages/babylon-lite/src/post-process/bloom.ts`
- `docs/architecture/31-post-process.md`
- `lab/src/bjs/scene142.ts`
- `lab/src/lite/scene142.ts`
- `lab/src/bjs/scene143.ts`
- `lab/src/lite/scene143.ts`
- `lab/src/bjs/scene144.ts`
- `lab/src/lite/scene144.ts`
- `lab/babylon-ref-scene142.html`
- `lab/scene142.html`
- `lab/babylon-ref-scene143.html`
- `lab/scene143.html`
- `lab/babylon-ref-scene144.html`
- `lab/scene144.html`
- `tests/parity/scenes/scene142-black-and-white-post-process.spec.ts`
- `tests/parity/scenes/scene143-pipelined-post-processes.spec.ts`
- `tests/parity/scenes/scene144-bloom-post-process.spec.ts`
