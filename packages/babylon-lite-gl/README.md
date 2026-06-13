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
import {
    createGLEngine,
    createEffectWrapper,
    isEffectReady,
    applyEffectWrapper,
    drawEffect,
    setViewport,
    setEffectFloat,
    runRenderLoop,
    resizeGLEngine,
} from "@babylonjs/lite-gl";

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

## Entry points

The full public API is available from the main `@babylonjs/lite-gl` barrel.
`/sprites` and `/html-texture` are **also** exposed as dedicated sub-entries for
consumers who prefer an explicit import — the package is `sideEffects: false`, so
a bundler tree-shakes away whichever features you don't use no matter which path
you import from.

| Import | Provides |
| --- | --- |
| `@babylonjs/lite-gl` | Everything: engine + render loop, effects & uniform setters, textures, the `EffectWrapper` fullscreen-quad renderer, blend modes, the sprite renderer, and HTML-element textures. |
| `@babylonjs/lite-gl/sprites` | Just the sprite / instanced-quad renderer (`createSpriteRenderer`, `renderSprites`, `setSpriteRendererTexture`, `disposeSpriteRenderer`, `GLSprite`) — the lite-gl equivalent of Babylon's `SpriteRenderer`. |
| `@babylonjs/lite-gl/html-texture` | Just textures backed by a `<canvas>` / `<img>` / `<video>` element (`createHtmlElementTexture`, `updateHtmlElementTexture`, `GLSamplingMode`). |

### Core API (`@babylonjs/lite-gl`)

- **Engine / lifecycle** — `createGLEngine`, `disposeGLEngine`, `resizeGLEngine`,
  `getRenderWidth`, `getRenderHeight`, `get/setHardwareScalingLevel`,
  `getRenderingCanvas`, and `on/offContextLost` + `on/offContextRestored`
  (context-loss is handled: effects and textures are rebuilt on restore).
- **Render loop** — `runRenderLoop`, `stopRenderLoop`.
- **Effects** — `createEffect`, `isEffectReady`, `executeWhenCompiled`,
  `useEffect`, `disposeEffect`, and the cached uniform setters
  `setEffectFloat` / `…Float2` / `…Float3` / `…Float4` / `…Int` /
  `…Color3` / `…Color4` / `…Texture`.
- **Fullscreen renderer** — `createEffectWrapper`, `applyEffectWrapper`,
  `drawEffect`, `setViewport`, `disposeEffectWrapper`.
- **Textures** — `createRawTexture` (typed-array upload), `loadTexture2D`
  (async URL upload with a 1×1 placeholder), `bindTexture`, `disposeTexture`.
- **Blend** — `setBlendMode` + `GLBlendMode` (`DISABLE` / `ADD` / `ALPHA` /
  `PREMULTIPLIED`), matching Babylon's `setAlphaMode` parameters.

## Demos

Runnable scenes for every feature live in the repo's GL **lab**
(`lab/gl/`) — fullscreen effects, textures, sprites, blend modes and
HTML-element textures.

## License

Apache-2.0
