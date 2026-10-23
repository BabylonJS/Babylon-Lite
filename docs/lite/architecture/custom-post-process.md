# Module: Custom post-process

> Package path: `packages/babylon-lite/src/post-process/custom.ts`

## Purpose and public API

A public, opt-in adapter over the [post-process task](29-post-process.md) for app-defined fullscreen color passes. Import from `@babylonjs/lite`; no package subpath or GPU attachment access is needed.

```ts
export interface CustomPostProcessTaskConfig extends PostProcessTaskSettings {
    fragmentWGSL: WgslSource;
    uniformWGSL?: WgslSource;
    uniformByteLength?: number;
    writeUniforms?: (data: Float32Array) => void;
    extraTextureWGSL?: WgslSource;
    extraTextures?: readonly RenderTarget[];
}
export function createCustomPostProcessTask(config: CustomPostProcessTaskConfig, engine: EngineContext, scene?: SceneContext): PostProcessTask;
```

`WgslSource` is the source returned by the public `wgsl` tag. `PostProcessTaskSettings` supplies `name`, `sourceTexture`, `targetTexture`, `sourceSamplingMode`, `alphaMode`, `viewport`, and `clear`, with the same defaults as built-in post-processes. The returned task is the existing `PostProcessTask`, including `outputTexture` and `updateUniforms()`.

## Shader and binding contract

- Supply `fn applyPostProcess(color: vec4f, uv: vec2f) -> vec4f` in `fragmentWGSL`; the helper supplies the vertex stage and fragment entry point.
- `color` is the primary source sample. UVs are normalized, with V increasing down the source image; no additional render-target flip is needed.
- Group 0 / binding 0 is `sourceSampler`, binding 1 is `sourceTextureSampler`. `samplePostProcessSource(uv)` and `readPostProcessSource(uv)` are available with the semantics in the shared specification.
- `extraTextures[i]` uses binding `2+i`; declare each `texture_2d<f32>` in `extraTextureWGSL`. All color inputs must be filterable, single-sampled 2D targets with texture-binding usage. Resolve multisampled/depth inputs separately.
- When `uniformByteLength > 0`, the uniform binding is `2 + extraTextures.length` (2 with no extras). Declare the matching uniform block in `uniformWGSL`.
- Uniform allocation rounds up to 16 bytes. `writeUniforms` receives zero-filled, reusable float storage during recording and `task.updateUniforms()`; mutate captured state, then call that method to upload new values. WGSL struct layout and payload sizes are the caller's responsibility.
- Shader source, uniform layout and extra-input count are fixed for the task's lifetime. No shader parsing, new GPU caches or import-time registration is added.

## Lifecycle and ownership

1. Create source producers and this task; schedule every source/extra-input producer before the custom task with `addTask`.
2. Graph build records producers first, then the shared helper binds their current color sampling views (full mip chain when available). Unallocated or multisampled primary sources fail through the helper's existing diagnostics.
3. A supplied `targetTexture` is borrowed. Without it, the helper creates a single-sample output with the source's format and size descriptor.
4. Rebuild the frame graph after resize, source/target changes or attachment replacement so bindings use current producer views. Registered scene/standalone frame-graph resize handling performs its normal rebuild.
5. Execute uses the existing fullscreen triangle, sampler filter, viewport/scissor, blend and clear path; it adds no allocations or bindings per frame.
6. Stop executing a task before disposing it. Disposal releases its uniform buffer and internally created output, preserving all source/extra targets and a caller-supplied output. Caller owns those resources and their producer lifetimes. No feedback loop may sample an attachment being written by the same pass.

## Example: merge two images

```ts
const merge = createCustomPostProcessTask(
    {
        sourceTexture: blurA.outputTexture,
        extraTextures: [blurB.outputTexture],
        targetTexture: surface.scRT,
        alphaMode: 1,
        clear: false,
        extraTextureWGSL: wgsl`@group(0) @binding(2) var second: texture_2d<f32>;`,
        uniformWGSL: wgsl`@group(0) @binding(3) var<uniform> intensity: vec4f;`,
        uniformByteLength: 16,
        writeUniforms: (data) => {
            data[0] = settings.intensity;
        },
        fragmentWGSL: wgsl`fn applyPostProcess(c:vec4f,uv:vec2f)->vec4f {
        let rgb = (c.rgb + textureSample(second,sourceSampler,uv).rgb) * intensity.x;
        return vec4f(rgb,1);
    }`,
    },
    engine,
    scene
);
addTask(scene, merge); // after both blur producers
```

## Equivalence, dependencies and tests

This is the native fullscreen customization seam requested in #826/#751, not a `GlowLayer` or `SSAO2RenderingPipeline` wrapper. It delegates to `frame-graph/post-process-task.ts`; shader math, pipeline construction, Y orientation and render-target lifecycle are unchanged.

Tests cover producer-first allocation and resize rebinding, additional inputs and uniform slots, explicit uniform updates, borrowed versus owned output disposal, and the unchanged allocation-free execute path. A strict consumer compiles against the emitted root declaration; tree-shaking checks keep unused custom code out of unrelated bundles. Focused scene bundle controls preserve existing ceilings.

File manifest: `post-process/custom.ts`, root `index.ts`, focused unit/build tests, this specification and the shared post-process specification.
