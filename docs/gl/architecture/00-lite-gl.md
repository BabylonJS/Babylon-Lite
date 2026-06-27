# Module: Lite-GL (WebGL2 sibling package)

> Package path: `packages/babylon-lite-gl/src/`
> Package name: `@babylonjs/lite-gl`
> Status: implemented - `packages/babylon-lite-gl` (productized from the original draft).

> **Productization map (as-built).** This document is the original one-shot
> design spec; some §12 / §14 paths describe the planned layout. As shipped in
> this repo:
>
> - **Package:** `packages/babylon-lite-gl/` (src, `package.json`, `build.mjs`,
>   `tsconfig.json`). Published as `@babylonjs/lite-gl` — a single public entry
>   (the barrel). The plain-`tsc` build emits trimmed public `.d.ts` (all
>   `@internal` members stripped via `stripInternal`, mirroring `babylon-lite`).
> - **Unit tests:** `tests/gl/unit/` (`render-loop.test.ts`, `cache.test.ts`,
>   `_lite-gl-mock.ts`) — run via the `gl-unit` Vitest project
>   (`pnpm test:unit:gl`). There is no in-package `test/` folder.
> - **Lab:** `lab/gl/` (WebGL experience), selected by the lab experience toggle.
> - **Docs:** this file, `docs/gl/architecture/00-lite-gl.md`.

---

## 0. Pillar reconciliation

`GUIDANCE.md` pillar #1 says _"WebGPU Exclusive — zero WebGL fallback."_
This package is an **explicit, scoped carve-out** of that pillar, justified by:

1. It is a **separate package** (`packages/babylon-lite-gl/`). The `babylon-lite` package itself remains 100% WebGPU. The two packages never import each other.
2. It exists for a **single external consumer** (Microsoft NeonBrush) which is locked to WebGL today and pulls ~120–150 KB of `@babylonjs/core` for a tiny surface. Replacing that with a ~10–12 KB function-only package is the same "slim, not dumb" reduction the Lite pillars exist to deliver — applied to a different backend.
3. Every other pillar still applies, verbatim: pure-state interfaces, free functions, tree-shakable, zero module-level side effects, no class hierarchies, no abstraction over WebGL1, branchless hot paths via cached state, lazy-init caches owned by the context.

If the rule "no WebGL ever" is preferred, do not merge this doc — the scope dies cleanly with zero impact on the WebGPU core.

---

## 1. Purpose

Provide a minimal, function-only, tree-shakable WebGL2 runtime that re-implements the subset of Babylon.js `ThinEngine` + `Effect` + `EffectWrapper` + `EffectRenderer` + `ThinTexture` actually used by the NeonBrush family of fullscreen-quad effects (Cloth, Orb, Scan, InputGlow, Progressive / RockSteady / Magic loading screens, except the magic-particles sprite path).

Non-goals:

- No WebGL1 path.
- No scene graph, no materials, no meshes, no skinning, no PBR.
- Render-to-texture is available from the barrel (§3.8): RGBA8 (or a bring-your-own `colorTexture`, e.g. a float/half-float HDR target), optional core depth, opt-in stencil (`generateRenderTargetStencil`) and mipmap (`generateRenderTargetMipMaps`) helpers and `readPixels` readback. No MRT (multiple render targets). Core effects render to the canvas by default.
- No `SpriteRenderer` / `ThinSprite` in v1 (deferred; the magic loading screen keeps stock Babylon until v2).
- No runtime shader preprocessor (`attribute`→`in` etc.). Consumers ship GLSL ES 3.00.
- No shader-store, no `#include`, no observables, no engine-level customization extension points.
- No GPU resource pool. The browser owns lifetimes; we own caches.

---

## 2. Pillars (inherited from `babylon-lite`)

- **Pure state interfaces.** `GLEngineContext`, `GLEffect`, `GLTexture`, `GLEffectWrapper` are plain data. Behaviour is provided by standalone functions accepting the state as the first argument.
- **No classes.** No `class` keyword anywhere in the package source.
- **Tree-shakable.** Every setter, every loader, every helper is its own `export`. Unused symbols disappear from final bundles.
- **Zero module-level side effects.** No top-level `new Map()`, `new WeakMap()`, `new Set()`. Caches live on `engine._state`; the single per-package lazy resource (fullscreen quad) is created on first `applyEffectWrapper` and stored on the context, never as a module-scoped allocation. `sideEffects: false` in `package.json`.
- **One-way data ownership.** `GLEngineContext` owns `GLState`. `GLEffect`s and `GLTexture`s do not reference the context; functions take both explicitly. Effects do not know about wrappers; wrappers reference effects but only as plain data.
- **Branchless hot path.** Each cached setter has the shape _(equality check → early return)_ before any GL call. No `if (option) doExtra()` style branches in per-frame code.
- **No abstraction layers.** WebGL2 directly, no facade pattern, no enums, no constants table — we use `gl.TRIANGLES`, `gl.UNSIGNED_SHORT`, etc. directly.

---

## 3. Public API Surface

All signatures are final. Exhaustive — these are the only exports.

### 3.0 Naming & API-shape conventions

These rules keep `@babylonjs/lite-gl` legible to anyone who knows
`@babylonjs/lite` (the WebGPU core), while staying unambiguous when both
packages are imported together (as NeonBrush does).

1. **`GL` type prefix (mandatory).** Every exported _type_ is prefixed `GL`:
   `GLEngineContext`, `GLEngineOptions`, `GLEngineCaps`, `GLEffect`,
   `GLEffectOptions`, `GLEffectWrapper`, `GLEffectWrapperOptions`, `GLTexture`,
   `GLTextureOptions`, `GLViewport`, `GLSamplingMode`,
   `GLHtmlElementTextureOptions`. The prefix prevents clashes with lite's
   unprefixed `EngineContext` / `EffectWrapper` / … and signals "WebGL backend".

2. **Mirror lite's shape when possible.** Same functional style (free functions
   over an opaque handle — never classes), the same root nouns and verbs as
   lite-core, and the engine handle is always the **first** parameter, named
   `engine`. Lifecycle verbs track lite one-for-one:

    | lite-core (`@babylonjs/lite`)          | lite-gl (`@babylonjs/lite-gl`)         |
    | -------------------------------------- | -------------------------------------- |
    | `EngineContext`                        | `GLEngineContext`                      |
    | `EngineOptions`                        | `GLEngineOptions`                      |
    | `createEngine(canvas, options)`        | `createGLEngine(canvas, options)`      |
    | `disposeEngine(engine)`                | `disposeGLEngine(engine)`              |
    | `resizeEngine(engine)`                 | `resizeGLEngine(engine)`               |
    | `EffectWrapper`                        | `GLEffectWrapper`                      |
    | `createEffectWrapper(engine, options)` | `createEffectWrapper(engine, options)` |
    | `disposeEffectWrapper(wrapper)`        | `disposeEffectWrapper(wrapper)`        |

    Wrappers take **shader source** and compile + own their effect (like lite),
    and retain the engine they were created for (internal `_engine`), so
    `disposeEffectWrapper` and `applyEffectWrapper` take **only the wrapper** —
    exactly like lite.

3. **Documented divergences (backend-driven, not inconsistencies).**
    - `createGLEngine` is **synchronous** — WebGL2 context acquisition is sync,
      whereas lite's `createEngine` is `async` (WebGPU device request).
    - Uniforms are set **per-call** (`setEffectFloat/2/3/4`, `setEffectColor3/4`,
      `setEffectInt`) rather than via lite's UBO-block `setEffectUniforms` —
      WebGL2 has no equivalent ergonomic UBO path for these tiny effects.
    - **No `RenderingContext` / frame-graph / registration layer.** lite's
      `EffectRenderer` is a registerable rendering context; lite-gl instead
      exposes the lower-level `applyEffectWrapper(wrapper)` + `drawEffect(engine)`
      primitives, and the fullscreen quad is a context-owned lazy resource.

4. **The barrel re-exports explicitly — never `export *`.** `src/index.ts`
   re-exports the public API by name (`export { … } from "./mod.js"` for values,
   `export type { … }` for types — the latter required by `isolatedModules`),
   grouped by module with section comments, exactly like `@babylonjs/lite`'s
   `index.ts`. This keeps the public surface intentional and reviewable, and keeps
   internal helpers (e.g. `bindTextureRaw`, `bindTextureForUpload`) out of the
   barrel and the published `.d.ts`. The html-texture and sprites features
   are re-exported from the index barrel — because the package is
   `sideEffects: false` and those modules have no top-level side
   effects, tree-shaking drops them from bundles that don't use them
   (verified: the effect-only lab scenes stay the same size
   after the barrel re-export). When you add a public symbol, add an explicit
   re-export here; when you add an internal helper, tag it `@internal` and leave it
   out.

5. **Options vs. separate export (the tree-shaking heuristic).** A boolean/enum
   **`option` is allowed only if it toggles a GL parameter already on the core
   path** (`minFilter` / `magFilter` / `wrapS` / `wrapT` / `invertY` /
   `generateDepthBuffer`). A feature instead becomes a **separate, tree-shakeable
   export** (NOT a create-option) the moment supporting it would pull in a distinct
   code path or lookup table that non-users would otherwise ship — HDR sized-format
   resolution, stencil renderbuffers, mipmap pyramids, MRT, pixel readback,
   compressed/cube formats, dynamic (canvas) uploads, sub-image updates. This is
   why `generateRenderTargetMipMaps` / `generateRenderTargetStencil` /
   `createFloatRenderTarget` are standalone functions rather than
   `createRenderTarget` options: the RGBA8 core stays branch-free and a consumer
   pays only for what it imports.

Any **new** export MUST follow rules 1–2 and 4 (GL-prefixed type, engine-first
`engine` parameter, lite-matching verb, explicit named re-export from the barrel)
unless a backend difference forces a documented divergence under rule 3; rule 5
governs whether a new feature should be an export at all.

### 3.1 Context

```ts
export interface GLEngineOptions {
    /** Default: true. */
    alpha?: boolean;
    /** Default: true. */
    premultipliedAlpha?: boolean;
    /** Default: false. */
    antialias?: boolean;
    /** Default: false. */
    preserveDrawingBuffer?: boolean;
    /** Default: false — disabled for fullscreen-quad workloads. */
    depth?: boolean;
    /** Default: false. */
    stencil?: boolean;
    /** Default: "default". */
    powerPreference?: WebGLPowerPreference;
    /** Default: false. */
    failIfMajorPerformanceCaveat?: boolean;
}

export interface GLEngineCaps {
    readonly maxTextureSize: number;
    readonly maxTextureUnits: number;
    readonly parallelShaderCompile: { COMPLETION_STATUS_KHR: number } | null;
}

/** Pure-state handle. GPU internals (`gl`, `_state`, registries) are reachable
 *  on the type so functions in this package can operate without casts.
 *
 *  INVARIANT: consumers MUST NOT mutate GL state directly through `engine.gl`.
 *  Doing so silently corrupts the cache in `_state`. The package owns every
 *  GL call. (`engine.gl` is exposed only so adjacent NeonBrush code that already
 *  has the pattern of poking `engine._gl.getExtension(...)` can do that, but
 *  must NOT call `bindTexture`/`useProgram`/`bindBuffer`/`viewport`/etc.) */
export interface GLEngineContext {
    readonly canvas: HTMLCanvasElement;
    readonly gl: WebGL2RenderingContext;
    readonly caps: GLEngineCaps;
    /** Hardware-scaling-level. width/height = canvas.client* * dpr / _hsl. */
    _hsl: number;
    /** rAF id when a render loop is active, 0 otherwise. */
    _rafId: number;
    /** Active per-frame callbacks. `runRenderLoop` is a no-op if `fn` is already
     *  registered (matches Babylon `AbstractEngine.runRenderLoop`). */
    _loops: ((dt: number) => void)[];
    /** Timestamp of last frame for delta computation. */
    _prevNow: number;
    /** Cached GL state. See §4. */
    _state: GLState;
    /** Live effect registry — populated by `createEffect`, removed by
     *  `disposeEffect`. Used by the context-lost/restored protocol (§4.7)
     *  to rebuild programs. */
    _effects: GLEffect[];
    /** Live texture registry — populated by `createRawTexture` /
     *  `loadTexture2D` / `createHtmlElementTexture`, removed by
     *  `disposeTexture`. Used by the context-restored protocol to replay
     *  uploads. */
    _textures: GLTexture[];
    /** Context-lost / restored callback lists. */
    _onLost: (() => void)[];
    _onRestored: (() => void)[];
    /** True between `webglcontextlost` and `webglcontextrestored`. While true,
     *  every `setEffect*` / `bindTexture` / `drawEffect` is a no-op. */
    _isLost: boolean;
    /** True once the context has been disposed; calls become no-ops. */
    _disposed: boolean;
}

export function createGLEngine(canvas: HTMLCanvasElement, options?: GLEngineOptions): GLEngineContext;
export function disposeGLEngine(engine: GLEngineContext): void;

export function resizeGLEngine(engine: GLEngineContext): void;
export function getRenderWidth(engine: GLEngineContext): number;
export function getRenderHeight(engine: GLEngineContext): number;
export function getHardwareScalingLevel(engine: GLEngineContext): number;
export function setHardwareScalingLevel(engine: GLEngineContext, level: number): void;
export function getRenderingCanvas(engine: GLEngineContext): HTMLCanvasElement;

export function onContextLost(engine: GLEngineContext, cb: () => void): void;
export function offContextLost(engine: GLEngineContext, cb: () => void): void;
export function onContextRestored(engine: GLEngineContext, cb: () => void): void;
export function offContextRestored(engine: GLEngineContext, cb: () => void): void;
```

