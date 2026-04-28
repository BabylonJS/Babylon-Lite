# Babylon Lite — Immutable Guidance

> **This document is the single source of truth for all architectural and workflow decisions.**
> It must be re-read at the start of every session, after every context compaction,
> and before every implementation decision. It is immutable unless the user explicitly
> requests changes.

---

## Core Pillars (Non-Negotiable)

### 1. WebGPU Exclusive

- Zero WebGL fallback, no legacy wrappers, no abstraction layers for older APIs.
- Built entirely around WebGPU paradigms: render pipelines, compute shaders, bind groups, command buffers.

### 2. Modern TypeScript & 100% Tree-Shakable

- Strictly typed TypeScript. Exceptionally clean, modular API.
- Designed specifically to be entirely tree-shakable — unused features completely stripped from final build.

### 3. Vite as the Foundation

- Project infrastructure, dev server, and production bundling built strictly on Vite.
- Lightning-fast module resolution and highly optimized builds.

### 4. Maximum Performance & Minimal Footprint

- Significantly faster and smaller than standard Babylon.js.
- Avoid heavy OOP overhead where data-oriented design or flat arrays serve GPU buffer transfers better.
- **We do NOT copy Babylon.js code.** We understand the math, then write the minimum code that produces identical pixels.
- **Bundle size = runtime bytes only, excluding local NME payload modules.** The bundle size tests measure JS bytes actually fetched at runtime via Playwright network interception, then subtract local `*-nme.ts` graph payload modules so scene-specific checked-in NME data is not counted as engine/runtime code. Dynamic-import chunks that are never loaded (e.g. animation-group for a static model, pbr-reflectance-ext when no reflectance textures) are correctly excluded. Unused chunks in the build output are fine — only fetched counted bytes matter.
- **WGSL minification in production bundles.** The bundle build (scripts/bundle-scenes-core.ts) uses a Vite plugin that strips comments, `\r`, leading whitespace, and blank lines from `?raw` WGSL imports. Inline WGSL template strings in TypeScript source should also use minimal whitespace (no leading indentation). This keeps production bundles lean while source stays readable.
- **Never parse emitted WGSL strings for structured data.** The WGSL minification plugin rewrites inline template-literal content (collapses whitespace, strips newlines). Code that splits WGSL strings on `\n` or uses regex to extract field names WILL break in production bundles even if it works in dev mode. Always use typed interfaces (e.g. `UboField[]`, `BindingDecl[]`) for structured data; reserve WGSL strings for shader code only.
- **Zero module-level side effects.** No module may execute code at import time (no `register*()` calls, no `globalThis` mutations, no `new Map()`, no `new WeakMap()`, no `new Set()`). Module-level `const cache = new Map()` **kills tree-shaking** — the bundler treats the allocation as a side-effect and cannot eliminate the module even when nothing is imported from it. Use lazy-init instead: `let cache: Map | null = null; function getCache() { if (!cache) cache = new Map(); return cache; }`. Typed-array constants (`new Float32Array([...])`) are safe — bundlers treat them as pure. Caches must auto-invalidate on device change (compare `device !== _cachedDevice`). Material-swap rebuilders are discovered via `_buildGroup._rebuildSingle` property, not a global registry.

### 4b. One-Way Data Ownership (Critical)

- **Only the scene knows its contents.** Components never reference the scene.
- A light is plain data. A camera is plain data. A mesh is plain data. None of them hold a reference to the scene.
- The scene holds arrays of lights, cameras, meshes. The scene is the owner.
- Factory functions like `createHemisphericLight()` return plain data — they do NOT take a scene parameter. The caller adds the result to the scene via `addToScene()`.
- This ensures zero circular dependencies, trivial serialization, and maximum tree-shakability.

### 4b′. Pure State Interfaces (Critical)

- **All public interfaces are pure state — no attached methods.**
- `EngineContext`, `SceneContext`, `Camera`, `ArcRotateCamera`, `FreeCamera`, `Mesh`, `LightBase`, etc. are plain data objects.
- Behaviour is provided by standalone functions that accept the interface as their first argument: `registerScene(engine, scene)`, `startEngine(engine)`, `addToScene(scene, entity)`, `getViewMatrix(camera)`, etc.
- This maximises tree-shakability: unused functions are fully eliminated. Methods on interfaces cannot be tree-shaken.
- Internal interfaces (`SceneContextInternal`, `EngineContextInternal`) follow the same rule — no methods.

### 4d. No GPU Internals in Public API (Critical)

