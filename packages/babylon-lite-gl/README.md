# @babylonjs/lite-gl

A tiny, **function-based, tree-shakeable WebGL2 micro-engine** for fullscreen
shader effects, sprites and dynamic textures — the WebGL counterpart of
[`@babylonjs/lite`](https://github.com/BabylonJS/Babylon-Lite). No classes, no
scene graph: you call plain functions against an opaque `GLEngineContext`, so a
bundler keeps only what you import.

It is a focused subset of Babylon.js' rendering primitives, validated to render
**near-identically** (within ±1–2 LSB ANGLE / SwiftShader codegen noise) to
Babylon's `ThinEngine` / `EffectRenderer` / `SpriteRenderer` / `HtmlElementTexture`
path — every feature has a side-by-side parity scene in `tests/gl/parity/` (and,
downstream, the NeonBrush effect suite). Swapping `@babylonjs/core` for lite-gl
typically shrinks an effect's shipped bundle **~10–16×** (≈4–6 KB gzip vs
≈40–80 KB).

> **WebGL2 only.** The context is created with `canvas.getContext("webgl2")`.

## Install

```bash
npm install @babylonjs/lite-gl
```

## Quick start — an animated fullscreen effect

```ts
import { createGLEngine, createEffectWrapper, isEffectReady, applyEffectWrapper, drawEffect, setViewport, setEffectFloat, runRenderLoop, resizeGLEngine } from "@babylonjs/lite-gl";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = createGLEngine(canvas, { alpha: false });

// The wrapper compiles + owns the effect. `vertexSource` defaults to a built-in
// fullscreen-quad shader (exposing a `vUv` varying), so only `fragmentSource`
// is required.
const wrapper = createEffectWrapper(engine, {
    name: "gradient",
    fragmentSource: `#version 300 es
        precision highp float;
        in vec2 vUv;
        out vec4 glFragColor;
        uniform float uTime;
        void main() {
            glFragColor = vec4(0.5 + 0.5 * cos(uTime + vUv.xyx + vec3(0.0, 2.0, 4.0)), 1.0);
        }`,
    uniformNames: ["uTime"],
});

const start = performance.now();
runRenderLoop(engine, () => {
    if (!isEffectReady(engine, wrapper.effect)) return; // shaders compile async
    resizeGLEngine(engine);
    setViewport(engine);
    applyEffectWrapper(wrapper);
    setEffectFloat(engine, wrapper.effect, "uTime", (performance.now() - start) / 1000);
    drawEffect(engine);
});
```

## Effect readiness and errors

`createEffect` / `createEffectWrapper` submit compilation and linking without
querying their results. With `KHR_parallel_shader_compile`, readiness checks
poll completion before inspecting link status. Shader status and info logs are
queried only after link failure, avoiding premature compilation stalls.
Without the extension, checking link status can block.

Manual polling stays available: call `isEffectReady(engine, effect)` in your
render loop and inspect `getEffectCompilationError(engine, effect)` when it
returns false. The error accessor also polls once; `null` means no failure has
been recorded, not necessarily that the effect is ready. Errors include the
program log and failing shader stages' logs and are logged once. Neither this
accessor nor `executeWhenCompiled` starts automatic polling.

To wait before starting a render loop, opt into the tree-shakeable helper:

```ts
import { waitForEffect } from "@babylonjs/lite-gl";

const controller = new AbortController();
try {
    await waitForEffect(engine, wrapper.effect, { signal: controller.signal });
    // The effect is finalized; rendering can now start.
} catch (error) {
    console.error("Effect could not become ready:", error);
}
```

The helper polls once per animation frame without registering a render loop.
It rejects on compile/link/restore failure, context loss, disposal (on the next
poll), or cancellation via `controller.abort()`, and cleans up its frame and
listeners on every exit. Cancelling a wait does not dispose a shared effect.
After context restoration, call it again to wait for the replacement program.
Already ready effects resolve without scheduling a frame; consumers that only
use manual polling ship none of the helper's scheduling code.

**Migration:** shader syntax errors no longer throw synchronously from
`createEffect` or `createEffectWrapper`. Poll `isEffectReady` and inspect
`getEffectCompilationError`, or catch a rejected `waitForEffect` promise instead.
For wrappers, pass `wrapper.effect` to these readiness/error APIs.
Shader/program allocation failures still throw synchronously.

## Entry points

The entire public API is available from the single `@babylonjs/lite-gl` entry:
engine + render loop, effects & uniform setters, textures (incl. float / HDR +
dynamic), the `EffectWrapper` fullscreen-quad renderer, render targets, meshes /
vertex-index buffers + instancing, depth / stencil / color-mask / clear, scissor,
blend modes, the sprite renderer, and HTML-element textures. The package is
`sideEffects: false`, so a bundler tree-shakes away whichever features you don't
use.