### 3.2 Render loop

```ts
export function runRenderLoop(engine: GLEngineContext, fn: (dt: number) => void): void;
export function stopRenderLoop(engine: GLEngineContext, fn?: (dt: number) => void): void;
```

- `runRenderLoop(engine, fn)` is a **no-op when `fn` is already registered** (matches `AbstractEngine.runRenderLoop`). Each unique callback executes once per frame.
- `stopRenderLoop(engine)` with no callback stops all loops; with a callback removes that one only.

### 3.3 Effects

```ts
export interface GLEffectOptions {
    name: string;
    vertexSource: string; // GLSL ES 3.00, ready for `gl.shaderSource`
    fragmentSource: string; // GLSL ES 3.00
    /** Declared uniform names. Locations resolved during readiness finalization
     *  (§4.6). Declaring them up front lets the package allocate the per-uniform
     *  value cache. Setters for names not in this list are legal but allocate
     *  the cache slot lazily on first use. */
    uniformNames: readonly string[];
    /** Declared sampler names, in unit-assignment order. Each gets a fixed
     *  texture unit assigned during readiness finalization (§4.4 / §4.6), and
     *  `gl.uniform1i(loc, unit)` is called exactly once per program lifetime
     *  (re-run after context-restored). */
    samplerNames: readonly string[];
    /** Declared vertex attributes. Default: `["position"]`. The first attribute
     *  is bound to location 0 via `gl.bindAttribLocation(program, 0, name)`
     *  BEFORE link, so the shared fullscreen-quad VAO (§4.5) always feeds the
     *  same location regardless of how the GLSL compiler would have assigned
     *  it. The GLSL conversion (§6) also emits `layout(location = 0)` as
     *  belt-and-suspenders. */
    attributeNames?: readonly string[];
    /** Optional `#define` block inserted between `#version 300 es` (+ precision)
     *  and the user shader body. Example: `"#define LANDSCAPE 1\n#define USE_RAMP 1\n"`.
     *  Each unique `defines` string must be paired with the same vertex/fragment
     *  source via a separate `createEffect` call — the package does NOT cache
     *  compiled variants. Used by `orbEffect` (LANDSCAPE), `clothEffectVNext`,
     *  and `progressiveLoadingScreen` (BACKGROUNDCOLORRAMP). */
    defines?: string;
}

export interface GLEffect {
    readonly name: string;
    readonly options: GLEffectOptions; // retained for re-compile on context restore
    program: WebGLProgram; // mutable — replaced on restore
    _vs: WebGLShader;
    _fs: WebGLShader;
    /** Resolved during readiness finalization (§4.6). Missing names map to
     *  `null` — setters with a `null` location are silent no-ops (matches
     *  Babylon behaviour for misspelled uniform names). */
    uniformLocations: { [name: string]: WebGLUniformLocation | null };
    /** Fixed unit assignment, index into `_state.boundTextures`. Populated
     *  during readiness finalization. */
    samplerUnits: { [name: string]: number };
    /** True once `gl.uniform1i(samplerLoc, unit)` has been issued for every
     *  declared sampler. Cleared on context restore so finalization re-runs. */
    _samplersAssigned: boolean;
    /** Resolved by `getAttribLocation`. -1 means "not found". For the first
     *  declared attribute this is always 0 because of the pre-link `bindAttribLocation`. */
    attributeLocations: { [name: string]: number };
    /** Per-uniform last-UPLOADED value caches. Allocated up front from
     *  `uniformNames` plus lazily on first use for any extra name. Entries are
     *  written ONLY after a successful `gl.uniform*` call — a setter that
     *  skips the upload (effect not ready, location null, context lost) must
     *  NOT update the cache, otherwise a later "real" set with the same value
     *  would incorrectly elide.
     *
     *  Vec slots are plain `number[]` (NOT `Float32Array`) to avoid float32
     *  truncation breaking equality for common values like `0.1`. */
    readonly _lastF1: { [name: string]: number };
    readonly _lastVec: { [name: string]: number[] };
    readonly _lastI1: { [name: string]: number };
    /** Compile/link state machine. */
    isReady: boolean;
    _compileError: string | null;
    _disposed: boolean;
    /** Callbacks registered before isReady=true; fired exactly once on the
     *  first transition to ready. Re-registered listeners after restore wait
     *  for the next finalization. */
    readonly _onCompiled: ((effect: GLEffect) => void)[];
}

export function createEffect(engine: GLEngineContext, options: GLEffectOptions): GLEffect;
export function isEffectReady(engine: GLEngineContext, effect: GLEffect): boolean;
export function executeWhenCompiled(engine: GLEngineContext, effect: GLEffect, cb: (e: GLEffect) => void): void;
export function disposeEffect(engine: GLEngineContext, effect: GLEffect): void;

/** Sets engine._state.currentProgram and calls gl.useProgram(...) iff changed.
 *  No-op when the effect is not ready. */
export function useEffect(engine: GLEngineContext, effect: GLEffect): void;

// Cached uniform setters — see §4 for the exact cache contract.
export function setEffectFloat(engine: GLEngineContext, effect: GLEffect, name: string, x: number): void;
export function setEffectFloat2(engine: GLEngineContext, effect: GLEffect, name: string, x: number, y: number): void;
export function setEffectFloat3(engine: GLEngineContext, effect: GLEffect, name: string, x: number, y: number, z: number): void;
export function setEffectFloat4(engine: GLEngineContext, effect: GLEffect, name: string, x: number, y: number, z: number, w: number): void;
export function setEffectColor3(engine: GLEngineContext, effect: GLEffect, name: string, c: { r: number; g: number; b: number }): void;
export function setEffectColor4(engine: GLEngineContext, effect: GLEffect, name: string, c: { r: number; g: number; b: number; a: number }): void;
export function setEffectInt(engine: GLEngineContext, effect: GLEffect, name: string, x: number): void;
export function setEffectTexture(engine: GLEngineContext, effect: GLEffect, samplerName: string, tex: GLTexture): void;
```

### 3.4 Textures

```ts
export interface GLTextureOptions {
    /** Default: false (matches Babylon's default raw-texture behaviour). */
    invertY?: boolean;
    /** WebGL2 sampling mode. Default: gl.LINEAR (mip: NEAREST). Pass gl.NEAREST for nearest. */
    minFilter?: GLenum;
    magFilter?: GLenum;
    /** Default: gl.CLAMP_TO_EDGE for both. */
    wrapS?: GLenum;
    wrapT?: GLenum;
}

export interface GLTexture {
    /** Mutable so the SAME logical texture can survive context restore:
     *  the handle is replaced, but every consumer keeps the same `GLTexture`
     *  object. `loadTexture2D` also uses the same handle for both the 1×1
     *  placeholder upload AND the final image upload — bindings made before
     *  `isReady=true` remain valid. */
    handle: WebGLTexture;
    readonly target: GLenum; // gl.TEXTURE_2D
    width: number;
    height: number;
    isReady: boolean;
    _disposed: boolean;
    /** Internal ref count for shared textures (HtmlElementTexture wrappers etc.). */
    _refCount: number;
    /** Replay closure for context-restore (§4.7). Captures the original
     *  arguments (raw bytes + format/type, or decoded `ImageBitmap`, or
     *  the source HTML element) and re-issues the `gl.texImage2D` /
     *  `texParameteri` sequence. */
    _upload: (engine: GLEngineContext) => void;
}

/** Uint8 raw upload. `format` and `type` are GL constants; the caller picks
 *  e.g. (gl.RGBA, gl.UNSIGNED_BYTE). Matches NeonBrush's createRawTexture usage. */
export function createRawTexture(
    engine: GLEngineContext,
    data: ArrayBufferView | null,
    width: number,
    height: number,
    format: GLenum,
    type: GLenum,
    options?: GLTextureOptions
): GLTexture;

/** Async image upload. The returned texture is usable immediately (1×1 transparent
 *  placeholder uploaded into the final handle) and becomes `isReady=true` when
 *  the network/decode completes and the real image has been uploaded into the
 *  same `WebGLTexture` handle. `ImageBitmap` is retained on the GLTexture for
 *  context-restore replay. */
export function loadTexture2D(engine: GLEngineContext, url: string, options?: GLTextureOptions, onLoad?: (tex: GLTexture) => void, onError?: (err: Error) => void): GLTexture;

/** Cached: skips `gl.activeTexture` and/or `gl.bindTexture` when nothing changes.
 *  No-op when `tex._disposed` or `engine._isLost`. */
export function bindTexture(engine: GLEngineContext, unit: number, tex: GLTexture | null): void;

/** Sets `tex._disposed=true`, calls `gl.deleteTexture(tex.handle)`, walks
 *  `_state.boundTextures` and clears every unit that still references the
 *  handle (so a later `bindTexture(..., otherTex)` to the same unit is NOT
 *  incorrectly elided). Removes the texture from `engine._textures`. */
export function disposeTexture(engine: GLEngineContext, tex: GLTexture): void;

/** Build a full mip chain for `tex` (a single `gl.generateMipmap`). Mipmaps are
 *  a **function**, not a create-option: `GLTextureOptions` has no
 *  `generateMipMaps` flag. No-op when `tex._disposed` or `engine._isLost`. */
export function generateTextureMipMaps(engine: GLEngineContext, tex: GLTexture): void;
```

#### 3.4.1 HTML element textures

Dynamic-importable so only InputGlow pulls it in:

```ts
export const GLSamplingMode = { NEAREST: 1, BILINEAR: 2, TRILINEAR: 3 } as const;
export type GLSamplingMode = (typeof GLSamplingMode)[keyof typeof GLSamplingMode];

export interface GLHtmlElementTextureOptions extends GLTextureOptions {
    /** High-level sampling preset (see the Babylon-constants mapping below).
     *  Derives min/mag filters + mip generation; explicit filter options win. */
    samplingMode?: GLSamplingMode;
}

export function createHtmlElementTexture(
    engine: GLEngineContext,
    element: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement,
    options?: GLHtmlElementTextureOptions
): GLTexture;

/** Re-uploads from the source element. No-op when the context is lost/disposed
 *  or the texture is disposed. */
export function updateHtmlElementTexture(engine: GLEngineContext, tex: GLTexture): void;
```

### 3.5 Effect renderer (fullscreen quad)

```ts
export interface GLEffectWrapperOptions {
    name?: string;
    /** Defaults to a built-in fullscreen-quad vertex shader (≙ lite's default
     *  vertexWGSL), so callers can pass only `fragmentSource`. */
    vertexSource?: string;
    fragmentSource: string; // ≙ lite's fragmentWGSL
    uniformNames?: readonly string[];
    samplerNames?: readonly string[];
    attributeNames?: readonly string[];
    defines?: string;
}

// The wrapper compiles and OWNS its effect, and retains the engine it was
// created for (internal `_engine`, trimmed from the public .d.ts), so
// `disposeEffectWrapper` / `applyEffectWrapper` take only the wrapper —
// mirroring lite's `EffectWrapper`.
export interface GLEffectWrapper {
    readonly name: string;
    /** The compiled effect the wrapper owns — exposed so the per-uniform
     *  setters can target it (the WebGL divergence from lite's
     *  `setEffectUniforms(wrapper, …)`). */
    readonly effect: GLEffect;
}

/** Compiles + OWNS the effect built from `options` (≙ lite's
 *  `createEffectWrapper(engine, options)`). `vertexSource` defaults to a
 *  built-in fullscreen-quad shader. */
export function createEffectWrapper(engine: GLEngineContext, options: GLEffectWrapperOptions): GLEffectWrapper;
/** Idempotent. Disposes the effect the wrapper owns. */
export function disposeEffectWrapper(wrapper: GLEffectWrapper): void;