- **User-facing APIs must never expose raw WebGPU handles** (`GPUTexture`, `GPUTextureView`, `GPUSampler`, `GPUBuffer`, `GPUDevice`).
- Textures are represented by the `Texture2D` type (returned by `loadTexture2D()` and `createSolidTexture2D()`).
- Material property interfaces (e.g. `SheenProps.texture`, `ClearCoatProps`) accept `Texture2D`, not raw GPU objects.
- Only internal modules (`_gpu`, pipeline builders, renderable builders) may touch GPU handles.
- Scene setup code in `lab/src/` is the user-facing reference — it must read like a high-level API demo, never like a WebGPU tutorial.

### 4c. Materials Own Shaders (Critical)

- **Shaders are managed by materials, not by the render pipeline.**
- A material encapsulates: shader source (WGSL), bind group layout, pipeline descriptor, and bind group creation.
- The render pipeline works **through** materials — it asks each material to provide its pipeline and bind groups.
- The renderer never imports shader files directly. It only sees materials.
- This keeps rendering logic generic and makes materials self-contained, swappable units.

### 4c′. Always Use Extensions, Never Hardcode (Critical)

- **Every optional feature MUST be expressed as an extension module.** The three extension surfaces are:
    - glTF loader extensions → `packages/babylon-lite/src/loader-gltf/gltf-ext-*.ts` or `gltf-feature-*.ts` implementing `GltfFeature` (hooks: `preMesh`, `applyMaterial`, `applyMesh`, `applyAsset`). Registered in `load-gltf.ts` as `[needs(json), () => import(...)]` tuples — dynamic-imported only when the asset triggers them.
    - PBR material extensions → `packages/babylon-lite/src/material/pbr/fragments/*-fragment.ts` implementing `PbrExt` (`detect`, `frag`, `writeUbo`, `bind`, `textures`). Registered via `_registerPbrExt(ext)` after dynamic-import from `pbr-renderable.ts`.
    - Standard material extensions → follow the same pattern on the standard material side.
- **Never hardcode feature-specific logic in the core loader or core material builders.** No `if (primitive.extensions?.KHR_...)` in `load-gltf.ts`. No `if (mat.subsurface)` inside the core PBR pipeline. The core walks an opaque feature list; feature modules own their triggers and their code paths.
- **Why:** zero bytes for unused features (tree-shaking + dynamic import), no coupling between core and feature code, new extensions can be added without touching the core. Violating this rule breaks bundle-size ceilings for all scenes.

### 5. Pixel-Perfect Accuracy

- Rendering output must be mathematically and visually identical to Babylon.js.
- No approximations. No "close enough."
- Validated via automated pixel diff against Spector.GPU reference captures.

### 6. Frictionless Portability

- Public API must feel like Babylon.js — a developer ports a standard scene with minimal friction.
- Internal implementation is completely different, but developer experience stays familiar.

### 7. Never hack dumb solution

- Always aim for the long term solution. Never hack a fix

---

## Target API Shape

```typescript
async function main(): Promise<void> {
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    addToScene(scene, await loadGltf(engine, "https://playground.babylonjs.com/scenes/BoomBox.glb"));
    await loadEnvironment(scene, ".../environment.env");

    // Components are plain data — scene is the owner
    const light = createHemisphericLight([0, 1, 0], 0.7);
    addToScene(scene, light);

    const camera = createDefaultCamera(scene);
    camera.alpha += Math.PI;

    // Materials own their renderable builders — no explicit pipeline building
    await registerScene(engine, scene); // builds deferred work, partitions renderables
    await startEngine(engine); // resolves after first frame rendered; renders all registered scenes
}
```

---

## Workflow Directives

### 0. Never Revert Unknown Changes (Critical)

- **Never run `git checkout --`, `git restore`, or `git reset` on files you did not personally modify in this session.**
- If you see unexpected changes in `git diff`, **ask the user** before reverting — those may be the user's uncommitted work.
- Reverting unstaged changes is **destructive and irreversible**. There is no undo.
- Only revert files that you can confirm were modified by your own edits or sub-agents in the current session.

### 0b. Clean Up Before Commit (Mandatory)

- **Before committing, delete ALL temporary/debug files** created during the session: isolated test scenes, debug screenshots, amplified diff images, pixel comparison scripts, Spector JSON captures, and any other artifacts not part of the final deliverable.
- **Remove debug code**: `console.warn`/`console.log` diagnostics, `(window as any).__bjsScene` exposures, and shader debug overrides (e.g. `color = vec4(reflectionColor * 10, 1)`) must be reverted before commit.
- **Run `git status --short`** and verify every untracked file (`??`) belongs in the commit. If it's a temp file, delete it.

### 0c. Agent Test Commands (Strict)

