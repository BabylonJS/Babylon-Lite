# Lite-GL — Developer Welcome

`@babylonjs/lite-gl` is the **WebGL2** sibling of the WebGPU `@babylonjs/lite`
engine: a function-based (no classes), tree-shakeable micro-engine for
fullscreen effects, sprites and dynamic textures. It exists so downstream
consumers (NeonBrush; later ShapeBuilder) can drop `@babylonjs/core` for a
**~10–16× smaller** bundle.

> **WebGL2-only, GLSL ES 3.00-only.** Shaders must be authored in ES 3.00 (no
> ES 1.00 `varying`/`gl_FragColor`, no `#version 100`). lite-gl does no *runtime*
> shader preprocessing or `#include` resolution — it only injects the optional
> `defines` string verbatim, so ship valid GLSL ES 3.00.

**Read the full spec next:** [`docs/gl/architecture/00-lite-gl.md`](./architecture/00-lite-gl.md)
— public API (§3), the GL-call cache layer (§4), GLSL ES 3.00 rules (§6), the
four-layer test harness (§12), the lab gallery/dashboard (§13), and the as-built
file manifest (§14).

**Porting a `@babylonjs/core` consumer** (NeonBrush, ShapeBuilder, …) to lite-gl?
Start with the [**Porting Guide & Rulebook**](./porting-guide.md) — the ordered
workflow plus every hard-won rule (shader conversion, texture/blend/sprite
gotchas, parity validation, the tarball dev loop) distilled from the NeonBrush
migration.

## Build & Test

lite-gl (`@babylonjs/lite-gl`) lives in `packages/babylon-lite-gl/`; its tests
mirror the lite harness under `tests/gl/`:

- `pnpm test:unit:gl` — Vitest unit tests (mock GL)
- `pnpm test:build:gl` — build + trimmed public-API / `.d.ts` + exports-resolution + per-scene bundle-size ceiling (`maxRawKB`) tests
- `pnpm test:parity:gl` — Playwright pixel parity vs Babylon `ThinEngine` (per GL lab scene)
- `pnpm test:perf:gl` — Playwright per-scene RAF frame-cost
- `pnpm test:perf-regression:gl` — lite-gl vs Babylon-ref RAF → `lab/public/gl/perf-regression-manifest.json` (gates that lite-gl is not materially slower than Babylon)
- `pnpm build:bundle-scenes:gl` — esbuild per-scene + Babylon-ref bundle sizes → `lab/public/gl/bundle/manifest.json`
- GL lab scenes live in `lab/gl/` — auto-discovered (`lab/gl/scene{N}.html` + `src/scene{N}.ts`), listed in `scene-config-webgl.json`.

CI wiring: the `azure-pipelines.yml` UnitTests job runs `gl-unit`, `gl-build`,
GL tsc checks, `test:parity:gl`, and `test:perf-regression:gl` (headless
SwiftShader). Parity needs the committed `reference/gl/<slug>/babylon-ref-golden.png`
goldens (generate them with the same SwiftShader path:
`CI=true HEADLESS=true RECAPTURE_GOLDEN=true pnpm test:parity:gl`, then `git add -f`).

## Coverage policy (REQUIRED)

Any new lite-gl public API or GL lab scene must ship **unit + build + parity +
perf** coverage before merge — see [`00-lite-gl.md` §12.0](./architecture/00-lite-gl.md).
New GL scenes flip `skipParity` / `skipPerf` to `false` in `scene-config-webgl.json`,
set a `maxRawKB` bundle-size ceiling there (the `gl-build` test fails on growth),
and add a Babylon `ThinEngine` reference render to diff against. Parity and perf
are not optional.

## Lab dashboard (two experiences)

`lab/index.html` serves both **Lite** (WebGPU) and **Lite GL**
(`localStorage["lab-experience"] = "webgl"`), and is experience-aware — GL
commands, manifest URLs, and hints resolve at runtime. Keep the server
`GL_TARGETS` (`lab/vite.config.ts`) in sync with the client `TAB_GEN_GL_COMMANDS`
+ `GL_TAB_HINTS` (`index.html`); always use the `:gl` scripts +
`scene-config-webgl.json` for GL. Two gotchas:

1. The Vite dev server returns `200`-HTML for a missing file, so optional GL JSON
   manifests must be fetched through the `readJsonResponse()` guard, never raw
   `r.json()`.
2. `esbuild` must be a declared root `devDependency` because
   `tests/lite/tsconfig.json` globs `scripts/` and `tsc` typechecks the GL bundle
   script.

Full dashboard details: [`00-lite-gl.md` §13](./architecture/00-lite-gl.md).

## Debugging lite-gl rendering — use the spector.js MCP

lite-gl is **WebGL2**, so the inspection tool is **SpectorJS** (the *spector.js*
MCP), driven through the **WebGL Debugger** agent. This is the WebGL counterpart
of the **Spector.GPU** MCP that the WebGPU `@babylonjs/lite` engine uses (see
`.github/copilot/instructions.md` and `GUIDANCE.md` for that side) — do not mix
them up: Spector.GPU captures WebGPU, spector.js captures WebGL.

**Rule: 1 capture from each side before any rendering change.** When a GL parity
diff or rendering bug appears, capture a frame from BOTH pages and compare actual
GPU state — never reverse-engineer colors or guess what is bound.

1. **Capture both sides.** Use the spector.js MCP (WebGL Debugger agent) to
   capture a frame from the lite-gl scene (`/gl/scene{N}.html`) **and** its
   Babylon `ThinEngine` reference (`/gl/babylon-ref-scene{N}.html`). Freeze both
   deterministically with `?seekTime=<sec>` so each renders one identical frame
   (the same convention the parity harness uses).
2. **Compare draw calls** — order, count, primitive type, bound vertex/index
   buffers. lite-gl issues **one** draw per effect / per sprite batch; a mismatch
   in call count is usually a blend-mode, batching, or quad-setup bug.
3. **Compare shaders** — both sides are GLSL ES 3.00. Diff the fragment shader
   source and the attribute / uniform / sampler bindings on the active program
   (Babylon's WebGL2 processor auto-converts ES 1.00 refs to ES 3.00 — lite-gl
   authors ES 3.00 directly, so the emitted source should match).
4. **Compare textures & samplers** — bound texture per unit, internal format,
   size, min/mag filter, wrap, and vertical orientation. Remember lite-gl flips
   `ImageBitmap` sources at **decode** (`createImageBitmap({ imageOrientation })`),
   not via `UNPACK_FLIP_Y_WEBGL` (which browsers ignore for ImageBitmap); HTML
   element + raw uploads still use `UNPACK_FLIP_Y_WEBGL`.
5. **Compare GL state** — blend enable + the `blendFuncSeparate` tuple (must match
   Babylon `setAlphaMode`; see `blend.ts`), viewport, and the **active texture
   unit** (uploads target the active unit — see `bindTextureForUpload`).
6. **Dump pixels** — read exact RGB at several positions (Python/Pillow or
   similar) rather than eyeballing; the parity harness gates on MAD ≤ `maxMad`
   from `scene-config-webgl.json`.

**Encode any capture/screenshot you share as JPG (quality ≤ 60, under ~1 MB).**
PNG frame captures routinely blow past the per-request size limit.

### Recurring lite-gl gotchas

See [`00-lite-gl.md` §13.3](./architecture/00-lite-gl.md) for the full list. The
ones that bite most often:

- Uploads (`texImage2D`) write to the texture on the **active** unit — the bind
  cache elides re-binds for *sampling*, so upload paths must force unit 0
  (`bindTextureForUpload`).
- `ImageBitmap` ignores `UNPACK_FLIP_Y_WEBGL` → flip at decode (see above).
- The minifier must preserve the `*EXT` shader-function family (e.g.
  `texture2DLodEXT`).
- `HtmlElementTexture` has no mipmaps → use `BILINEAR`, not `TRILINEAR`.
- Sprite parity vs Babylon needs `disableDepthWrite = true` on the Babylon
  `SpriteRenderer` to match lite-gl's single draw.