export interface GLViewport {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Defaults to the full canvas in pixel coordinates. */
export function setViewport(engine: GLEngineContext, viewport?: GLViewport): void;

/** Calls `useEffect(engine, wrapper.effect)`, ensures the shared quad VAO exists
 *  (lazy-init via `ensureQuad`), binds it.
 *
 *  This MUST be called BEFORE any `setEffectFloat*` / `setEffectTexture` call
 *  for this effect in the current frame — WebGL `gl.uniform*` writes target the
 *  currently-bound program, and the setters intentionally do NOT call
 *  `useEffect` themselves (keeping the hot path a single equality check).
 *
 *  No depth/stencil state changes: NeonBrush effects never enable them, and
 *  `createGLEngine` requested `depth: false, stencil: false`. If a future
 *  consumer needs depth, add a separate `setDepthTest(engine, on)` cached export. */
export function applyEffectWrapper(wrapper: GLEffectWrapper): void;

/** `gl.drawElements(TRIANGLES, 6, UNSIGNED_SHORT, 0)`. No-op when `engine._isLost`
 *  or when the bound effect is not ready. */
export function drawEffect(engine: GLEngineContext): void;
```

### 3.5.1 Blend mode (core, exported from `index.ts`)

A single cached setter that mirrors Babylon's `ThinEngine.setAlphaMode`. The
preset values are deliberately equal to Babylon's `Constants.ALPHA_*`, so a
NeonBrush port can forward raw Babylon integers with no translation table.

```ts
export const GLBlendMode = { DISABLE: 0, ADD: 1, ALPHA: 2, PREMULTIPLIED: 7 } as const;
export type GLBlendMode = (typeof GLBlendMode)[keyof typeof GLBlendMode];

/** Sets `gl.enable/disable(BLEND)` + `gl.blendFuncSeparate` to match Babylon's
 *  `setAlphaMode(mode)` exactly. Cached in `_state.blendMode`; a redundant call
 *  is a no-op. No-op while `_isLost`/`_disposed`. */
export function setBlendMode(engine: GLEngineContext, mode: GLBlendMode): void;
```

Blend func parameters — copied verbatim from `@babylonjs/core`
`Engines/Extensions/engine.alpha.js` (`ThinEngine.setAlphaMode`), where the
tuple is `gl.blendFuncSeparate(srcRGB, dstRGB, srcAlpha, dstAlpha)`:

| `GLBlendMode`       | Babylon `Constants`   | GL call                                                       |
| ------------------- | --------------------- | ------------------------------------------------------------- |
| `DISABLE` (0)       | `ALPHA_DISABLE`       | `gl.disable(gl.BLEND)`                                        |
| `ADD` (1)           | `ALPHA_ADD`           | `blendFuncSeparate(SRC_ALPHA, ONE, ZERO, ONE)`                |
| `ALPHA` (2)         | `ALPHA_COMBINE`       | `blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE)` |
| `PREMULTIPLIED` (7) | `ALPHA_PREMULTIPLIED` | `blendFuncSeparate(ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE)`       |

Babylon's `setAlphaMode` leaves the blend **equation** implicit (it relies on
the GL default `FUNC_ADD`). `setBlendMode` makes it explicit —
`gl.blendEquationSeparate(FUNC_ADD, FUNC_ADD)` is issued once on each
disabled/unset → enabled transition (gated by the same dirty check as
`gl.enable(BLEND)`). This is pixel-identical to Babylon and keeps the result
deterministic regardless of prior context state.

**Default behaviour is unchanged.** `drawEffect` does not touch blend state, so
code that never calls `setBlendMode` renders exactly as before (cloth/scan
fullscreen parity is preserved). The first `setBlendMode` after creation /
context-loss is never elided because the cache starts at the `-1` sentinel.

### 3.6 Sprite renderer

Re-exported from the barrel; `sideEffects: false` means consumers that don't draw
sprites never pull it into their bundles. It is the lite-gl equivalent of Babylon's
`SpriteRenderer` + `ThinSprite` (`@babylonjs/core` `Sprites/spriteRenderer.js`,
`Sprites/thinSprite.js`). A sprite is a plain data object; the renderer owns its
own VBO/IBO/VAO + compiled effect (it does **not** reuse the fullscreen quad).

```ts
export interface GLSpriteColor {
    r: number;
    g: number;
    b: number;
    a: number;
}

export interface GLSprite {
    position: { x: number; y: number; z: number };
    width: number;
    height: number;
    angle: number; // radians
    cellIndex: number; // 0-based, row-major; negatives clamp to 0
    color?: GLSpriteColor; // defaults to opaque white
    invertU?: boolean; // defaults false
    invertV?: boolean; // defaults false
    isVisible?: boolean; // defaults true; false skips the sprite
}

export interface GLSpriteRendererOptions {
    capacity: number; // integer in [1, 16384] (Uint16 index limit)
    cellWidth: number; // texels
    cellHeight: number; // texels
    texture: GLTexture;
    blendMode?: GLBlendMode; // defaults to GLBlendMode.ALPHA (Babylon parity)
    disableDepthWrite?: boolean; // stored but inert (no depth attachment)
}

export interface GLSpriteRenderer {
    /* texture, cellWidth/Height, blendMode, … (internals trimmed) */
}

/** Allocates the VAO/VBO/IBO + effect and preallocates the CPU vertex scratch at
 *  `capacity` (so `renderSprites` never allocates). Buffers are rebuilt on
 *  `webglcontextrestored`. Throws on invalid capacity / cell size. */
export function createSpriteRenderer(engine: GLEngineContext, options: GLSpriteRendererOptions): GLSpriteRenderer;

/** Builds per-sprite vertex data into the reused Float32Array, uploads with
 *  `bufferSubData`, sets the renderer's blend mode, and draws every visible
 *  sprite in ONE `drawElements`. Allocation-free. No-op on lost/disposed
 *  context, unready texture/effect, or empty input. `deltaTime` is accepted for
 *  Babylon parity but unused (no animation state). Resets blend to `DISABLE`
 *  afterwards (≙ Babylon `autoResetAlpha`). */
export function renderSprites(
    renderer: GLSpriteRenderer,
    sprites: readonly GLSprite[],
    deltaTime: number,
    viewMatrix: Float32Array | number[],
    projectionMatrix: Float32Array | number[]
): void;

/** Swap the sprite-sheet texture (≙ Babylon assigning `SpriteRenderer.texture`
 *  after async load). No-op after disposal. */
export function setSpriteRendererTexture(renderer: GLSpriteRenderer, texture: GLTexture): void;

/** Releases the VAO/VBO/IBO + owned effect and unregisters the restore hook.
 *  Idempotent. Does NOT dispose the texture (the consumer owns it). */
export function disposeSpriteRenderer(renderer: GLSpriteRenderer): void;
```

Geometry / parity notes:

- **Non-instanced 4-vertex quad** per sprite (6 indices), matching Babylon's
  default `SpriteRenderer` path for byte-level parity. Vertex layout is 18
  floats (72-byte stride): `position.xyz` + `angle`, `width/height`, corner
  `offset.xy`, `invertU/V`, `cellInfo.xyzw` (UV origin + size), `color.rgba` —
  bound to attribute locations 0..5.
- **Cell UV math** (`cellLeft/cellTop/cellWidthN/cellHeightN`) and the
  `SPRITE_EPSILON = 0.01` corner inset are copied verbatim from Babylon's
  `_appendSpriteVertex`, so `cellIndex` selects the same sub-rectangle.
- **Shaders** are the GLSL ES 3.00 translation of Babylon's
  `sprites.vertex/fragment` color pass, with the fog / log-depth / pixel-perfect
  / alpha-test branches removed (lite-gl runs no depth pre-pass).
- **Allocation discipline:** the vertex Float32Array and index Uint16Array are
  preallocated in `createSpriteRenderer`; the per-frame matrices are passed
  straight to `gl.uniformMatrix4fv` (no copy, no cache). `renderSprites`
  performs zero allocations.
- **Context restore:** sprite GPU buffers ARE rebuilt automatically via an
  `onContextRestored` hook (the owned effect is rebuilt by the engine). The CPU
  vertex/index data survives, so no replay is needed. `renderSprites` bails
  safely on a lost/disposed context.

### 3.7 Index export

```ts
// src/index.ts — the public API is re-exported EXPLICITLY by name (never `export *`),
// grouped by module, with `export type { … }` for type-only re-exports (isolatedModules).
export { createGLEngine, disposeGLEngine, resizeGLEngine /* …getters + context-lost hooks… */ } from "./context.js";
export type { GLEngineOptions, GLEngineCaps, GLEngineContext } from "./context.js";
// …render-loop, effects, effect-renderer, textures, blend modules (one export {…} / export type {…} each)…
// The sprites, html-texture and render-target features are re-exported here from
// their modules; `sideEffects: false` + no top-level side effects means a bundler
// tree-shakes them from bundles that don't use them.
export { createSpriteRenderer, renderSprites, setSpriteRendererTexture, disposeSpriteRenderer } from "./sprites.js";
export { createHtmlElementTexture, updateHtmlElementTexture, GLSamplingMode } from "./html-texture.js";
export { createRenderTarget, bindRenderTarget, resizeRenderTarget, disposeRenderTarget } from "./render-target.js";
```

---

### 3.8 Render targets

Re-exported from the barrel; `sideEffects: false` means a consumer that never
renders to a texture doesn't pull the FBO code into its bundle. This is the lite-gl
equivalent of Babylon's `RenderTargetTexture` / `createRenderTargetTexture` +
`bindFramebuffer`. A `GLRenderTarget` owns an FBO plus a sampleable color
`GLTexture` (and an optional `DEPTH_COMPONENT16` renderbuffer).

```ts
export interface GLRenderTargetOptions {
    width: number; // positive integer (texels)
    height: number; // positive integer (texels)
    generateDepthBuffer?: boolean; // default false; allocates a DEPTH_COMPONENT16 renderbuffer
    minFilter?: GLenum; // default gl.LINEAR
    magFilter?: GLenum; // default gl.LINEAR
    wrapS?: GLenum; // default gl.CLAMP_TO_EDGE
    wrapT?: GLenum; // default gl.CLAMP_TO_EDGE
    colorTexture?: GLTexture; // BYO color attachment (e.g. a createFloatTexture HDR target); else RGBA8
    // No generateStencilBuffer/generateMipMaps here: stencil is the opt-in
    // generateRenderTargetStencil (depth-stencil module) helper; mipmaps are the
    // generateRenderTargetMipMaps function (both tree-shake out of the core).
}

export interface GLRenderTarget {
    readonly texture: GLTexture;
    width: number;
    height: number; /* + @internal FBO/depth/restore */
}

// Engine-first params everywhere; GL-prefixed, Options-suffixed type names (lite-gl convention).
export function createRenderTarget(engine: GLEngineContext, options: GLRenderTargetOptions): GLRenderTarget;
export function bindRenderTarget(engine: GLEngineContext, rt: GLRenderTarget | null): void;
export function resizeRenderTarget(engine: GLEngineContext, rt: GLRenderTarget, width: number, height: number): void;
export function disposeRenderTarget(engine: GLEngineContext, rt: GLRenderTarget | null | undefined): void;
export function createFloatRenderTarget(engine: GLEngineContext, options: GLFloatRenderTargetOptions): GLRenderTarget; // float / half-float HDR color
export function generateRenderTargetMipMaps(engine: GLEngineContext, rt: GLRenderTarget): void;
// Stencil is opt-in from the depth-stencil module (NOT a createRenderTarget option),
// so the packed-renderbuffer code tree-shakes out of the render-target core:
//   generateRenderTargetStencil(engine, rt, { depth? }): void
//     packs DEPTH24_STENCIL8 (depth default true) or stencil-only STENCIL_INDEX8 (depth:false),
//     replacing the core depth-only buffer; installs a restore/resize hook so it survives FBO rebuilds.
export function readRenderTargetPixels(engine: GLEngineContext, rt: GLRenderTarget, x: number, y: number, w: number, h: number, into?: ArrayBufferView): ArrayBufferView; // GPU→CPU readback
```

- **`createRenderTarget`** allocates the FBO + an engine-registered color texture
  (+ optional depth). It is failure-atomic: on a bad size, a null GL handle, or an
  incomplete framebuffer it frees the color texture and any partial FBO/renderbuffer
  (and restores the previously-bound framebuffer) before throwing, so a failed create
  leaks nothing.
- **`bindRenderTarget`** is the cached framebuffer bind — the analogue of Babylon's
  `bindFramebuffer`. It sets `_state.boundFramebuffer` (§4.1 / §4.2) and the viewport
  to the target size; `rt = null` binds the default framebuffer (the canvas) and the
  canvas viewport. It no-ops on a lost/disposed context or a disposed target.
- **`resizeRenderTarget`** reallocates color (+ depth + FBO) at the new size while
  preserving object identity. If the target is the currently-bound one it is re-bound
  (with the new-size viewport) after the rebuild, because deleting a bound FBO reverts
  GL to framebuffer 0 — without the re-bind an in-flight pass would silently start
  drawing to the canvas.
- **`disposeRenderTarget`** deletes every GL resource, unhooks the restore handler,
  and is idempotent — and a no-op for `null` / `undefined`, matching the WebGPU
  `@babylonjs/lite` `disposeRenderTarget`.
- **Context restore.** A default (owned) RGBA8 color texture is owned, rebuilt and
  deleted by the render target itself: each target registers its OWN
  `onContextRestored` hook that re-creates the FBO + depth and the color texture.
  A bring-your-own `colorTexture` is instead engine-managed (its handle is swapped
    - re-uploaded by the standard texture restore protocol, §4.7), and the target
      reattaches the fresh handle — the same per-target hook pattern the sprite
      renderer uses (§3.6).
- **Scope.** Color is RGBA8 by default, or any `GLTexture` passed via `colorTexture`
  (e.g. a `createFloatTexture` half-float HDR target). Optional core depth16
  (`generateDepthBuffer`); a packed depth-stencil / stencil-only attachment via the
  opt-in `generateRenderTargetStencil`; `createFloatRenderTarget`,
  the `generateRenderTargetMipMaps` function (mipmaps are NOT a create-option) and
  `readRenderTargetPixels` readback are all available. Out of scope: MRT (§10).

Packaging mirrors sprites and html-texture: re-exported from the
`@babylonjs/lite-gl` barrel (the single public entry). Because the package is
`sideEffects: false` and the module has no top-level side effects, a bundler drops it
from any bundle that doesn't use it.

---

## 4. Internal architecture — the cache layer

### 4.1 `GLState` type (owned by `GLEngineContext._state`)

```ts
interface GLState {
    currentProgram: WebGLProgram | null;
    activeTextureUnit: number; // last gl.activeTexture(...)
    boundTextures: (WebGLTexture | null)[]; // per-unit, length = caps.maxTextureUnits
    boundArrayBuffer: WebGLBuffer | null;
    boundElementBuffer: WebGLBuffer | null;
    boundVao: WebGLVertexArrayObject | null;
    /** Cached bound framebuffer — null means the default framebuffer (the
     *  canvas). The single source of truth for the active FBO; `bindRenderTarget`
     *  (the render-target module) elides redundant `gl.bindFramebuffer`
     *  against it. Reset to null on context-lost. */
    boundFramebuffer: WebGLFramebuffer | null;
    viewportX: number;
    viewportY: number;
    viewportW: number;
    viewportH: number;