- **Agents MUST NOT run `pnpm test:perf`.** Performance tests are machine-sensitive and reserved for the user / CI; running them from an agent session wastes time and produces unreliable signal.
- **Agents run only:** `pnpm build:bundle-scenes` and `pnpm test:parity` (or the individual spec via `npx playwright test tests/parity/scenes/<spec>.spec.ts`). These cover parity MAD + bundle-size ceilings, which are the agent-enforceable guardrails.
- `pnpm test` chains build + parity (no perf), which is acceptable.
- **Iterate on one scene first.** When working on a specific scene, run only that scene's parity spec during the edit/test loop (e.g. `npx playwright test tests/parity/scenes/scene36-basis-texture.spec.ts`) instead of the full `pnpm test:parity` suite. This dramatically cuts iteration time. Only run the full suite + `pnpm build:bundle-scenes` as the final guardrail check before declaring success.
- If perf validation is needed, ask the user to run `pnpm test:perf` locally.


### 1. Live Inspection Tooling (Zero Guesswork)

- Use the **Spector.GPU** MCP tools (`spector-gpu-navigate`, `spector-gpu-capture`, `spector-gpu-get_resource`, etc.) to capture reference frames from Babylon.js (WebGPU mode).
- Extract: buffer data, pipeline states, matrix math, shader outputs.
- The parity harness runs Babylon.js (iframe oracle) side-by-side with Babylon Lite.
- **Zero guesswork** — every rendering decision is validated against captured GPU state.
- **ALWAYS capture and compare with Spector before making rendering changes.**
    - Capture BOTH the reference scene AND our scene.
    - Compare: shaders, pipeline configs, uniform buffer contents, texture formats/sizes, draw call order.
    - Never guess pixel values, color formulas, or material parameters. Extract them from the captures.

### 1b. Debugging Pixel Diffs — Isolate Before Analyzing (Mandatory)

When a parity diff exists on specific meshes:

1. **Identify the mesh** — use BJS picking (`scene.pick(x, y)`) on the hotspot pixel to get the mesh name and material.
2. **Create a minimal isolated scene** — render ONLY the offending mesh(es) in both BJS and Lite with a black background. This eliminates occlusion, blending, and sorting noise.
3. **Capture both with Spector** — with only 1-2 draw calls, you can directly compare UBO data, shader source, and texture bindings without searching through hundreds of commands.
4. **Compare buffer values** — use `spector-gpu-get_resource` to read the exact float values in each UBO (world matrix, material uniforms, light data) and diff them between engines.
5. **Compare shaders** — extract the fragment shader from both captures and diff the key statements (lighting equation, reflection computation, alpha handling).
6. **Fix and verify** — make the fix, re-run the isolated scene to confirm the specific mesh now matches, then run the full parity test.

### 2. Iterative Scene-Based Evolution

- Engine is built progressively, one reference scene at a time.
- Each scene adds capability; all previous scenes must remain pixel-perfect (regression).
- **Scene 1**: `playground.babylonjs.com/full.html?webgpu=1#QCU8DJ#800` (BoomBox + default env)
- **Before adding or fixing a scene, you MUST study existing scenes first:**
    1. **Read the BJS scene code** (`bjs-sceneN.ts`) to understand exactly which BJS APIs are used (e.g. `createDefaultEnvironment()`, `PBRMaterial`, `CubeTexture`, etc.).
    2. **Find existing Lite scenes that use the same BJS features.** Search all `lab/src/lite/scene*.ts` files for similar patterns (DDS skybox, environment loading, material types, camera setup, etc.).
    3. **Reuse their implementation patterns.** If scene14 already loads a DDS cube skybox, scene20 should use the same `buildDdsSkyboxRenderable` approach — not reinvent a flat-color approximation. If scene7 already handles animated glTF with `seekTime`, copy that pattern.
    4. **Use Spector.GPU captures** to compare BJS and Lite shader pipelines side-by-side. Never guess what a BJS shader does — extract and read the actual WGSL from the capture.
- **When adding a new scene, you MUST:**
    1. Create `lab/sceneN.html` + `lab/src/lite/sceneN.ts`
    2. Add the entry to `lab/vite.config.ts` rollup inputs
    3. Add a Playwright parity test in `tests/parity/sceneN-*.spec.ts`
    4. Add a reference screenshot to `reference/sceneN-*/babylon-ref-golden.png`
    5. Copy the reference to `lab/public/thumbnails/sceneN.png`
    6. Add a card to `lab/index.html` (the scene gallery)
    7. Add a bundle-size ceiling test in `tests/bundle-size.test.ts`
    8. Add an entry to `scene-config.json` with `id`, `slug`, `name`, and `maxMad`
    9. **Never change a bundle-size ceiling without explicit user approval.** If a ceiling is exceeded, report the numbers and ask the user before raising the limit.

