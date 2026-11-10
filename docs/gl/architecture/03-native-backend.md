# Lite-GL — Babylon Native backend (`NativeEngineContextGL`)

> Package path: `packages/babylon-lite-gl/src/native/`
> Public entry: `@babylonjs/lite-gl/native` (barrel `src/index.native.ts`)
> Status: implemented (WebGL-host-verified via a mocked `_native`; on-device
> parity requires a Babylon Native host).

This backend lets **the same lite-gl renderers** — `effectRenderer`,
`spriteRenderer`, textures, meshes, render targets, blend/depth/stencil/scissor,
dynamic + HTML textures — run on **Babylon Native** (bgfx) instead of WebGL2. It
is a port of the `_native` command-stream usage found in Babylon.js's
`ThinNativeEngine` (`packages/dev/core/src/Engines/thinNativeEngine.pure.ts`),
kept dependency-free (no `@babylonjs/core`), mirroring the WebGL backend's stance.

---

## 1. Why a parallel module set (the trilemma)

With a single esbuild-bundled source you can hold only **two** of these three at
once:

1. **gl-free higher-level modules** (only a device layer touches the device),
2. **byte-identical WebGL** (the tracked WebGL scene bundles never grow),
3. **single source** (no module duplication).

A measured experiment (routing the WebGL `effect-renderer` through a shared
device-op layer) grew `gl-gradient` 11.4 → 11.7 KB — esbuild does **not** inline
cross-module wrappers. Because **byte-identical WebGL is a hard requirement**
(stricter than the `maxRawKB` ceilings), we sacrifice **#3**: the WebGL modules
are left untouched, and the native backend is a **parallel module set** selected
by **build-time aliasing**.

- WebGL consumers: `babylon-lite-gl` → `src/index.ts` (unchanged).
- Native consumers: alias `babylon-lite-gl` → `src/index.native.ts` (or import
  `@babylonjs/lite-gl/native`). A Babylon Native app builds against this entry.

The public API names/signatures are identical across both barrels (see §3 —
enforced by `tests/gl/unit/native-parity.test.ts`). Only engine CREATION genuinely
differs (native has no canvas): native app code calls `createGLEngine(null)` (the
canvas argument is ignored) or the native-only `createNativeGLEngine()`. Every
other function — including the WebGL-named lifecycle fns `disposeGLEngine` /
`resizeGLEngine` — has the WebGL receiver-first signature, so a consumer written
against the WebGL barrel (e.g. a shared effect base class) builds against the
native entry with **zero code changes** ("seamless"). Porting an app = flip the
`babylon-lite-gl` alias to `src/index.native.ts` (or use the `babylon-native`
export condition) and swap engine creation.

---

## 2. Command-stream model (vs WebGL immediate mode)

Babylon Native has **no WebGL context**. The JS side records tagged commands into
a `NativeDataStream` (a growable `Uint32Array` the host drains via `writeBuffer`),
and flushes them with `submitCommands`. A **command scope**
(`beginCommandScope`/`endCommandScope`) batches a whole frame and submits once;
outside a scope each command self-submits (mirroring `finishEncodingCommand`).

- `native-types.ts` — the `_native` bridge surface (a focused port of
  `nativeInterfaces.ts`): `INativeEngine`, the `COMMAND_*`/enum tables, handle
  aliases (`NativeData = Uint32Array`).
- `native-command-encoder.ts` — `NativeDataStream` + `CommandBufferEncoder`
  (faithful ports). The host requests a flush at submit via the constructor
  callback.
- `native-context.ts` — `NativeEngineContextGL` + `createNativeGLEngine`. Owns
  `_engine` (the `_native.Engine`), `_encoder`, `caps` (from native constants),
  `_state`, the effect/texture/render-target/buffer registries, and the
  device-restore path (via `setRenderResetCallback`).
- `native-device.ts` — the ONLY module that encodes commands. Every device
  operation (`dSetProgram`, `dDrawIndexed`, `dSetFloat4`, `dSetTexture`,
  `dSetViewport`, `dClear`, …) is a `d*` op here; the higher-level native modules
  call these, never `_native`/the encoder directly.
- `native-state.ts` / `native-apply-states.ts` — a decoupled copy of the WebGL
  `_state` cache + deferred-flush dispatcher (kept separate so the WebGL copy
  stays byte-identical). Compare-and-elide caching lives in the higher-level
  modules exactly as on WebGL, so both backends inherit the same elision.