    // ── Deferred render state (Babylon's applyStates model) ──────────────────
    // The blend / depth / cull / stencil / colorMask render-state lives in ONE
    // flat Float64Array(46) instead of ~42 named fields. Slots 0..20 (indexed by
    // the @internal `RS_*` consts in state.ts) are the ACTUAL applied GL state;
    // slots 21..41 (`rs[RS_X + RS_DESIRED]`) are the DESIRED twin the setters
    // write; slots 42..45 are the standalone (no-desired-twin) cached gl.clearColor
    // RGBA. `applyGLStates` reconciles desired → actual right before each draw /
    // clear. Unset sentinels (both halves): -1 for the enable/mask toggles (and
    // colorMask packed), 0 for the factor/func/op enum slots — chosen so a desired
    // slot that still equals its actual twin never issues a GL call.
    //
    // WHY an index-array (not named fields): the deferred state is touched across
    // state.ts ↔ blend.ts ↔ depth-stencil.ts ↔ apply-states.ts, so esbuild cannot
    // mangle named properties — each long name (`.dBlendSrcRGB`) would ship
    // verbatim, many times, in every scene bundle. The `RS_*` consts are plain
    // integers esbuild inlines (`rs[RS_BLEND_SRC_RGB + RS_DESIRED]` → `rs[22]`),
    // so the storage costs a single short array access everywhere. Float64 (not
    // Int32) because stencilMask / stencilFuncMask can be 0xFFFFFFFF, which Int32
    // stores as -1 — colliding with the -1 unset sentinel.
    rs: Float64Array; // 46 = 21 actual + 21 desired + 4 clearColor
    /** Raised by any deferred setter; cleared by `applyGLStates`. The flush is a
     *  fast no-op when false, so a draw that changed no render state pays
     *  nothing. */
    statesDirty: boolean;
    // Per-category reconcilers, installed onto these slots the first time the
    // matching setter runs (a runtime assignment — NOT a module-level side
    // effect). `applyGLStates` dispatches ONLY through these slots, so a category
    // whose setter is absent from a scene tree-shakes its reconciler (and its GL
    // code) out of the bundle — a clear-only scene drops all four. See §4.2.1.
    _flushBlend?: (engine: GLEngineContext) => void;
    _flushDepthCull?: (engine: GLEngineContext) => void;
    _flushStencil?: (engine: GLEngineContext) => void;
    _flushColorMask?: (engine: GLEngineContext) => void;

    /** Lazy fullscreen quad — built on first applyEffectWrapper, then reused
     *  for the lifetime of the context. Lives here (not in a module-scoped
     *  WeakMap) to satisfy the zero-side-effects rule. Cleared (set to null)
     *  on context-lost and rebuilt on next `applyEffectWrapper`. */
    quadVbo: WebGLBuffer | null;
    quadIbo: WebGLBuffer | null;
    quadVao: WebGLVertexArrayObject | null;
}
```

> **Eager vs deferred.** Program / texture / buffer / VAO / framebuffer binds,
> `viewport`, `scissor` and `pixelStorei` are applied EAGERLY on the setter call
> (eliding only same-value writes). Blend / depth / cull / stencil / colorMask
> are DEFERRED: their setters only record the desired half of `rs` and raise
> `statesDirty`; the GL calls happen in `applyGLStates` (§4.2.1). This collapses
> intra-frame churn (set A → set B → set A with no draw between applies once, as
> A) and matches Babylon's `Engine.applyStates()`.

### 4.1.1 GL-state cache invalidation rules

The cache is the source of truth for **what is currently bound**. It must be
kept in sync with actual GL state. Two protocols enforce that:

- **Disposal:** `disposeTexture` walks `_state.boundTextures` and nulls any unit
  that held the disposed handle; `disposeEffect` clears `_state.currentProgram`
  iff it pointed at the disposed program. This prevents the next-bind to the
  same slot from being elided as a no-op.
- **Context lost:** the `webglcontextlost` handler sets `_isLost=true` and
  clears the entire `_state` (program=null, boundTextures filled with null,
  buffers=null, vao=null, boundFramebuffer=null, quad* = null, viewport=0, and
  the whole `rs` array — BOTH its actual half AND its desired twins — back to the
  unset sentinels with `statesDirty=false`). Resetting both halves means the
  first setter after a restore re-marks `statesDirty` and the next
  `applyGLStates` re-issues from scratch. The `\_flush*`reconciler slots are NOT
cleared (they are pure function refs; a post-restore setter re-installs the
same ref idempotently, and`statesDirty=false`gates the flush until then).
Setters become no-ops while`\_isLost`. See §4.7.

### 4.2 Cache contract — which GL calls are elided

| Operation                                  | Cache key                                 | Elided when                                                                   |
| ------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------- |
| `gl.useProgram`                            | `_state.currentProgram`                   | Same program already current                                                  |
| `gl.activeTexture`                         | `_state.activeTextureUnit`                | Already on that unit                                                          |
| `gl.bindTexture`                           | `_state.boundTextures[unit]`              | Same texture already on that unit                                             |
| `gl.uniform1i(samplerLoc, unit)`           | Done **once at link time**                | Always — never re-issued per frame                                            |
| `gl.uniform1f / 2f / 3f / 4f`              | `effect._lastF1[name]` / `_lastVec`       | Value bit-equal to last                                                       |
| `gl.uniform1i` (non-sampler)               | `effect._lastI1[name]`                    | Value equal to last                                                           |
| `gl.bindBuffer(ARRAY_BUFFER, …)`           | `_state.boundArrayBuffer`                 | Same buffer                                                                   |
| `gl.bindBuffer(ELEMENT_ARRAY_BUFFER, …)`   | `_state.boundElementBuffer`               | Same buffer                                                                   |
| `gl.bindVertexArray`                       | `_state.boundVao`                         | Same VAO (the shared quad VAO lives forever)                                  |
| `gl.bindFramebuffer`                       | `_state.boundFramebuffer`                 | Same FBO already bound (`bindRenderTarget`; null = canvas)                    |
| `gl.viewport`                              | `_state.viewportX/Y/W/H`                  | All four match                                                                |
| blend / depth / cull / stencil / colorMask | `rs` actual slot vs desired twin (§4.2.1) | Deferred — applied by `applyGLStates`, per-slot elided when desired == actual |

For the typical NeonBrush per-frame pattern (one effect, ~5 uniforms, 1–2 textures), after the first frame every steady-state frame issues exactly:

```
gl.uniform*  (only for uniforms whose values actually changed)
gl.drawElements(TRIANGLES, 6, UNSIGNED_SHORT, 0)
```

— and nothing else. Program, VAO, sampler-uniforms, texture units, viewport are all already correct.

### 4.2.1 Deferred render state — `applyGLStates`

Blend, depth, cull, stencil and colorMask follow Babylon's `applyStates()` model
rather than applying eagerly. Both the storage and the flush are tuned so an
unused category costs a scene nothing:

- **Storage — one index-array.** The whole deferred state lives in
  `_state.rs`, a flat `Float64Array(46)`: slots `0..20` (the `@internal` `RS_*`
  consts in `state.ts`) are the ACTUAL applied GL state, slots `21..41`
  (`rs[RS_X + RS_DESIRED]`) the DESIRED twin, and slots `42..45` the standalone
  cached `gl.clearColor` RGBA. This replaced ~42 named fields
  (`blendEnabled` / `dBlendEnabled` / …): because the state is read/written across
  four modules, esbuild could not mangle those property names, so each long name
  shipped verbatim in every scene bundle. The `RS_*` consts are plain integers
  esbuild inlines to short literals (`rs[RS_BLEND_SRC_RGB + RS_DESIRED]` →
  `rs[22]`), reclaiming ~2.4 KB raw per scene. Float64 (not Int32) keeps a
  `0xFFFFFFFF` stencil mask distinct from the `-1` unset sentinel.
- **Setters** (`setBlendMode` / `setBlendState` / `disableBlend`, `setDepthState`,
  `setCullState`, `setStencilState`, `setColorMask`) write ONLY the desired half
  of `rs` and set `statesDirty = true`. They issue no `gl.*` and never touch the
  actual half. Omitted setter fields leave their desired slot untouched
  (merge-from-desired).
- **Per-category dispatch (tree-shakeable).** `applyGLStates(engine)` (the
  internal `apply-states.ts`, not exported from the barrel) owns NO reconciliation
  code — it is a tiny dispatcher. Each category's reconciler (`flushBlend` in
  blend.ts; `flushDepthCull` / `flushStencil` / `flushColorMask` in
  depth-stencil.ts) is INSTALLED onto a `_state._flush*` slot the first time its
  setter runs (a runtime assignment, not a module side effect). `applyGLStates`
  then just calls whichever slots are populated, in the fixed order
  blend → depth+cull → stencil → colorMask (reproducing the old monolith's GL
  call order). Because each reconciler is reachable ONLY through the engine-state
  slot its setter populates, a scene whose setter is absent tree-shakes that
  reconciler — and its GL code — out of the bundle: a clear-only scene like
  `gl-scissor` ships none of the four and `applyGLStates` collapses to four cheap
  "is it installed?" checks.
- Each reconciler no-ops when `statesDirty` is false (or the context is
  lost/disposed — checked once in the dispatcher), otherwise issues only the GL
  calls whose desired slot differs from its actual twin, copies desired→actual,
  and the dispatcher clears `statesDirty`. The blend disabled/unset→enabled
  transition force-issues both `blendEquationSeparate` + `blendFuncSeparate`
  (Babylon's `AlphaState` does not track them while blending is off); thereafter
  each is elided independently. The stencil func-triple and op-triple are each
  issued as a unit.
- **Flush sites** — `applyGLStates` is called immediately before every GPU op:
  `drawEffect` (effect-renderer), `renderSprites` (sprites), `drawIndexed` (mesh),
  and `clearEngine` before `gl.clear` (a clear respects the current write masks).

Net effect: setting the same state every frame applies GL only on the first
frame (cross-frame elision via the desired→actual compare), and intra-frame
churn (A→B→A with no draw between) collapses to a single applied state.

### 4.2.2 Effect cache — identical sources share one program

`createEffect` keeps a per-engine `_effectCache: Map<string, GLEffect>` keyed by
the source descriptor (vertex + fragment source, defines, attribute / uniform /
sampler names, joined by `\u0000`). A second `createEffect` with an identical
descriptor returns the SAME `GLEffect` (and its one `WebGLProgram`) and bumps a
`_refCount` instead of compiling a duplicate program. `disposeEffect` decrements
`_refCount` and only performs the real teardown (delete program/shaders, splice
`_effects`, evict the cache entry, clear `currentProgram` if it matched) when the
count reaches 0. Sharing one program handle is what lets `useEffect`'s
`currentProgram` cache elide the redundant `gl.useProgram` when several consumers
(e.g. multiple `createSpriteRenderer`s built from the same shader) render in turn.
Context-restore is unaffected: each unique effect is registered in `_effects`
exactly once, so its `_restore` runs once per program.

### 4.3 Branchless setter shape

The cache stores the **last-uploaded value**, NOT the last-requested value.
A setter that skips the GL call (effect not ready, context lost, missing
location) MUST NOT update the cache — otherwise a later "real" set with the
same value would incorrectly elide and the GPU would keep stale data.

```ts
export function setEffectFloat(engine: GLEngineContext, effect: GLEffect, name: string, x: number): void {
    if (engine._isLost || !effect.isReady) return; // skip; do not touch cache
    const loc = effect.uniformLocations[name];
    if (loc === null) return; // unknown uniform; do not touch cache
    if (effect._lastF1[name] === x) return; // hot path — value already on GPU
    effect._lastF1[name] = x;
    engine.gl.uniform1f(loc, x);
}