### 2b. Reference Image Convention (Mandatory)

- **All golden and test images live under `reference/sceneN-<slug>/`** — never in `tests/` or anywhere else.
- **Golden reference:** `babylon-ref-golden.png` (every scene, no exceptions).
- **Test actual output:** `test-actual.png` (written by the parity test).
- **Live reference (optional):** `live-ref.png` (captured at test time from Babylon.js; falls back to golden if capture fails).
- **Thumbnail:** Copy the golden to `lab/public/thumbnails/sceneN.png`.
- Parity specs define `REFERENCE_DIR = path.resolve(__dirname, '../../reference/sceneN-<slug>')` and resolve all images relative to it.

### 2b′. Scene Config — MAD Thresholds (Mandatory)

- **`scene-config.json`** at the repo root is the single source of truth for all per-scene MAD ceilings.
- Each entry has: `id`, `slug`, `name`, `maxMad` (full-image ceiling), and optionally `maxRegionMad` (region-only ceiling).
- **Parity tests** read thresholds via `getSceneConfig(id)` from `tests/parity/compare-utils.ts` — no hardcoded MAD values in test files.
- **Lab parity tab** fetches `/scene-config.json` at runtime and uses per-scene `maxMad` for pass/fail coloring.
- **When adding a new scene**, add its entry to `scene-config.json` with an appropriate `maxMad`.
- **Never raise a scene's `maxMad` without explicit user approval.** If a parity test fails, fix the rendering — don't loosen the threshold.

### 2c. Animated Scene Golden References (Mandatory)

- **Animated scenes use `?seekTime=` to freeze at a deterministic pose.** Both the BJS reference HTML and the Lite scene must support `?seekTime=` (seek to `seekTime * 60` frames, freeze, set `canvas.dataset.animationFrozen = 'true'`).
- **The golden is captured ONCE from BJS** (manually or via a one-off script) with the desired `seekTime`, then committed as `babylon-ref-golden.png`. It is never regenerated at test time.
- **Parity tests compare Lite against the golden only** — they do NOT open a BJS page. The test loads `sceneN.html?seekTime=X`, waits for `animationFrozen`, screenshots, and compares against the golden.
- **No parity test may open a BJS reference page at runtime.** Goldens are the ground truth. Only regenerate them when the user explicitly asks.

### 3. Test-Driven Stability

- Every module gets unit tests + integration tests driven by the parity harness.
- Babylon Lite must remain provably stable as it evolves.

### 4. Documentation-Driven Architecture (The "One-Shot" Rule)

- Generate exhaustive architectural documentation **first**, before code.
- Docs contain: complete API signatures, data structures, shader logic outlines, pipeline configs.
- Must be so rigorous that if all source code were deleted, an LLM could regenerate it perfectly in one shot from the docs alone.
- Docs are the formal specification; code is the implementation of the spec.

### 5. Context Preservation (Anti-Amnesia)

- **Every time** context is compacted or a new session starts:
    1. Re-read this file (`GUIDANCE.md`)
    2. Re-read the plan (`plan.md` in session state)
    3. Re-read the scene spec (`files/scene1-spec.md` in session state)
- These instructions are immutable. They always take priority.

### 6. Code Quality: ESLint + Prettier (Mandatory)

- **All code you write must pass ESLint and Prettier before being considered done.**
- ESLint config: `eslint.config.mjs` (flat config). Prettier config: `.prettierrc`.
- Prettier settings: 4-space tabs, 180 print width, trailing commas (es5), auto line endings.
- **Key ESLint rules enforced:**
    - `prettier/prettier: error` — formatting is enforced via ESLint/Prettier integration.
    - `@typescript-eslint/no-floating-promises: error` — all promises must be awaited, caught, or explicitly voided.
    - `@typescript-eslint/consistent-type-imports: error` — use `import type` for type-only imports.
    - `@typescript-eslint/await-thenable: error` — don't await non-Promise values.
    - `no-console: error` — only `console.warn`, `console.error`, `console.time`, `console.timeEnd`, `console.trace` allowed.
    - `curly: error` — always use braces for control flow.
- **Commands:**
    - `pnpm run lint` — runs ESLint + `tsc --noEmit` (full check).
    - `pnpm run lint:fix` — auto-fix ESLint/Prettier issues.
    - `pnpm run format` — run Prettier on all source files.
    - `pnpm run format:check` — verify Prettier formatting without changing files.
