# Porting to `@babylonjs/lite-gl` — Guide & Rulebook

How to port a `@babylonjs/core` consumer (the proven case is **NeonBrush**: 9
effects, 148 parity cases) to the WebGL2 micro-engine `@babylonjs/lite-gl`, and
the hard-won rules that make the port pixel-identical. The payoff is a
**~10–16× smaller** per-page bundle (no `@babylonjs/core`).

This guide is the *practical companion* to the canonical spec
[`architecture/00-lite-gl.md`](./architecture/00-lite-gl.md) — it references that
doc's tables rather than duplicating them:

- **§3** — full public API surface
- **§6** — GLSL ES 3.00 shader convention + the ES 1.00 → 3.00 conversion table (§6.2)
- **§8** — the Babylon.js → lite-gl equivalence map (method → free function)
- **§11** — the mechanical migration steps (engine factory, class → free functions, per-effect rewrite, constants)
- **§12 / §13** — the test harness and lab dashboard

---

## 0. Is your consumer portable?

lite-gl deliberately covers a narrow surface: **fullscreen post-process effects,
2D sprites, dynamic/raw/HTML-element textures, and runtime blend modes**, all
**WebGL2-only** and **GLSL ES 3.00-only**.

**Port it now if** it only uses `ThinEngine` + `EffectRenderer`/`EffectWrapper`,
`SpriteRenderer`, `RawTexture`/`HtmlElementTexture`, and `setAlphaMode` — that is
the NeonBrush shape.

**Not yet** if it needs render-to-texture / FBOs, float/half-float targets,
synchronous readback, instancing, real meshes, stencil/depth state, MRT, or
multi-equation blend. Those are the **ShapeBuilder** expansion (a much larger
lite-gl build — parked; see the `sb-*` plan). Don't bolt them onto a NeonBrush-
style port.

---

## 1. The porting workflow (in order)

1. **Engine factory.** `new ThinEngine(canvas, aa, opts)` → `createGLEngine(canvas, opts)`. Keep the same context options (`alpha`, `premultipliedAlpha`, `depth:false`, `stencil:false`, …). See §11.1.
2. **Classes → state + free functions.** A `BaseEffect` class becomes a plain state object plus free functions (`createBaseEffectState` / `start` / `resize` / `dispose`). Track `ownsContext` so a shared engine isn't disposed twice. See §11.2.
3. **Convert shaders to GLSL ES 3.00** at build time (the runtime does **zero** preprocessing). See §6.2 + the shader rules below.
4. **Rewrite each effect** mechanically (§11.3). **Order is law:** `applyEffectWrapper(wrapper)` **first**, *then* the `setEffect*` setters — uniforms write to the currently-bound program (§4.3.1). Reversing it writes to the wrong program and silently corrupts output.
5. **Map Babylon constants → WebGL2 constants** for `createRawTexture` (Babylon `Constants.TEXTUREFORMAT_*` / `TEXTURETYPE_*` integers → `gl.RGBA` / `gl.UNSIGNED_BYTE` / …). See §11.4.
6. **Handle context loss/restore** for anything *you* own (see §4 below). lite-gl auto-replays its own effects/textures/sprite buffers; consumer-owned GL state does not.
7. **Sprites / particles** (if used) → `createSpriteRenderer` (from the barrel).

The full method-by-method mapping is §8 — keep it open while porting.

---

## 2. Shader rules (GLSL ES 1.00 → 3.00)

The mechanical rewrites are in §6.2. Beyond the regexes, the rules that actually
bit us:

- **No runtime preprocessing.** lite-gl injects the optional `defines` string
  verbatim once and does **no** `#include` resolution of its own — the GLSL
  compiler still runs its own preprocessor, so valid `#if` works. The real
  pitfall is *presence-based* defines: NeonBrush emits a value-less
  `#define SOMEDEFINE` and tests it, so `#if SOMEDEFINE` sees an empty macro and
  misbehaves — convert those to `#ifdef SOMEDEFINE`. *(Learned porting Magic.)*