export function setEffectFloat2(engine: GLEngineContext, effect: GLEffect, name: string, x: number, y: number): void {
    if (engine._isLost || !effect.isReady) return;
    const loc = effect.uniformLocations[name];
    if (loc === null) return;
    let v = effect._lastVec[name];
    if (v !== undefined && v[0] === x && v[1] === y) return;
    if (v === undefined) {
        v = [0, 0];
        effect._lastVec[name] = v;
    }
    v[0] = x;
    v[1] = y;
    engine.gl.uniform2f(loc, x, y);
}
```

The vec cache is a plain `number[]` (not `Float32Array`) so values like `0.1`
compare equal across frames — `Float32Array` would truncate to
`0.10000000149011612` and break the equality check forever.

The cache slot allocation (`v = [0, 0]`) happens **at most once per
(effect × uniform) pair**, on first successful upload. Steady state is
allocation-free.

`NaN` inputs: `NaN !== NaN` so the cache check fails every frame and the
GL upload re-issues every frame. This is acceptable — NaN inputs are a
caller bug, and re-uploading is the safe fallback.

### 4.3.1 Ordering invariant

Uniform setters require `_state.currentProgram === effect.program`. The
canonical per-frame sequence is:

```
setViewport(engine);                       // cached
applyEffectWrapper(wrapper);       // useEffect + ensureQuad
setEffectFloat(engine, effect, ...);       // ← AFTER applyEffectWrapper
setEffectTexture(engine, effect, ...);
drawEffect(engine);
```

This matches Babylon's `EffectRenderer` pattern (`applyEffectWrapper` then
`setFloat`/`setTexture` then `draw`). The setters deliberately do NOT call
`useEffect` themselves to keep the hot path a single equality check; if a
caller skips `applyEffectWrapper`, uniforms target the previously bound
program (or none), which is a caller bug.

### 4.4 Sampler-unit assignment

Sampler→unit mapping is fixed for the lifetime of a linked program (re-run
after context restore). It happens during **readiness finalization** (§4.6),
not at `createEffect` time, because with `KHR_parallel_shader_compile` the
program may not yet be linked when `createEffect` returns.

```ts
// Runs once when isEffectReady() observes COMPLETION_STATUS_KHR === true.
function finalizeEffect(engine: GLEngineContext, effect: GLEffect): void {
    const gl = engine.gl;
    // 1. Check link status; on failure record _compileError and stop.
    // 2. Resolve uniform locations from options.uniformNames.
    // 3. Resolve attribute locations from options.attributeNames.
    // 4. useEffect(engine, effect)  — updates _state.currentProgram (cached).
    useEffect(engine, effect);
    // 5. Assign each declared sampler a fixed texture unit and tell the shader once.
    let unit = 0;
    for (const name of effect.options.samplerNames) {
        const loc = gl.getUniformLocation(effect.program, name);
        if (loc !== null) {
            gl.uniform1i(loc, unit); // ONE-TIME per program lifetime
        }
        effect.samplerUnits[name] = unit;
        unit++;
    }
    effect._samplersAssigned = true;
    effect.isReady = true;
    // 6. Fire _onCompiled callbacks once, then clear the list.
}
```

Then `setEffectTexture(engine, effect, name, tex)` is:

```ts
const unit = effect.samplerUnits[samplerName]; // O(1) lookup
bindTexture(engine, unit, tex); // cached: maybe-activeTexture + maybe-bindTexture
// NO gl.uniform1i — it's already set for the lifetime of the program.
```

This is the key win over Babylon's `Effect.setTexture` which re-issues
`gl.uniform1i` on every call.

Sampler uniforms ARE program state, so they survive `useProgram` swaps and
texture binds. They are invalidated only by program relink — which only
happens on context restore, where `_samplersAssigned` is reset to false and
finalization re-runs.

The `useEffect` call inside `finalizeEffect` uses the cached helper, so
`_state.currentProgram` stays consistent — no raw `gl.useProgram` is ever
issued outside of `useEffect`.

### 4.5 Lazy quad init

```ts
function ensureQuad(engine: GLEngineContext): void {
    const s = engine._state;
    if (s.quadVao !== null) return;
    const gl = engine.gl;
    s.quadVao = gl.createVertexArray();
    gl.bindVertexArray(s.quadVao);
    s.boundVao = s.quadVao;

    s.quadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, s.quadVbo);
    s.boundArrayBuffer = s.quadVbo;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([1, 1, -1, 1, -1, -1, 1, -1]), gl.STATIC_DRAW);

    s.quadIbo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.quadIbo);
    s.boundElementBuffer = s.quadIbo;
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);

    // Enable attribute 0 (position) on this VAO. The location is GUARANTEED to
    // be 0 because every effect calls `gl.bindAttribLocation(program, 0,
    // attributeNames[0])` BEFORE link (and the GLSL conversion emits
    // `layout(location = 0)` as belt-and-suspenders). One VAO, every effect.
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
}
```

The geometry matches Babylon's `EffectRenderer` default (positions
`[1,1,-1,1,-1,-1,1,-1]`, indices `[0,1,2,0,2,3]`).

`applyEffectWrapper` calls `ensureQuad(engine)` then `useEffect(engine, wrapper.effect)`.
Once the quad VAO is built and bound, attribute state is baked into the VAO;
subsequent frames touch zero buffer/attrib GL calls — only `useProgram` (cached),
the user's `setEffect*` calls, and `drawElements`.

On context lost, `s.quadVao` (and friends) are cleared to `null`, so the
next `applyEffectWrapper` after restore transparently rebuilds the quad.

#### Why bind to location 0 explicitly

WebGL2 assigns attribute locations at link time unless the GLSL declares
`layout(location = N)` or the program calls `gl.bindAttribLocation(prog, N,
name)` BEFORE link. Without one of those, two different programs may put
`position` at different locations, breaking the shared VAO. We do BOTH:

1. `createEffect` calls `gl.bindAttribLocation(program, 0, options.attributeNames?.[0] ?? "position")` between `attachShader` and `linkProgram`.
2. The GLSL conversion (§6) emits `layout(location = 0) in vec2 position;`.

Either alone is sufficient; together they're robust against converter mistakes
and ensure the shared quad VAO is always correct.

### 4.6 Readiness finalization (parallel-compile-safe)

`createEffect` compiles shaders, calls `attachShader` × 2,
`bindAttribLocation(program, 0, attributeNames[0])`, then `linkProgram`.
It does NOT block on link completion — `isReady` starts as `false`,
`_samplersAssigned` as `false`, `uniformLocations` and `samplerUnits` empty.

`isEffectReady(engine, effect)` is the polling gate:

```
if (effect.isReady) return true;
if (effect._compileError !== null) return false;

linked = (caps.parallelShaderCompile !== null)
    ? gl.getProgramParameter(program, caps.parallelShaderCompile.COMPLETION_STATUS_KHR)
    : true                                  // synchronous link without the extension
if (!linked) return false;

if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    effect._compileError = gl.getProgramInfoLog(program) ?? "link failed";
    return false;
}

finalizeEffect(engine, effect);                // §4.4
return true;                                 // effect.isReady is now true
```

`executeWhenCompiled(engine, effect, cb)`:

```
if (isEffectReady(engine, effect)) { cb(effect); return; }
effect._onCompiled.push(cb);
```

(NeonBrush calls `isEffectReady` every frame via `if (!isReady()) return;` in
the render loop. That same poll drives finalization — there is no separate
"tick" the host must call.)

`_onCompiled[]` is fired and cleared during finalization. Listeners added
_after_ readiness fire synchronously from `executeWhenCompiled` itself.

### 4.7 Context lost / restored protocol

The package owns this end-to-end because NeonBrush relies on Babylon's
silent rebuild behaviour today.

#### `webglcontextlost` handler

1. `event.preventDefault()` — opt in to restore.
2. `engine._isLost = true`.
3. Zero the entire `_state`: `currentProgram=null`, `boundTextures.fill(null)`,
   `boundArrayBuffer/ElementBuffer/Vao=null`, `quadVbo/Ibo/Vao=null`,
   `viewport*=0`, `activeTextureUnit=0`.
4. For each `effect` in `engine._effects`: `effect.isReady=false`,
   `effect._samplersAssigned=false`, `effect.uniformLocations={}`,
   `effect.attributeLocations={}`, clear `_lastF1`/`_lastVec`/`_lastI1`.
   Old GL handles are already dead per spec; do NOT call `deleteProgram`.
5. For each `tex` in `engine._textures`: `tex.isReady=false`. Old `tex.handle`
   is dead.
6. Stop the render loop (`cancelAnimationFrame(_rafId)`).
7. Fire every callback in `engine._onLost`.

While `_isLost`, every public function checks the flag and returns early.
The application's `onContextLost` callback may e.g. hide the canvas.

#### `webglcontextrestored` handler

1. For each `effect` in `engine._effects`: re-compile vs/fs from
   `effect.options.vertexSource/fragmentSource/defines`, re-attach,
   re-`bindAttribLocation`, re-link, assign new `effect.program`. Leave
   `isReady=false` so the next-frame `isEffectReady` poll runs finalization
   (§4.6) which re-resolves locations and re-assigns sampler units.
2. For each `tex` in `engine._textures`: allocate a fresh `WebGLTexture`,
   assign to `tex.handle`, call `tex._upload(engine)` to replay the original
   upload (raw bytes for `createRawTexture`; retained `ImageBitmap` for
   `loadTexture2D`; source HTML element for `createHtmlElementTexture`).
   Set `tex.isReady=true` once the replay completes.
3. `engine._isLost = false`.
4. Restart the render loop if it was active before loss.
5. Fire every callback in `engine._onRestored`.

#### Correctness notes

- The same `GLEffect` and `GLTexture` objects are reused; only their internal
  GL handles change. Consumer code holds these handles by reference, so
  rendering resumes transparently after restore.
- Uniform caches are cleared on loss → the first frame after restore re-uploads
  every uniform. That's correct, because the new program object has no uniform
  state.
- Sampler `uniform1i` is re-assigned during the next finalization pass — see §4.4.
- `_upload` for `loadTexture2D` MUST NOT re-fetch the URL: the package retains
  the decoded `ImageBitmap` exactly so restore is offline-safe. (If the
  `ImageBitmap` was already disposed by the caller via `bitmap.close()`, the
  restore falls back to placeholder pixels and re-fetches in the background.)
- This adds ≈ 150 LOC and ≈ 1–2 KB to the bundle, accepted by user §0 decision.

---

## 5. Tree-shaking & packaging

`package.json` (a single public entry — the barrel — built with plain `tsc`):

```json
{
    "name": "@babylonjs/lite-gl",
    "version": "0.1.0",
    "type": "module",
    "main": "./src/index.ts",
    "types": "./src/index.ts",
    "sideEffects": false,
    "exports": {
        ".": { "import": "./src/index.ts", "types": "./src/index.ts" }
    },
    "publishConfig": {
        "main": "./dist/index.js",
        "types": "./dist/index.d.ts",
        "exports": {
            ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
        }
    },
    "files": ["dist"],
    "scripts": {
        "build": "node build.mjs",
        "dev": "tsc -p tsconfig.json --watch"
    },
    "devDependencies": {
        "typescript": "^5.7.0"
    }
}
```

Tree-shaking guarantees:

- A consumer that uses only `createGLEngine`, `createEffect`,
  `setEffectFloat`, `setEffectFloat2`, `setEffectTexture`, `createRawTexture`,
  `loadTexture2D`, `setViewport`, `applyEffectWrapper`, `drawEffect`,
  `createEffectWrapper`, `runRenderLoop` ships those plus their internal
  helpers (cache update, ensureQuad, finalize, loss-restore protocol).
- `setEffectColor4`, `setEffectInt`, `executeWhenCompiled`,
  `setHardwareScalingLevel`, etc. tree-shake out when unused.
- `html-texture` re-exports from the barrel — consumers that don't use it (e.g.
  everything except NeonBrush's InputGlow) tree-shake it out.
- `sprites` likewise re-exports from the barrel — it pulls in `blend.ts` +
  `effect.ts` but stays out of every bundle that doesn't render sprites.
- No file in `src/` performs work at import time. Top-level constants are limited
  to typed-array literals (the quad geometry) which bundlers treat as pure.
- The loss/restore registries (`_effects`, `_textures`) ARE retained whenever
  `createEffect` or `createRawTexture` is referenced, because the constructors
  push into them. This is unavoidable: it's the cost of context restore. Total
  fixed cost ≈ 1–2 KB.

**Acceptance:** NeonBrush downstream measures its own bundle after migration
and confirms the per-page delta. The 10–12 KB min+gzip estimate in §0 is a
hypothesis; a real measurement is required before declaring v1 success.

---

## 6. Shader convention — GLSL ES 3.00 only

Consumers ship preconverted GLSL ES 3.00 shaders. The runtime does **zero**
preprocessing (no `attribute→in` regex, no `#include` resolution). The only
runtime injection is the optional `defines` string from `GLEffectOptions`,
inserted exactly once between the version declaration and the user shader body.

### 6.1 Required output shape

Every shader the package accepts MUST follow this template:

```glsl
#version 300 es                           // MUST be line 1
precision highp float;                    // (vertex) — or precision mediump for fragment if intentional
precision highp int;
// ← package inserts options.defines here verbatim, if provided
// ← user shader body starts here
```