- **After every code change, run `pnpm run lint:fix` to auto-format, then verify with `pnpm run lint`.**

### 7. Bundle Size Analysis (analyze-bundle)

- **`pnpm run analyze-bundle <sceneN>`** — builds a single scene with `rollup-plugin-visualizer` and prints a per-chunk, per-module size breakdown (rendered bytes + gzip).
- Script: `scripts/analyze-bundle.ts`. Also writes an interactive treemap to `/tmp/<scene>-bundle-stats.html`.
- **Use this tool whenever investigating bundle size regressions or exploring reduction opportunities.**
- Example: `pnpm run analyze-bundle scene7`

### 7b. Lab Bundle Files Panel (per-export tokens)

- After `pnpm build:bundle-scenes`, the lab's **Bundle** tab exposes a **📄 Files** button on every scene card that opens a per-scene breakdown of every chunk, every module, and every **exported symbol (token chip)** that survived tree-shaking, annotated with runtime-loaded vs built-but-not-fetched.
- Backing data lives in `lab/public/bundle/bundle-info/<scene>.json` (full module + export list) and `lab/public/bundle/manifest.json` (runtime-fetched chunk set per scene).
- **When tasked with reducing bundle size, you MUST consult the bundle files data before proposing changes.** Compare the exported tokens retained for a scene against what the scene's `.ts` file actually imports:
    - Tokens that survive tree-shaking but aren't needed by the scene's features reveal unconditional imports, side-effectful modules, or missing feature gates — these are the real optimization targets.
    - Runtime-loaded chunks whose functionality the scene has explicitly opted out of (e.g. `background-renderable` despite `skipSkybox+skipGround`, `skeleton-*` for a non-skinned GLB) indicate conditional dynamic imports that are missing.
    - Duplicate exports appearing in multiple chunks indicate re-exports or accidental duplication worth collapsing.
- Read the JSON directly (e.g. `lab/public/bundle/bundle-info/scene12.json`) for scriptable analysis; use the lab UI for interactive exploration.

---

## Babylon.js Reference Repository

- Location: `C:\Repos\Babylon.js`
- Use for understanding internal math and algorithms — never for copying code.
- Key paths:
    - WebGPU engine: `packages/dev/core/src/Engines/webgpuEngine.ts`
    - PBR material: `packages/dev/core/src/Materials/PBR/`
    - PBR shaders: `packages/dev/core/src/Shaders/pbr.vertex.fx`, `pbr.fragment.fx`
    - WGSL shader includes: `packages/dev/core/src/ShadersWGSL/ShadersInclude/`
    - Scene helpers: `packages/dev/core/src/Helpers/sceneHelpers.ts`
    - Environment helper: `packages/dev/core/src/Helpers/environmentHelper.ts`
    - glTF loader: `packages/dev/loaders/src/glTF/2.0/glTFLoader.ts`
    - Env texture loader: `packages/dev/core/src/Materials/Textures/Loaders/envTextureLoader.ts`

---

## Design Philosophy: Slim, Not Dumb

For any feature, we follow this process:

1. **Capture** — Use Spector.GPU to extract the exact GPU state Babylon.js produces.
2. **Understand** — Read Babylon.js source to understand the mathematical algorithm (not the implementation).
3. **Specify** — Write the one-shot doc describing our minimal implementation.
4. **Implement** — Write the smallest possible code that produces identical output.
5. **Validate** — Pixel-diff against the Spector reference capture.

We never ask "how does Babylon.js implement this?" — we ask "what math produces these pixels?"
Then we write that math in the cleanest, most direct WGSL/TypeScript possible.

**Example**: Babylon's PBR fragment shader is 1,373 lines because it handles every possible feature.
For Scene 1 (BoomBox), the active math is ~150 lines of WGSL:

- GGX normal distribution
- Smith-GGX geometry function
- Schlick Fresnel
- IBL cubemap sampling (split-sum)
- Hemispheric light contribution
- Tangent-space normal mapping
- Emissive additive term

---

## One-Shot Documentation Template

Every module gets a doc in `docs/architecture/` using this format:

```
# Module: [name]
> Package path: `packages/babylon-lite/src/[name]/`

## Purpose
## Public API Surface (types, functions, constants — full signatures)
## Internal Architecture (data structures, memory layouts)
## Pipeline Configuration (vertex/fragment stages, bind groups, depth/stencil)
## Shader Logic (WGSL outline or pseudocode with exact math)
## State Machine / Lifecycle
## Babylon.js Equivalence Map
## Dependencies
## Test Specification
## File Manifest
```

The documentation must be complete enough that deleting all source code and
regenerating from docs alone produces a working, pixel-identical engine.