- **One fragment output named `glFragColor`.** Every `gl_FragColor` → `glFragColor`
  with `out vec4 glFragColor;` injected after the precision lines. MRT
  (`gl_FragData[N]`) is unsupported.
- **Preserve the `*EXT` function family in your minifier.** A GLSL minifier must
  not mangle `texture2DLodEXT` (and siblings) to a short identifier — they are
  real built-ins, not user symbols. *(NeonBrush's `minify-glsl-smart.js` had to
  be taught this; it was renaming `texture2DLodEXT` → `eb`.)*
- **`#version 300 es` MUST be line 1**, followed by `precision` declarations
  (add `precision highp int;` too, not just `float`).

---

## 3. Texture rules

- **`invertY` on image loads is a decode-time flip.** lite-gl's `loadTexture2D`
  now flips via `createImageBitmap({ imageOrientation: "flipY" })`, **not**
  `UNPACK_FLIP_Y_WEBGL` — browsers *ignore* that pixel-store flag for
  `ImageBitmap` sources. If you hand-roll image uploads, do the same. (Raw and
  HTML-element uploads still honor `UNPACK_FLIP_Y_WEBGL`.)
- **HTML-element textures have no mipmaps.** Sample them with **BILINEAR**, never
  TRILINEAR (`Texture.TRILINEAR_SAMPLINGMODE` would request a mip chain that
  doesn't exist). *(Learned porting InputGlow.)* For a fullscreen HTML-texture
  sampled with the built-in quad, you may also need an **in-shader V-flip** of the
  UV to match Babylon's orientation.
- **Uploads target the *active* texture unit.** The bind cache elides re-binds for
  *sampling* (correct — a sampler reads from its unit regardless of the active
  unit), so a hand-rolled `texImage2D` after binding several samplers can land on
  the wrong texture. Always go through the package's update functions
  (`updateHtmlElementTexture`, the `_upload` closures), which use
  `bindTextureForUpload` to force unit 0. Don't hand-roll texture re-uploads.
- **Constants:** map Babylon `Constants.TEXTUREFORMAT_*` / `TEXTURETYPE_*` /
  `*_SAMPLINGMODE` to GL enums per §11.4.

---

## 4. Blend, sprites & context lifecycle

- **Blend.** `engine.setAlphaMode(mode)` → `setBlendMode(engine, GLBlendMode.X)`.
  `GLBlendMode` values equal Babylon's `Constants.ALPHA_*`; the enable +
  `blendFuncSeparate` tuples are verified byte-for-byte against Babylon's
  `alphaCullingState` (ADD / ALPHA(COMBINE) / PREMULTIPLIED). The renderer resets
  blending to DISABLE after each sprite batch.
- **Sprites/particles.** `SpriteRenderer` → `createSpriteRenderer`;
  `ThinSprite` → the plain `GLSprite` data object (same fields). When you author
  the **Babylon parity reference** for a sprite scene, set
  **`disableDepthWrite = true`** on the Babylon `SpriteRenderer` so its depth
  pre-pass collapses to lite-gl's single draw — otherwise the two diverge.
  *(Learned porting Magic's particles.)*
- **Context loss/restore.** lite-gl replays its own resources on
  `webglcontextrestored`, but any GL object *you* create outside the package must
  be rebuilt yourself: register `onContextRestored(engine, cb)` (and
  `onContextLost`) and rebuild there. Callbacks are deduped, fire in registration
  order, and a throwing callback won't block the others.

---

## 5. Proving the port — parity validation (mandatory)

A port isn't done until it's pixel-proven against Babylon. This is exactly how
the NeonBrush migration validated all 148 cases.

1. **Render the same content twice** — once through your new lite-gl path, once
   through a stock Babylon `ThinEngine` + `EffectRenderer`/`SpriteRenderer`/
   `HtmlElementTexture` **reference** — then pixel-diff (`gl.readPixels` →
   `compareImages`). Gate on **MAD ≤ threshold** (soft `maxDiff ≤ 2` absorbs ANGLE
   ±1-LSB codegen noise).
2. **Make it deterministic.** Freeze animation to one identical frame: NeonBrush
   uses a **mock clock + seeded RNG**; the lite-gl lab uses the **`?seekTime=<sec>`**
   convention (render one frame at a fixed `uTime`, stamp
   `dataset.animationFrozen`, stop the loop). Both engines must capture the same
   frozen instant.
3. **Babylon reference page gotcha:** a ref page that calls `engine.createTexture(url)`
   must `import "@babylonjs/core/Misc/fileTools";` or the texture silently never
   loads.
4. **Debug mismatches with the spector.js MCP** (WebGL Debugger agent) — capture
   both sides and diff draw calls, shaders, bound textures, and GL state. See the
   debugging section of [`welcome.md`](./welcome.md). Don't guess pixel values;
   read them.

In-repo, this harness is `tests/gl/parity/` driven by `scene-config-webgl.json`
(see §12) — adding a scene is "author `babylon-ref-scene{N}` + flip
`skipParity:false`".

---

## 6. Consuming the package (dev loop & bundle size)

- **Consume the built package during development.** `pnpm build:gl` emits the
  publishable tree at `packages/babylon-lite-gl/dist/` (with its own
  `package.json`). Point the consumer at `file:…/packages/babylon-lite-gl/dist`,
  or `npm pack ./packages/babylon-lite-gl/dist` and install the generated
  `babylonjs-lite-gl-<version>.tgz`.
- **npm caches by version — sync manually after a rebuild.** Local builds report
  the source version (`0.1.0`; the release pipeline injects the real version via
  `PACKAGE_VERSION`), so `npm install` will **not** re-fetch a freshly rebuilt
  tarball; reinstall from the rebuilt `dist/` (or bump the version) after each
  package rebuild, or you'll test stale code.
- **Sprites & HTML-element textures are tree-shakeable.** Import them from the
  `@babylonjs/lite-gl` barrel (`import { createSpriteRenderer } from "@babylonjs/lite-gl"`);
  a consumer that doesn't use them drops them regardless, because the package is
  `sideEffects: false`. lite-gl's own `src/index.ts` re-exports **explicitly by
  name** (never `export *`); if you re-wrap lite-gl behind your own barrel, do the
  same so a stray `export *` over a side-effecting module can't defeat tree-shaking
  (see [`00-lite-gl.md` §3.0](./architecture/00-lite-gl.md)).
- **Measure before/after.** The swap should drop the per-page `@babylonjs/core`
  footprint by ~10×+. The lab "Bundle" tab and the `gl-build` bundle-size test
  (`maxRawKB` ceilings in `scene-config-webgl.json`) enforce this for the lab
  scenes; do the equivalent measurement for your consumer's real entry points.

---

## 7. Quick checklist

- [ ] `createGLEngine` replaces `ThinEngine`; context options preserved.
- [ ] Classes → state + free functions; `ownsContext` tracked.
- [ ] Shaders pre-converted to ES 3.00; `#if` → `#ifdef`; `*EXT` preserved by the minifier.
- [ ] `applyEffectWrapper` **before** any `setEffect*` setter.
- [ ] `createRawTexture` constants mapped to GL enums.
- [ ] `invertY` handled at decode for image loads; HTML-element textures use BILINEAR.
- [ ] No hand-rolled `texImage2D` after multi-sampler binds (use the update fns).
- [ ] Babylon sprite reference uses `disableDepthWrite = true`.
- [ ] Consumer-owned GL state rebuilt in `onContextRestored`.
- [ ] Every ported feature has a deterministic Babylon-vs-lite-gl parity test (MAD ≤ threshold).
- [ ] Tarball re-synced after each package rebuild; bundle size measured.