The fragment shader MUST declare exactly one color output named `glFragColor`:

```glsl
#version 300 es
precision highp float;
out vec4 glFragColor;
// user body here; every former `gl_FragColor = …;` is now `glFragColor = …;`
```

### 6.2 Build-time conversion rules (recommended for NeonBrush)

NeonBrush's existing `tools/buildShaders.mjs` is extended with the following
verbatim rewrites applied IN ORDER to each `*.glsl` source. Conditional
preprocessor blocks (`#ifdef LANDSCAPE`, etc.) are preserved unchanged.

| #   | Rule (regex)                                                                                      | Replacement                                                                                    |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | (vertex only) `^attribute\s+(\w[\w ]*)\s+(\w+)\s*;`                                               | `layout(location = <0 \| 1 \| 2 \| …in order of declaration>) in $1 $2;`                       |
| 2   | (vertex) `^varying\s+(\w+)\s+(\w+)\s*;`                                                           | `out $1 $2;`                                                                                   |
| 3   | (fragment) `^varying\s+(\w+)\s+(\w+)\s*;`                                                         | `in $1 $2;`                                                                                    |
| 4   | (both) `\btexture2D\s*\(`                                                                         | `texture(`                                                                                     |
| 5   | (both) `\btextureCube\s*\(`                                                                       | `texture(`                                                                                     |
| 6   | (fragment) every `\bgl_FragColor\b`                                                               | `glFragColor`. Plus inject `out vec4 glFragColor;` exactly once after the precision qualifier. |
| 7   | (fragment) every `\bgl_FragData\s*\[\s*N\s*\]`                                                    | UNSUPPORTED — converter throws. (MRT is explicitly out of scope.)                              |
| 8   | (both) prepend `#version 300 es\n` + appropriate `precision` declarations if not already present. |                                                                                                |

After conversion, NeonBrush's build emits `*.glsl.ts` modules whose default
export is the converted source string. The runtime concatenates
`source = converted.slice(0, defines_insertion_point) + (options.defines ?? "") + converted.slice(defines_insertion_point)`.
For simplicity, the converter MAY emit a marker comment `// __DEFINES__` and
the runtime splits on that — keeps the runtime regex-free.

### 6.3 What we don't support