### Core API (`@babylonjs/lite-gl`)

- **Engine / lifecycle** — `createGLEngine`, `disposeGLEngine`, `resizeGLEngine`,
  `getRenderWidth`, `getRenderHeight`, `get/setHardwareScalingLevel`,
  `getRenderingCanvas`, and `on/offContextLost` + `on/offContextRestored`
  (context-loss is handled: effects and textures are rebuilt on restore).
- **Render loop** — `runRenderLoop`, `stopRenderLoop`.
- **Effects** — `createEffect`, `isEffectReady`, `getEffectCompilationError`,
  `executeWhenCompiled`, `waitForEffect` (optional cancellable readiness promise),
  `useEffect`, `disposeEffect`, and the cached uniform setters
  `setEffectFloat` / `…Float2` / `…Float3` / `…Float4` / `…Int` /
  `…Color3` / `…Color4` / `…Texture`.
- **Fullscreen renderer** — `createEffectWrapper`, `applyEffectWrapper`,
  `drawEffect`, `setViewport`, `disposeEffectWrapper`.
- **Textures** — `createRawTexture` (typed-array upload, LDR byte formats),
  `createTextureFromSource` (single upload from already-decoded bitmaps/canvases/images),
  `createTexture3DFromPixels` + `setEffectTexture3D` (optional native RGBA8
  LUT volumes with trilinear sampling and zero 2D-only bundle cost),
  `createFloatTexture` (float / half-float HDR opt-in), `generateTextureMipMaps`,
  `loadTexture2D` (async URL upload with a 1×1 placeholder), `bindTexture`,
  `disposeTexture`, plus `updateRawTexture`, `updateTextureSamplingMode`,
  `updateTextureWrapMode`, `createTextureFromHandle`.
- **Dynamic textures** — `createDynamicTexture`, `updateDynamicTexture`,
  `clearDynamicTextureSource` (the retained source is replayed on context-restore).
- **Render targets** — `createRenderTarget` (RGBA8 FBO with a sampleable color
  `GLTexture` + optional depth / stencil renderbuffer), `createFloatRenderTarget`
  (float / half-float HDR opt-in), `bindRenderTarget` (cached, null = the canvas),
  `resizeRenderTarget`, `generateRenderTargetMipMaps`, `readRenderTargetPixels`,
  `disposeRenderTarget`.
- **Meshes / buffers** — `createVertexBuffer`, `updateVertexBuffer`,
  `createIndexBuffer`, `bindAttributes`, `drawIndexed` (instanced), `disposeBuffer`.
- **Depth / stencil / scissor** — `setDepthState`, `setStencilState`,
  `setStencilOpSeparate` (independent front/back operations), `setCullState`,
  `setColorMask`, `clearEngine`; `setScissor`, `disableScissor`.
- **Blend** — `setBlendMode` + `GLBlendMode` (`DISABLE` / `ADD` / `ALPHA` /
  `PREMULTIPLIED`), matching Babylon's `setAlphaMode` parameters.

### Already-decoded textures

```ts
import { createTextureFromSource, disposeTexture } from "@babylonjs/lite-gl";

const texture = createTextureFromSource(engine, bitmap);
// One texImage2D upload, linear filtering and clamp-to-edge by default.
// Later, release the GPU resource:
disposeTexture(engine, texture);
```

The factory accepts `TexImageSource` (including `ImageBitmap`, `ImageData`,
canvas/offscreen canvas, decoded images, video and video frames), derives the
intrinsic size, and performs no placeholder or blank allocation first.
`GLTextureSourceOptions` configures filtering/wrapping and unpack flags.
For `ImageBitmap`, WebGL ignores unpack flip/premultiplication; choose those
settings during decoding instead. Convert SVG or density-selected (`srcset`)
images to an `ImageBitmap` first, since WebGL may upload them at a size other
than their natural size.

Sources are retained for automatic context restoration by default, so keep
retained bitmaps/frames open while their texture is live. Pass
`{ retainSource: false }` when your application owns recovery: the source
reference is dropped after upload and can be closed, but context restoration
produces a ready, transparent-black texture at the original size. Recreate
the texture after restore (for example from `onContextRestored`) to recover its
content. Mutable retained sources replay their current pixels and intrinsic
size. If a retained source was closed anyway, restore logs an error and falls
back to transparent black for that texture only. Mipmaps generated with
`generateTextureMipMaps` are not replayed; regenerate them after restore. No
source is closed by lite-gl.

## Demos

Runnable scenes for every feature live in the repo's GL **lab**
(`lab/gl/`) — fullscreen effects, textures, sprites, blend modes,
HTML-element textures and render-to-texture round-trips. The standalone
`/gl/texture-3d-test.html` source test (`lab/gl/src/texture-3d-test.ts`) checks
native 3D texel addressing and trilinear filtering without a gallery demo.

## License

Apache-2.0