The higher-level native modules (`native/effect.ts`, `effect-renderer.ts`,
`sprites.ts`, `texture.ts`, `mesh.ts`, `render-target.ts`, `blend.ts`,
`depth-stencil.ts`, `scissor.ts`, `dynamic-texture.ts`, `html-texture.ts`,
`render-loop.ts`) mirror their WebGL twins' public API + logic; allocation-free
CPU paths (e.g. the sprite vertex build) are copied verbatim.

---

## 3. Public-API parity

`src/index.native.ts` exports **every value and type name** of `src/index.ts`,
in the same order, with the WebGL **receiver-first** signatures (#820): resource
functions take the resource first and use its `_engine` back-pointer; the engine
is a parameter only for creators, engine-wide state/frame/loop functions and
unbinds (`unbindTexture(engine, unit)`, `unbindTexture3D`,
`restoreDefaultFramebuffer(engine)`). Native-only additions: `createNativeGLEngine`,
`disposeNativeGLEngine` and the `NativeCanvasSource` / `NativePixelSource` /
`NativeTextureSource` types.

Backend-specific type shapes (allow-listed and commented in the parity test):
`GLEngineContext` (`_native.Engine` + command encoder, `canvas: null`),
`GLEngineCaps` (adds the capability flags below), `GLEngineOptions`, and the
resource records that carry native handles (`GLTexture`, `GLTexture3D`,
`GLEffect`, `GLRenderTarget`, buffers/VAOs, sprite/effect wrappers). Signature
differences beyond those: `createGLEngine` also accepts `null`;
`createTextureFromHandle` wraps a native texture handle; the texture-source APIs
also accept `Native*Source`; and the two readbacks return a `Promise` (below).

### Capability flags (`engine.caps`)

| Flag              | Native value                                 | Meaning                                                                                                      |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `texture3D`       | `true` iff the host has `loadRawTexture3D`   | 3D volumes are uploaded through `loadRawTexture3D` (current Babylon Native); older hosts cannot create them. |
| `alphaToCoverage` | `false`                                      | No alpha-to-coverage render state in `NativeEngine`.                                                         |
| `separateStencil` | `false`                                      | `COMMAND_SETSTENCIL` has one op set for both faces.                                                          |
| `gpuFrameTime`    | `true` iff the host has `populateFrameStats` | GPU time comes from bgfx frame stats, not timer queries.                                                     |
| `textRendering`   | `false`                                      | The Slug text pipeline needs integer instanced attributes, which `NativeEngine` vertex arrays lack.          |

### Export classification

| Export group (WebGL module)                                                                                                                                                                                                                                                                     | Native status                                   | Behavior on Babylon Native                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context: `createGLEngine`, `disposeGLEngine`, `getRenderWidth/Height`, `get/setHardwareScalingLevel`, `on/offContextLost`, `on/offContextRestored`, `wipeGLStateCache`                                                                                                                          | Implemented                                     | Device restore (`setRenderResetCallback`) drives lost→restored; `wipeGLStateCache` resets the state cache.                                                                                                                                                 |
| Context: `resizeGLEngine`, `setGLEngineSize`                                                                                                                                                                                                                                                    | Implemented (host-managed)                      | Documented no-ops: the host owns and sizes the backbuffer; read the size via `getRenderWidth/Height`.                                                                                                                                                      |
| Context: `getRenderingCanvas`                                                                                                                                                                                                                                                                   | **Divergence**                                  | Throws `lite-gl: getRenderingCanvas is not supported on Babylon Native …` (`engine.canvas` is `null`).                                                                                                                                                     |
| Render loop: `runRenderLoop`, `stopRenderLoop`, `beginFrame`, `endFrame`                                                                                                                                                                                                                        | Implemented                                     | Native `requestAnimationFrame`; frame hooks as on WebGL.                                                                                                                                                                                                   |
| GPU frame time: `captureGPUFrameTime`, `getGPUFrameTimeCounter`                                                                                                                                                                                                                                 | Implemented (`caps.gpuFrameTime`)               | Samples `populateFrameStats().gpuTimeNs` at `endFrame`; silent no-op without it.                                                                                                                                                                           |
| Alpha-to-coverage: `setAlphaToCoverage`, `getAlphaToCoverage`, `getCurrentSampleCount`                                                                                                                                                                                                          | **Divergence** (`caps.alphaToCoverage`)         | `set…(true)` throws, `set…(false)` no-ops; getters return `false` / `1`.                                                                                                                                                                                   |
| Effects: `createEffect` … `setEffect*`, `getEffectCompilationError`, `executeWhenCompiled`                                                                                                                                                                                                      | Implemented                                     | Non-blocking `createProgramAsync`; compile errors are recorded (never thrown) and reported by `getEffectCompilationError`.                                                                                                                                 |
| `waitForEffect` (`effect-ready`)                                                                                                                                                                                                                                                                | Implemented                                     | Polls on the native `requestAnimationFrame` (fallback `setTimeout`); `AbortError` falls back to a plain `Error` when `DOMException` is missing.                                                                                                            |
| Effect renderer: `createEffectWrapper`, `applyEffectWrapper`, `drawEffect`, `setViewport`, `disposeEffectWrapper`                                                                                                                                                                               | Implemented                                     | Viewports are normalized (0–1) by the bound render target (else backbuffer) size.                                                                                                                                                                          |
| Textures: `createRawTexture`, `createFloatTexture`, `loadTexture2D`, `bind/unbindTexture`, `disposeTexture`, `updateRawTexture`, `updateTextureSamplingMode/Preset/WrapMode`, `createTextureFromHandle`, `generateTextureMipMaps`, `isTextureReady`, `getSamplingModeFilters`, `GLSamplingMode` | Implemented                                     | Emulated units (sampler uniforms). Mips: intent retained, chain rebuilt by re-upload (no `generateMipmap`). `getSamplingModeFilters`/`GLSamplingMode` are reused from the WebGL module (pure).                                                             |
| `createTextureFromSource`                                                                                                                                                                                                                                                                       | Implemented                                     | `NativePixelSource` (e.g. `createImageBitmap`) or `NativeCanvasSource`; DOM sources throw.                                                                                                                                                                 |
| Dynamic / HTML textures                                                                                                                                                                                                                                                                         | Implemented                                     | Native canvas (`COPYTEXTURE`) or pixel sources; DOM elements throw.                                                                                                                                                                                        |
| 3D textures (`texture-3d`)                                                                                                                                                                                                                                                                      | Implemented (`caps.texture3D`)                  | Uploaded via `loadRawTexture3D`; bound/sampled like 2D textures. No sRGB volumes and no 3D mips (`generateTexture3DMipMaps` throws). Without the host method, creation throws; `unbindTexture3D`, `disposeTexture3D`, `setEffectTexture3D(…, null)` no-op. |
| Render targets: create/bind/`restoreDefaultFramebuffer`/resize/dispose                                                                                                                                                                                                                          | Implemented                                     | Depth/stencil baked at framebuffer creation; viewport + scissor re-issued per framebuffer.                                                                                                                                                                 |
| `generateRenderTargetMipMaps`                                                                                                                                                                                                                                                                   | Implemented (host-dependent)                    | With `COMMAND_GENERATEMIPMAPS`, the first call re-allocates the color texture with a mip chain (contents copied, framebuffer rebuilt), then the host regenerates the chain; no-op on older hosts and for a bring-your-own `colorTexture`.                  |
| `readRenderTargetPixels`, `readRenderTargetPixelsToBuffer`                                                                                                                                                                                                                                      | Implemented (**async**)                         | Return a `Promise`; float targets read at full precision through `readTexture2` (older hosts: RGBA8, 8-bit precision); `…ToBuffer` writes CPU `ArrayBuffer`/views (a `WebGLBuffer` rejects).                                                               |
| Mesh: buffers, VAOs, `drawIndexed`, `drawMesh`, instancing                                                                                                                                                                                                                                      | Implemented                                     | Attributes recorded into native VAOs (float attributes).                                                                                                                                                                                                   |
| Blend: `setBlendMode`, `setBlendState`, `disableBlend`, enums                                                                                                                                                                                                                                   | Implemented                                     | Factors map to the exact host `ALPHA_*` preset when one exists, else the preset with the same RGB factors; equations map to `COMMAND_SETBLENDEQUATION` when the host has it (separate RGB/alpha equations other than MIN+ADD → `DARKEN` use the RGB one).  |
| Depth/stencil: `setDepthState`, `setCullState`, `setStencilState`, `setColorMask`, `clearEngine`, `generateRenderTargetStencil`                                                                                                                                                                 | Implemented                                     | Depth `func` mapped to `DEPTH_TEST_*`; stencil `funcMask` sent through `COMMAND_SETSTENCIL2` (older hosts: read mask 0xFF); partial color masks are all-or-nothing; stencil attachments are D24S8.                                                         |
| `setStencilOpSeparate`                                                                                                                                                                                                                                                                          | **Partial divergence** (`caps.separateStencil`) | `FRONT_AND_BACK` or identical faces use the single op set; differing faces throw at the next flush (draw/clear) while the stencil test is on.                                                                                                              |
| Scissor: `setScissor`, `disableScissor`                                                                                                                                                                                                                                                         | Implemented                                     | Carried across framebuffer switches (the host stores it per framebuffer).                                                                                                                                                                                  |
| Sprites                                                                                                                                                                                                                                                                                         | Implemented                                     | Same CPU vertex build as WebGL.                                                                                                                                                                                                                            |
| Text: `loadFont`, `createFontFromBuffer`, `extractGlyphCurves`, `cubicToQuadratics`, `createTextLayer`, `setTextLayerPosition`                                                                                                                                                                  | Implemented                                     | Pure CPU helpers (font/glyph modules reused from the WebGL text stack).                                                                                                                                                                                    |
| Text: glyph storage, text data, default text data, `setFontWeightOffset`, text renderer                                                                                                                                                                                                         | **Divergence** (`caps.textRendering`)           | Creators/updaters/`renderText`/`addTextRendererLayer`/`registerTextRenderer` throw; `dispose*`/`unregisterTextRenderer` no-op; `isTextRendererReady`/`removeTextRendererLayer` return `false`.                                                             |

Newer host features (`readTexture2`, `loadRawTexture3D`, `COMMAND_SETSTENCIL2`,
`COMMAND_SETBLENDEQUATION`, `COMMAND_GENERATEMIPMAPS`, the `ALPHA_ONEONE_ONEONE` /
`ALPHA_LAYER_ACCUMULATE` presets) are feature-detected, so one bundle runs on
both older hosts and current Babylon Native.

Every divergence error reads `lite-gl: <fn> is not supported on Babylon Native …`.
Divergence code lives in modules named after their WebGL twins
(`native/texture-3d.ts`, `native/alpha-to-coverage.ts`, `native/text.ts`), so it
tree-shakes out when unused.

### Other Native limitations (documented at each call site)

- **Texture binding** — a texture binds to a sampler **uniform**
  (`COMMAND_SETTEXTURE`), not a numbered unit; units are emulated per program.
- **Uploads** need a host built with `LOAD_IMAGES` (`loadRawTexture`,
  `loadTexture`, `createImageBitmap`, and readback format conversion).
  `loadTexture2D` uses `fetch` (polyfilled by JsRuntimeHost).
- **Readback row order / origin** match WebGL (bottom-up rows, `y` from the
  bottom) on current hosts; older hosts return the texture memory layout.
- **Implicit framebuffer completeness** — no `checkFramebufferStatus`;
  `createFrameBuffer` succeeds or the host errors.
- **Immediate deletes** — `deleteTexture` is not deferred by the host, so pending
  commands are submitted before a texture is deleted.

---

## 4. Tests

`tests/gl/unit/_native-mock.ts` mocks the `_native` global: it records engine
method calls and captures the raw uint32 words flushed through the command stream
(command tags are distinct sentinels). `tests/gl/unit/native-core.test.ts`
asserts the effect-renderer + sprites + state command encodings (async compile →
`getUniforms`/`getAttributes`, program-bind caching, the 6-attribute sprite VAO,
`SETMATRICES`/`SETTEXTURE`/`SETBLENDMODE`/`DRAWINDEXED`, scissor/clear/blend
elision, `#define SHADER_NAME` placement, viewport normalization, default render
state, the `_nativeDataStream` host ABI, DOM-less safety).
`tests/gl/unit/native-api.test.ts` covers the receiver-first API (resource →
engine routing, split bind/unbind, mip intent, non-blocking compile +
`waitForEffect`, readback, `setGLEngineSize`, `wipeGLStateCache`, GPU frame time,
depth func, scissor carry-over), every declared divergence, and — with
`createMockNative({ host: "current" })` — the feature-detected host additions
(exact blend presets + equations, stencil func mask, render-target mips, float
readback, 3D textures).
`tests/gl/unit/native-parity.test.ts` is the parity guard: identical runtime
value names, identical type-level export names, and per-function parameter
names/order/optionality plus mutually assignable types (TypeScript compiler API),
with a commented allow-list for backend-specific types. All run in the `gl-unit`
Vitest project alongside the WebGL suites.

On-device parity (byte-identical pixels vs WebGL) can only be validated inside a
Babylon Native host and is left as follow-up.

---

## 5. Build / packaging

- `package.json` exposes `"./native"` in both the dev `exports` and
  `publishConfig.exports`; `build.mjs` writes the same into the published
  `dist/package.json`. The plain-`tsc` build emits `dist/index.native.js` +
  `dist/native/*.js` (+ trimmed `.d.ts`).
- The WebGL bundle-size test (`tests/gl/build/bundle-size.test.ts`) confirms the
  WebGL scenes are unchanged — the native files are never imported by a WebGL
  scene, so every ceiling stays byte-identical.