- `#include` directives (NeonBrush doesn't use them).
- MRT (`gl_FragData[N]`, multiple `out` colors).
- WebGL1 conditional paths (`#ifdef WEBGL2` blocks).
- Implicit precision for `int` / `bool` — converter inserts `precision highp int;`
  alongside the float precision when missing.
- Shader includes / shader-store lookup.

---

## 7. State machine / lifecycle

```
[create]   createGLEngine(canvas, opts)
              acquires WebGL2 context, builds caps, allocates GLState,
              registers webglcontextlost / webglcontextrestored handlers.
   ↓
[idle]     no rAF active.
   ↓
runRenderLoop(engine, fn)
   ↓
[running]  rAF → resizeGLEngine(engine) → for each _loops: fn(dt)
   ↓
stopRenderLoop(engine[, fn])
   ↓
[idle]
   ↓
disposeGLEngine(engine)
   ↓
[disposed] all subsequent calls are no-ops. WebGLTexture/Buffer/Program
            handles released; canvas left intact.
```

Effect lifecycle:

```
[created]      createEffect: shaders compiled, program linked (parallel if available).
[compiling]    isEffectReady=false. setEffectXxx is legal and updates the value
                cache but skips the gl.uniform* call (loc lookup returns null).
[ready]        isEffectReady=true. _onCompiled fires once. useEffect works.
[disposed]     disposeEffect — gl.deleteProgram / deleteShader.
```

Texture lifecycle: `createRawTexture` / `loadTexture2D` returns immediately; for `loadTexture2D` `isReady` flips true after Image decode + first `gl.texImage2D` call.

---

## 8. Babylon.js equivalence map

| Babylon.js (used by NeonBrush)                                   | lite-gl                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `new ThinEngine(canvas, antialias, opts)`                        | `createGLEngine(canvas, opts)`                                                                 |
| `engine.dispose()`                                               | `disposeGLEngine(engine)`                                                                      |
| `engine.resize()`                                                | `resizeGLEngine(engine)`                                                                       |
| `engine.getRenderWidth/Height()`                                 | `getRenderWidth/Height(engine)`                                                                |
| `engine.getHardwareScalingLevel()` / `setHardwareScalingLevel`   | `getHardwareScalingLevel(engine)` / `setHardwareScalingLevel(engine, lv)`                      |
| `engine.getRenderingCanvas()`                                    | `getRenderingCanvas(engine)`                                                                   |
| `engine.runRenderLoop(fn)` / `stopRenderLoop([fn])`              | `runRenderLoop(engine, fn)` / `stopRenderLoop(engine[, fn])`                                   |
| `engine.onContextLostObservable.add(cb)`                         | `onContextLost(engine, cb)`                                                                    |
| `engine.onContextRestoredObservable.add(cb)`                     | `onContextRestored(engine, cb)`                                                                |
| `engine.createRawTexture(data, w, h, format, mip, invY, samp)`   | `createRawTexture(engine, data, w, h, format, type, opts)`                                     |
| `engine.createTexture(url, noMip, invY, …)`                      | `loadTexture2D(engine, url, opts, onLoad?, onError?)`                                          |
| `new EffectWrapper({ engine, vertexShader, fragmentShader, … })` | `createEffectWrapper(engine, { fragmentSource, vertexSource?, uniformNames?, samplerNames? })` |
| `effect.executeWhenCompiled(cb)`                                 | `executeWhenCompiled(engine, effect, cb)`                                                      |
| `effect.isReady()`                                               | `isEffectReady(engine, effect)`                                                                |
| `effect.setFloat/2/3/4/Color3(name, …)`                          | `setEffectFloat/2/3/4(engine, effect, name, …)` / `setEffectColor3(engine, effect, name, c)`   |
| `effect.setTexture(name, thinTexture)`                           | `setEffectTexture(engine, effect, name, glTexture)`                                            |
| `new EffectRenderer(engine)`                                     | (no equivalent — quad is a context-owned lazy resource)                                        |
| `effectRenderer.setViewport()`                                   | `setViewport(engine)`                                                                          |
| `effectRenderer.applyEffectWrapper(wrapper)`                     | `applyEffectWrapper(wrapper)`                                                                  |
| `effectRenderer.draw()`                                          | `drawEffect(engine)`                                                                           |
| `new ThinTexture(internalTexture)`                               | (no wrapper — `GLTexture` is the public type, no two-layer split)                              |
| `new HtmlElementTexture(name, el, opts)`                         | `createHtmlElementTexture(engine, el, opts)`                                                   |
| `engine.setAlphaMode(mode)`                                      | `setBlendMode(engine, mode)` \_(values ≙ `Constants.ALPHA\__`)\*                               |
| `new SpriteRenderer(name, engine, capacity, …)`                  | `createSpriteRenderer(engine, { capacity, cellWidth, cellHeight, texture, … })`                |
| `spriteRenderer.render(sprites, deltaTime, view, proj)`          | `renderSprites(renderer, sprites, deltaTime, view, proj)`                                      |
| `spriteRenderer.dispose()`                                       | `disposeSpriteRenderer(renderer)`                                                              |
| `new ThinSprite()` (position/size/angle/cellIndex/color/invert)  | `GLSprite` plain data object (same fields)                                                     |
| `engine.createRenderTargetTexture(size, opts)`                   | `createRenderTarget(engine, opts)`                                                             |
| `engine.bindFramebuffer(rtt)` / `engine.unBindFramebuffer(rtt)`  | `bindRenderTarget(engine, rt)` / `bindRenderTarget(engine, null)`                              |
| `rtt.resize(size)` / `rtt.dispose()`                             | `resizeRenderTarget(engine, rt, w, h)` / `disposeRenderTarget(engine, rt)`                     |

Not implemented (NeonBrush doesn't need them): shader-store / `useShaderStore: true`, `#include` resolution, GLSL ES 1.00 path, `ThinSprite` animation (`playAnimation`/`_animate`), observable infrastructure. (Matrix/array uniform setters — `setEffectMatrix`/`setEffectMatrix3x3`/`setEffectFloatArray*`/`setEffectIntArray`; dynamic vertex buffers — `updateVertexBuffer`; and depth/stencil/cull state setters — ARE now shipped.)

---

## 9. Dependencies

- **External (npm):** none. The package depends only on the browser's WebGL2 + DOM types (`@types/web` via `lib: ["DOM", "ESNext"]`).
- **Workspace:** none. The package does not import from `babylon-lite`.
- **Peer (downstream):** `@babylonjs/lite-gl` becomes a dependency of NeonBrush. NeonBrush's `@babylonjs/core` peer can be dropped once the magic loading screen is also ported (v2).

---

## 10. Out of scope / explicit limitations

1. No WebGL1 fallback.
2. Render-to-texture IS available from the barrel
   (`createRenderTarget` / `bindRenderTarget` / `resizeRenderTarget` /
   `disposeRenderTarget`; types `GLRenderTarget` /
   `GLRenderTargetOptions` — see §3.8). Scope is a single RGBA8
   color attachment (or a bring-your-own `colorTexture` — e.g. a `createFloatTexture`
   half-float HDR target — with `createFloatRenderTarget` as the direct HDR sugar),
   an optional core
   `DEPTH_COMPONENT16` renderbuffer (`generateDepthBuffer`), opt-in stencil via
   `generateRenderTargetStencil` (packed `DEPTH24_STENCIL8` or
   stencil-only `STENCIL_INDEX8`) and opt-in mipmaps via
   `generateRenderTargetMipMaps`, and GPU→CPU readback
   (`readRenderTargetPixels`). NOT supported: multiple render targets (MRT,
   item 10).
3. `SpriteRenderer` / `ThinSprite` are available from the barrel
   (`createSpriteRenderer` / `renderSprites` / `GLSprite`), matching Babylon's
   non-instanced 4-vertex path for parity. NOT ported: `ThinSprite` animation
   (`playAnimation` / `_animate` / `delay`), instanced rendering, and the depth
   pre-pass (lite-gl has no depth attachment — `disableDepthWrite` is inert).
4. No shader-store, no `#include`, no runtime preprocessor beyond `options.defines` injection.
5. No observable / event emitter abstraction. Context-lost/restored use plain `cb[]`.
6. Matrix / array uniform setters ARE shipped: `setEffectMatrix` / `setEffectMatrix3x3` / `setEffectFloatArray` / `setEffectFloatArray4` / `setEffectIntArray`, each a tree-shakable `export function`.
7. Depth / stencil / cull / color-mask state setters ARE shipped via the
   the depth-stencil module (`setDepthState` / `setStencilState` / `setCullState`
   / `setColorMask` / `clearEngine`). Blend state is `setBlendMode(engine, mode)` /
   `setBlendState` (§3.5.1) whose presets match `Constants.ALPHA_*`. `drawEffect`
   still does not touch blend, so fullscreen-effect parity is unchanged.
8. No texture compression, no KTX, no DDS, no Basis.
9. No anisotropic filtering knobs (NeonBrush doesn't use them).
10. No MRT — `gl_FragData[N]` is a converter error (§6.3).
11. Matrix uniform setters ARE shipped: `setEffectMatrix(engine, effect, name, m)`
    (4×4) and `setEffectMatrix3x3` for fullscreen effects, alongside the sprite
    renderer's internal `gl.uniformMatrix4fv` view/projection upload.

---

## 11. NeonBrush migration guide (mechanical)

### 11.1 `engine/thinEngineFactory.ts`

```ts
// Before
import { ThinEngine } from "@babylonjs/core/Engines/thinEngine";
export function createThinEngine(canvas, antialias = false) {
    return new ThinEngine(canvas, antialias, { antialias, premultipliedAlpha: true, alpha: true, depth: false, stencil: false, preserveDrawingBuffer: false });
}

// After
import { createGLEngine, type GLEngineContext } from "@babylonjs/lite-gl";
export function createNeonContext(canvas: HTMLCanvasElement, antialias = false): GLEngineContext {
    return createGLEngine(canvas, { antialias, premultipliedAlpha: true, alpha: true, depth: false, stencil: false, preserveDrawingBuffer: false });
}
```

### 11.2 `engine/baseEffect.ts` — class → pure state + free functions

```ts
import { createGLEngine, disposeGLEngine, resizeGLEngine, runRenderLoop, stopRenderLoop, getRenderingCanvas, type GLEngineContext } from "@babylonjs/lite-gl";

export interface BaseEffectState {
    engine: GLEngineContext;
    canvas: HTMLCanvasElement | null;
    ownsContext: boolean;
}

export function createBaseEffectState(canvasOrCtx: HTMLCanvasElement | GLEngineContext): BaseEffectState {
    if ("gl" in canvasOrCtx) {
        return { engine: canvasOrCtx, canvas: getRenderingCanvas(canvasOrCtx), ownsContext: false };
    }
    return {
        engine: createGLEngine(canvasOrCtx, {
            /* defaults */
        }),
        canvas: canvasOrCtx,
        ownsContext: true,
    };
}

export function startBaseEffect(state: BaseEffectState, render: () => void, onError: (e: unknown) => void): void {
    runRenderLoop(state.engine, () => {
        try {
            render();
        } catch (e) {
            onError(e);
            stopBaseEffect(state);
        }
    });
}
export function stopBaseEffect(state: BaseEffectState): void {
    stopRenderLoop(state.engine);
}
export function resizeBaseEffect(state: BaseEffectState): void {
    resizeGLEngine(state.engine);
}
export function disposeBaseEffect(state: BaseEffectState, onDispose: () => void): void {
    stopBaseEffect(state);
    onDispose();
    if (state.ownsContext) {
        disposeGLEngine(state.engine);
    }
}
```

### 11.3 Per-effect rewrite (`ScanEffect` shown; others identical)

```ts
// Before
this._effectWrapper = new EffectWrapper({ engine: this.engine, useShaderStore: false, vertexShader: scanVertex, fragmentShader: scanFragment, samplerNames: [...], uniformNames: [...] });
// inside render():
effectRenderer.setViewport();
effectRenderer.applyEffectWrapper(this._effectWrapper);
effect.setFloat("u_Progress", this.progress);
effect.setTexture("overlaySampler", this._overlayTexture);
effectRenderer.draw();

// After (state + free functions). NOTE THE ORDER: applyEffectWrapper FIRST,
// then setters — uniforms target the currently-bound program (§4.3.1).
this._wrapper = createEffectWrapper(engine, {
    name: "scanEffect",
    vertexSource: scanVertexGLSL3,         // pre-converted GLSL ES 3.00, see §6
    fragmentSource: scanFragmentGLSL3,
    uniformNames: ["u_Progress", "u_Resolution", "u_backgroundSet"],
    samplerNames: ["overlaySampler", "backgroundSampler"],   // unit 0 + unit 1
    // optional: defines: "#define USE_RAMP 1\n",
});
this._effect = this._wrapper.effect;            // exposed for the per-uniform setters
…
// inside render():
setViewport(engine);                                      // cached
applyEffectWrapper(this._wrapper);                // useProgram (cached) + ensureQuad
setEffectFloat(engine, this._effect, "u_Progress", this.progress);
setEffectFloat2(engine, this._effect, "u_Resolution", rx, ry);
setEffectTexture(engine, this._effect, "overlaySampler", this._overlayTex);
setEffectTexture(engine, this._effect, "backgroundSampler", this._backgroundTex);
drawEffect(engine);                                       // gl.drawElements
```

All ten effect files migrate the same way. No GL behaviour changes; uniform-cache behaviour either matches Babylon (per-uniform last-value check) or improves on it (sampler-uniform set once, not every frame).

### 11.4 Babylon → GL constants mapping (for `createRawTexture` migration)

NeonBrush's current calls use Babylon `Constants.*` integer values. The new API
takes WebGL2 constants directly. The build step or a small inline adapter maps:

| Babylon Constants                | Value | WebGL2 constant                    |
| -------------------------------- | ----: | ---------------------------------- |
| `TEXTUREFORMAT_RGBA`             |   `5` | `gl.RGBA`                          |
| `TEXTUREFORMAT_RGB`              |   `4` | `gl.RGB`                           |
| `TEXTUREFORMAT_LUMINANCE`        |   `1` | `gl.LUMINANCE`                     |
| `TEXTURETYPE_UNSIGNED_BYTE`      |   `0` | `gl.UNSIGNED_BYTE`                 |
| `TEXTURETYPE_FLOAT`              |   `1` | `gl.FLOAT`                         |
| `TEXTURETYPE_HALF_FLOAT`         |   `2` | `gl.HALF_FLOAT`                    |
| `TEXTURE_NEAREST_SAMPLINGMODE`   |   `1` | `minFilter/magFilter = gl.NEAREST` |
| `TEXTURE_BILINEAR_SAMPLINGMODE`  |   `2` | `gl.LINEAR` (mip `gl.NEAREST`)     |
| `TEXTURE_TRILINEAR_SAMPLINGMODE` |   `3` | `gl.LINEAR_MIPMAP_LINEAR`          |

Example:

```ts
// Before
this.engine.createRawTexture(new Uint8Array(4), 1, 1, 5, false, false, 1, null, 0);
// After
createRawTexture(engine, new Uint8Array(4), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, { invertY: false, minFilter: gl.NEAREST, magFilter: gl.NEAREST });
```

---

## 12. Test specification

lite-gl ships the **same four-layer test harness as the sibling `babylon-lite`
package**, rooted at `tests/gl/` and mirroring `tests/lite/{unit,build,parity,perf}`:

| Layer              | Location           | Runner                             | Gate                                                                                                                           |
| ------------------ | ------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Unit               | `tests/gl/unit/`   | vitest — `pnpm test:unit:gl`       | mock-GL call / cache assertions                                                                                                |
| Build / public API | `tests/gl/build/`  | vitest — `pnpm test:build:gl`      | builds, trims `@internal`, isolated `.d.ts` typecheck, exports-map resolution, **per-scene bundle-size ceilings (`maxRawKB`)** |
| **Visual parity**  | `tests/gl/parity/` | Playwright — `pnpm test:parity:gl` | canvas screenshot vs committed Babylon `ThinEngine` golden, gated on `MAD ≤ maxMad`                                            |
| **Performance**    | `tests/gl/perf/`   | Playwright — `pnpm test:perf:gl`   | per-scene frame cost vs Babylon `ThinEngine` ref                                                                               |

### 12.0 Coverage policy — REQUIRED for every addition

**Parity and perf are a mandatory part of the harness, not optional extras.**
Every new lite-gl **public API** and every new **GL lab scene** (`lab/gl/`) MUST
ship coverage in all the layers it touches before merge:

- **unit** tests for the new functions / cache behaviour (mock GL);
- **build** assertions whenever it adds or changes a public export, plus a per-scene **bundle-size ceiling** (`maxRawKB`) for any new GL lab scene;
- a **parity** scene that renders the feature through BOTH lite-gl AND a Babylon
  `ThinEngine` reference, then pixel-diffs them (the exact method proven by the
  NeonBrush migration — ref page vs lite page → `gl.readPixels` → `compareImages`);
- a **perf** scene measuring its per-frame cost against the committed baseline.

Concretely, a new `lab/gl/` scene flips `skipParity` / `skipPerf` to `false` in
`scene-config-webgl.json`, sets a `maxRawKB` bundle-size ceiling there (a few KB
above its measured size — the `gl-build` bundle-size test fails the build on
growth), and adds the matching Babylon reference render. Do NOT land a feature
with `skip*: true` (or no `maxRawKB`) unless there is a documented reason in the PR.

### 12.1 Unit tests (vitest, in-package)

| Test                                                       | Description                                                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `createGLEngine rejects non-WebGL2`                        | Mocked canvas returning null → throws clearly.                                                            |
| `setEffectFloat elides repeat calls`                       | Spy on `gl.uniform1f`. Two identical calls = one GL call.                                                 |
| `setEffectFloat with NaN re-uploads every call`            | NaN !== NaN — cache fails closed, safe behaviour.                                                         |
| `setEffectFloat2 cache uses plain number[]`                | Set (0.1, 0.2) twice → one `gl.uniform2f` call (Float32Array truncation regression guard).                |
| `setEffectTexture skips activeTexture / bind`              | Bind tex A unit 0, bind A again → zero extra GL calls.                                                    |
| `setEffectTexture switches unit when needed`               | Bind A unit 0, then B unit 0 → one `bindTexture`, no `activeTexture` reassignment.                        |
| `setEffectTexture skips uniform1i after first frame`       | After finalization, repeated `setEffectTexture` produces zero `uniform1i` calls.                          |
| `setViewport elides no-op`                                 | Same rect → zero `gl.viewport` calls.                                                                     |
| `applyEffectWrapper builds quad once`                      | First call creates VAO; second call doesn't touch `createVertexArray`.                                    |
| `applyEffectWrapper before setters is required`            | Calling setters with a different effect bound writes to the wrong program (regression guard).             |
| `executeWhenCompiled fires once on success`                | Mock parallel-shader-compile to flip ready on frame 3; callback fires exactly once.                       |
| `setEffectFloat before isReady does NOT poison the cache`  | setEffectFloat("u",1) → not-ready, skipped; flip ready; setEffectFloat("u",1) → uploads exactly 1.        |
| `sampler uniforms assigned exactly once at finalization`   | Spy on `uniform1i` between createEffect and frame 100 → exactly one call per sampler.                     |
| `loadTexture2D placeholder is sampleable`                  | Returned texture has `isReady=false` but binding it doesn't error.                                        |
| `loadTexture2D reuses the same handle for image upload`    | `tex.handle` value pre- and post-load is identical (cached bindings stay valid).                          |
| `disposeTexture invalidates _state.boundTextures`          | Bind A unit 0; disposeTexture(A); bind B unit 0 → `gl.bindTexture` IS called (not elided).                |
| `disposeGLEngine makes later calls no-ops`                 | After dispose, `setEffectFloat` etc. return without throwing.                                             |
| `context lost: setters become no-ops`                      | Simulate webglcontextlost → `setEffectFloat` skips upload AND skips cache write.                          |
| `context restored: quad VAO rebuilt`                       | Simulate lost+restored → next `applyEffectWrapper` creates a fresh VAO.                                   |
| `context restored: programs re-linked, samplers re-bound`  | Simulate restore → effects re-linked, sampler `uniform1i` re-issued exactly once per sampler.             |
| `context restored: raw texture upload replayed`            | Simulate restore → `_upload(engine)` called, texture handle replaced, isReady=true.                       |
| `context restored: loadTexture2D replays from ImageBitmap` | No re-fetch of the URL; the retained `ImageBitmap` is re-uploaded.                                        |
| `runRenderLoop dedupes identical callbacks`                | Registering the same fn twice → fired once per frame (matches `AbstractEngine`).                          |
| `stopRenderLoop() removes all loops`                       | After no-arg stop, no callbacks fire.                                                                     |
| `setBlendMode issues Babylon-exact params per mode`        | DISABLE/ADD/ALPHA/PREMULTIPLIED each emit the right `enable/disable` + `blendFuncSeparate` tuple.         |
| `setBlendMode elides redundant calls`                      | Same mode twice = zero GL calls; enabled→enabled re-issues only `blendFuncSeparate` (no re-enable).       |
| `setBlendMode no-op on lost/disposed context`              | After `fireLost` / `disposeGLEngine`, `setBlendMode` writes nothing and does not throw.                   |
| `createSpriteRenderer allocates own VAO/VBO/IBO`           | One `createVertexArray`, two `createBuffer`, two `bufferData`, six attribute pointers.                    |
| `createSpriteRenderer validates capacity / cell size`      | capacity ∉ ℤ∩[1,16384] or non-positive cell size → throws.                                                |
| `renderSprites draws N sprites in one call`                | N visible sprites → one `bufferSubData` + one `drawElements(TRIANGLES, N*6, UNSIGNED_SHORT, 0)`.          |
| `renderSprites honours visibility + capacity`              | `isVisible:false` skipped; sprites beyond capacity ignored (count reflects only drawn sprites).           |
| `renderSprites is allocation-free`                         | `_vertexData` reference is identical across frames (preallocated scratch reused).                         |
| `renderSprites applies blend mode then resets`             | Default ALPHA tuple emitted; autoReset leaves blending disabled afterwards. ADD option honoured.          |
| `renderSprites bails on lost / not-ready`                  | Lost context, unready texture, unready effect, or empty input → no `drawElements`, no throw.              |
| `disposeSpriteRenderer frees GPU + effect, idempotent`     | One `deleteVertexArray` + two `deleteBuffer` + one `deleteProgram`; texture NOT deleted; re-call = no-op. |
| `sprite buffers rebuilt on context restore`                | `fireLost`+`fireRestored` → `_vao`/`_vbo` non-null and `renderSprites` draws again.                       |

### 12.2 Visual parity vs Babylon `ThinEngine` (`tests/gl/parity/`, per scene)

Every GL lab scene has a parity spec: it renders the **same** content twice —
once through stock Babylon `ThinEngine` / `EffectRenderer` / `SpriteRenderer` /
`HtmlElementTexture` (the **reference**, captured as a committed golden) and once
through the lite-gl package — then Playwright **screenshots the canvas** of each
and compares them with `compareImages()`. The gate is the full-image **mean
absolute difference, `MAD ≤ maxMad`** (per scene in `scene-config-webgl.json`);
`maxDiff` and the within-1-LSB fraction are logged for diagnosis but do not gate.
This shows lite-gl is faithful to Babylon (within ANGLE / SwiftShader codegen
noise) for every shipped feature, not just one fullscreen shader.

The harness reuses the proven NeonBrush pattern — a `ref` page + a `lite` page
per scene and a shared `compare-utils.ts` — with determinism from the
`?seekTime=<sec>` freeze convention (both engines render one frame at a fixed
`uTime`, stamp `dataset.animationFrozen`, then stop). Scenes opt in via
`skipParity: false` in `scene-config-webgl.json`; a Babylon reference render is
authored alongside each lite-gl scene (see §12.0). `captureGolden()` reuses the
committed golden, or regenerates it when absent (`RECAPTURE_GOLDEN=true` forces a
refresh).

### 12.3 Performance (`tests/gl/perf/`, per scene)

Each GL lab scene also has a perf spec measuring its per-frame cost
(`perf-raf`-style frame timing, `pnpm test:perf:gl`) and a separate
`perf-regression` comparison (`pnpm test:perf-regression:gl`) whose **baseline is
the Babylon `ThinEngine` reference render** — there is no committed prior-bundle
baseline yet (see §13.2). Scenes opt in via `skipPerf: false`.

### 12.4 NeonBrush downstream tests

NeonBrush's existing Jest + Playwright suites are the ultimate validation: when NeonBrush flips its `engine/` adapter to lite-gl, all `test:unit` and `test:interaction` runs must stay green with no MAD regression on the existing interaction screenshots.

### 12.5 Bundle-size acceptance

NeonBrush measures its production webpack bundle before and after migration.
Acceptance: the swap drops the per-page `@babylonjs/core` footprint by **at
least 10×** for the smallest consumer (e.g. ScanEffect or a single loading
screen). The 10–12 KB min+gzip estimate in §0 is a hypothesis; if the real
number is materially worse, investigate before merging the NeonBrush PR.

---

## 13. Lab gallery & dashboard (GL experience)

The lab (`lab/`) is a single Vite dashboard (`lab/index.html`) with two
**experiences** chosen from the hamburger toggle and persisted in
`localStorage["lab-experience"]`: **Lite** (WebGPU, default) and **Lite GL**
(`webgl`). The dashboard is _experience-aware_ — nearly every command, manifest
URL, and hint string is resolved per-experience **at runtime**, so the two sides
share one page without forking it.

### 13.1 Experience-aware wiring — the rules

- **Two sources of truth, kept in sync.** Server-side, `lab/vite.config.ts`
  exposes `LITE_TARGETS` and `GL_TARGETS` (each entry `{ command, detect }`);
  `/lab-api/generate` and `/lab-api/gen-status` select the array from
  `?experience=gl|lite`. Client-side, `index.html` mirrors them in
  `TAB_GEN_CONFIG` (lite) + `TAB_GEN_GL_COMMANDS` (GL), resolved via
  `genCommandFor(tab)`. **When you add or rename a GL pipeline command, update
  BOTH the server `GL_TARGETS` and the client `TAB_GEN_GL_COMMANDS` — they must
  agree**, or the Regenerate button and the server run different things.
- **`:gl` command convention.** Every GL Regenerate runs the `:gl`-suffixed
  script (`test:parity:gl`, `test:perf:gl`, `test:perf-regression:gl`,
  `build:bundle-scenes:gl`). Never wire a GL tab to a bare lite command.
- **Per-experience config object.** `LAB_EXPERIENCES.{webgpu,webgl}` holds
  `basePath` (`/lite` vs `/gl`), `hasBjsRef`, `runtimeData`, and the manifest
  URLs (`perfManifestUrl` / `bundleManifestUrl` / `perfRegManifestUrl` /
  `demosManifestUrl`). All GL data lives under `lab/public/gl/…`. Always read
  these through `currentExperienceConfig()` / `expBasePath()` / `expHasBjsRef()`
  rather than hard-coding `/lite` or `scene-config.json`.
- **Hints & tooltips are runtime-injected, not static.** The static HTML hints
  are authored for Lite. `applyLabExperienceChrome()` overrides each tab's hint
  text + Regenerate tooltip for GL from `GL_TAB_HINTS`, **preserving the
  `perf` / `perfreg` / `bundle` status `<span>`s** (their loaders repopulate
  them). Any new tab hint that names a command or config file MUST get a GL
  override here, and reference `scene-config-webgl.json` (not `scene-config.json`).
- **Empty-state strings** must use `genCommandFor(tab)`, never a hard-coded
  `pnpm …`, so they print the active experience's command.

### 13.2 Data pipelines — what populates each GL tab

| Tab             | Generator                      | Output (served under `/gl/…`)                 | Shape                                                                     |
| --------------- | ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------- |
| Scenes / Source | `pnpm dev`                     | live — `lab/gl/scene{N}.html` auto-discovered | —                                                                         |
| Parity          | `pnpm test:parity:gl`          | `reference/gl/<slug>/` golden + actual        | per-scene pixel diff                                                      |
| Perf            | `pnpm test:perf:gl`            | `lab/public/gl/perf-manifest.json`            | lite-gl vs Babylon-ref RAF cost                                           |
| Bundle          | `pnpm build:bundle-scenes:gl`  | `lab/public/gl/bundle/manifest.json`          | `{ sceneN: { rawKB, gzipKB, bjsRawKB, bjsGzipKB } }`                      |
| Perf-Reg        | `pnpm test:perf-regression:gl` | `lab/public/gl/perf-regression-manifest.json` | `{ regressionPct, scenes: { sceneN: { current, baseline, …deltaPct } } }` |
| Demos           | static config                  | `demos-config-webgl.json`                     | `[{ slug, name, description, tags, mobile }]`                             |

- **GL bundle sizing** (`scripts/build-bundle-scenes-gl.ts`) esbuild-bundles each
  `lab/gl/src/scene{N}.ts` standalone (bundle + minify + tree-shake, `esm`,
  `esnext`), aliasing `babylon-lite-gl` to `packages/babylon-lite-gl/src/index.ts`
  so the numbers reflect a real tree-shaken consumer. It **also** bundles the
  matching parity reference
  (`lab/gl/src/babylon-ref-scene{N}.ts`, i.e. tree-shaken `@babylonjs/core`) into
  `bjsRawKB` / `bjsGzipKB`, so each Bundle card shows the lite-gl-vs-Babylon
  `ThinEngine` size ratio (~10–16×). GL has no _master_ (git-baseline) bundle, so
  only the master-delta UI is skipped (`hasBjsRef:false`). The measurement logic
  lives in `scripts/bundle-scenes-gl-core.ts`; the `gl-build` bundle-size test
  (`tests/gl/build/bundle-size.test.ts`) reuses it to **fail the build** when any
  scene's `rawKB` exceeds its `maxRawKB` ceiling in `scene-config-webgl.json`.
- **GL perf-regression** baseline = the Babylon `ThinEngine` reference page
  (`lab/gl/babylon-ref-scene{N}.html`), not a committed prior bundle. It writes
  the manifest and **then asserts** per scene that lite-gl stays within
  `PERF_REGRESSION_PCT` of the Babylon baseline (baselines `< 0.05 ms` are too
  noisy to gate and are skipped). CI runs it with a generous
  `PERF_REGRESSION_PCT=50` to absorb software-rendering noise. Covers all scenes,
  spanning the feature matrix (sprite = scene4, html-texture = scene6,
  effect-renderer = scenes 1/2/3/5/7).
- **Demos** are pure config: a `lab/gl/demo-<slug>.html` page (may reuse a scene
  module) + a `lab/public/gl/thumbnails/demo-<slug>.jpg`. No bundle build needed.

### 13.3 Gotchas (these bite)

- **The Vite dev server returns `200` + HTML (SPA fallback) for a _missing_
  file**, not `404`. So `fetch("/gl/…json").then(r => r.json())` throws _before_ a
  manifest is generated. All GL JSON loaders go through `readJsonResponse()`,
  which rejects any non-`application/json` response and degrades to the empty
  state. **Never call `r.json()` directly on an optional manifest** — route it
  through the guard.
- **`esbuild` must be a declared root `devDependency`**, not merely transitive
  via Vite. `tests/lite/tsconfig.json` globs `../../scripts/**/*.ts`, so `tsc`
  typechecks `scripts/build-bundle-scenes-gl.ts` and fails with
  `TS2307: Cannot find module 'esbuild'` unless it is declared. Pin it to the
  version `tsx` already resolves so bundle output does not drift.
- **Switching experience reloads the page** (`setLabExperience` writes
  localStorage then `location.reload()`), so `applyLabExperienceChrome()` runs
  once per load against a fixed experience — no live re-application needed. Note
  the URL `?experience=gl` is **server-side only** (`/lab-api`); the _client_
  selects via localStorage.
- **Perf is measured with the live RAF loop**, not the `?seekTime=` freeze:
  `seekTime` renders one frame and then _stops_ the loop (used for deterministic
  parity capture), so it cannot time repeated frames. Parity → freeze; perf →
  live loop.

---

## 14. File manifest

As-built layout:

```
packages/babylon-lite-gl/
    package.json            scoped @babylonjs/lite-gl, single "." entry (the barrel)
    tsconfig.json
    build.mjs               plain tsc emit (stripInternal) + writes dist/package.json
    README.md
    src/
        index.ts            re-exports (core API + blend)
        context.ts          createGLEngine/disposeGLEngine/resizeGLEngine, lost/restored handlers, registries
        state.ts            GLState types
        render-loop.ts      runRenderLoop (dedupe) / stopRenderLoop
        shader.ts           compile, link, parallel-compile poll, bindAttribLocation
        effect.ts           createEffect/createEffectWrapper/applyEffectWrapper, cached uniform setters, sampler finalize
        texture.ts          createRawTexture + loadTexture2D (ImageBitmap retention), bind cache, bindTextureForUpload, dispose
        html-texture.ts     createHtmlElementTexture/updateHtmlElementTexture/GLSamplingMode
        blend.ts            GLBlendMode preset + setBlendMode (cached, Babylon setAlphaMode parity)
        sprites.ts          GLSprite + createSpriteRenderer/renderSprites/dispose (own VAO/VBO/IBO)
        render-target.ts    createRenderTarget/bindRenderTarget/resizeRenderTarget/disposeRenderTarget (FBO + color tex + optional depth)
        effect-renderer.ts  ensureQuad, setViewport, applyEffectWrapper, drawEffect

tests/gl/                   four-layer harness (mirrors tests/lite/), tsconfig.json
    unit/                   vitest mock-GL — _lite-gl-mock.ts, {blend,cache,html-texture,render-loop,sprites,render-target}.test.ts
    build/                  public-api.test.ts (built dist + trimmed .d.ts)
    parity/                 Playwright pixel-diff vs Babylon ThinEngine — compare-utils.ts, gl-parity.spec.ts
    perf/                   gl-perf-raf.spec.ts (frame cost) + gl-perf-regression.spec.ts (vs Babylon ref)
playwright.perf.gl.config.ts

lab/gl/                     GL experience (selected by the lab experience toggle)
    scene{1..7}.html + src/scene{1..7}.ts                          lite-gl demo scenes
    babylon-ref-scene{1..7}.html + src/babylon-ref-scene{1..7}.ts  Babylon ThinEngine parity references
    demo-sine-bands.html                                           showcase demo (reuses scene7)
    src/_shared/run-effect.ts                                      shared fullscreen-effect harness (?seekTime freeze)
scene-config-webgl.json     per-scene parity/perf config (id, slug, tags, skip*, maxMad)
demos-config-webgl.json     Demos-tab entries
scripts/build-bundle-scenes-gl.ts   esbuild per-scene + Babylon-ref bundle sizer
reference/gl/<slug>/babylon-ref-golden.png   committed golden (git add -f; *-actual / diff-map are ignored outputs)
lab/public/gl/              bundle/manifest.json, perf-manifest.json, perf-regression-manifest.json, thumbnails/

docs/gl/architecture/00-lite-gl.md   (this file)
```

NeonBrush side (downstream PR):

```
packages/NeonBrush/
    package.json                                  add @babylonjs/lite-gl, drop @babylonjs/core (after v2)
    src/engine/thinEngineFactory.ts               → createNeonContext
    src/engine/baseEffect.ts                      → free functions
    src/engine/baseInteractiveEffect.ts           → free functions
    src/generativeEffects/scanEffect.ts           mechanical rewrite
    src/embodiement/cloth/clothEffect.ts          mechanical rewrite
    src/embodiement/clothVNext/clothEffectVNext.ts mechanical rewrite (uses defines)
    src/embodiement/orb/orbEffect.ts              mechanical rewrite (LANDSCAPE define variant)
    src/inputs/inputGlow.ts                       mechanical rewrite (uses html-element textures)
    src/loadingScreen/progressive/…               mechanical rewrite (BACKGROUNDCOLORRAMP define)
    src/loadingScreen/progressiveVNext/…          mechanical rewrite
    src/loadingScreen/rocksteady/…                mechanical rewrite
    src/loadingScreen/core/tiles.ts               mechanical rewrite
    src/loadingScreen/magic/background.ts         mechanical rewrite
    src/loadingScreen/magic/particles.ts          UNCHANGED (still uses stock SpriteRenderer)
    src/loadingScreen/magic/magicLoadingScreen.ts UNCHANGED
    tools/buildShaders.mjs                        extend with GLSL 1.00 → 3.00 pre-conversion (§6.2)
```

Estimated package source: **~1.15–1.45 K LOC** (incremented from the original
estimate to account for the loss/restore protocol added in §4.7).
Estimated bundle delta for NeonBrush (minified + gzipped, what the page actually
downloads): **~120–150 KB → ~11–14 KB** (≈ 10× smaller — see §12.4 for the
acceptance criterion).
