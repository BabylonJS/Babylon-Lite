# Brief: port Babylon.js "GLTF Serializer" visualization tests to Babylon Lite parity scenes

> Temporary handoff material: the brief the porting subagents worked from. Delete before merging.

Repo: Babylon Lite, branch `feat/gltf-exporter-implementation`. Read `GUIDANCE.md` and
`AGENTS.md` first and follow them. **Do not commit, push, switch branches, or edit `scene-config.json`.** Do not modify
anything under `packages/` (if the exporter or renderer is wrong, report it with evidence; I fix those). Only touch the
files of the scenes assigned to you. Several agents work in parallel on other scene ids.

The user's requirement: **"We must match the Babylon.js tests as they are."** Each Babylon.js test is a playground
snippet + a reference image + a pass criterion. Reproduce the snippet faithfully; do not "improve" or adapt it.

## Inputs

- Playground facts (exact, per snippet, plus how Babylon.js's harness runs them):
  `scripts/gltf-export-parity/playground-facts.md`
- Babylon.js official reference images (600×400): `<GLTF_PARITY_WORK>/bjs-reference-images/` (built by `build-asset-mirror.sh`)
- Babylon.js serializer source for reference (read-only): Babylon.js `packages/dev/serializers/src/glTF/2.0/` (GitHub, master @ 676f462)
- Lite exporter spec: `docs/lite/architecture/60-gltf-exporter.md` (Scope section lists what the exporter deliberately does not do).
- Already scaffolded for every scene id N (do not rename): `lab/lite/sceneN.html`, `lab/lite/bundle-sceneN.html`,
  `lab/lite/babylon-ref-sceneN.html` (loads `/lite/src/bjs/sceneN.ts`), and a `scene-config.json` entry with slug
  `sceneN-gltf-export-<name>` (read the slug from there).
- Lab dev server: `http://localhost:5179` (already running; check with `curl -s -o /dev/null -w "%{http_code}" http://localhost:5179/scene2.html`).
  If it is down, tell me in your report; do not start a second one.

## Remote assets in this sandbox

The sandbox cannot reach playground.babylonjs.com, models.babylonjs.com, cdn.babylonjs.com, assets.babylonjs.com,
cdn.jsdelivr.net or i.imgur.com. Committed code must still use the **playgrounds' original URLs** (CI fetches them).
Locally, use the scratch runner below: it serves those hosts from a local mirror via Playwright request routing
(`<GLTF_PARITY_WORK>/mirror/<host>/<path>`, built by `build-asset-mirror.sh`). If the runner prints `UNMIRRORED:` URLs, report them (do not try to
fetch them some other way; do not change network settings).

## Scratch runner (not committed)

`npx tsx scripts/gltf-export-parity/xrun.mjs <cmd> …` (from the repo root)

- `fidelity N <referenceImage.png> <errorRatio> [query]` — renders `babylon-ref-sceneN.html?antialias=0&[query]` at
  600×400 like Babylon.js's harness and compares with the official reference image using Babylon.js's criterion
  (pixelmatch threshold 0.035, pass when differing pixels ≤ errorRatio %). Writes `fidelity-N.png` and `fidelity-N-diff.png` to `<GLTF_PARITY_WORK>/out/`.
- `golden N [query]` — captures `reference/lite/<slug>/babylon-ref-golden.png` from the BJS page at 1280×720 (same steps as `captureGolden`).
- `lite N [query]` — screenshots `sceneN.html?[query]` at 1280×720 and prints MAD vs the golden (+ diff map path).
- `shot <url> <out.png> [w] [h]` — screenshot any lab URL after 8 s (for debugging).
  Every command prints console errors and unmirrored URLs. Use the Read tool on PNGs to look at them.

## Per scene, in order

1. **Babylon.js reference page** `lab/lite/src/bjs/sceneN.ts` — the snippet, faithfully, as an ES module
   (look at `lab/lite/src/bjs/scene2.ts` and `scene226.ts` for the conventions):
    - Imports from `@babylonjs/core/...`, `@babylonjs/loaders/glTF` (side-effect registration),
      `@babylonjs/serializers/glTF/2.0` (or the module path that exports `GLTF2Export`), plus any side-effect imports
      the snippet's features need (e.g. PBR material, cube texture loaders, KTX2/DDS loaders, Draco). Use the exact
      values, names, order and URLs from the facts (relative `textures/…` / `scenes/…` → `https://playground.babylonjs.com/textures/…` / `/scenes/…`).
    - Install the harness's seeded `Math.random` before building the scene:
      `let seed = 1; Math.random = () => { const x = Math.sin(seed++) * 10000; return x - Math.floor(x); };`
    - `const params = new URLSearchParams(location.search); const antialias = params.get("antialias") !== "0";`
      `const engine = new WebGPUEngine(canvas, { antialias, adaptToDeviceRatio: true }); await engine.initAsync();`
    - Disable loading UI: `SceneLoader.ShowLoadingScreen = false` and `engine.displayLoadingUI = () => {}` (GUIDANCE §1d).
    - Test variants (the config `replace` options) come from query params, e.g. `?iterations=2`; defaults = the first test variant.
    - `scene.useConstantAnimationDeltaTime = true` (as the harness does). Then `await scene.whenReadyAsync()`,
      `engine.runRenderLoop(() => scene.render())`, wait for one rendered frame, set `canvas.dataset.ready = "true"`.
      Catch errors and surface them (`console.error`).
    - **Fidelity gate:** run `fidelity N <referenceImage> <errorRatio> [query]` until it PASSES. If it cannot pass,
      find out why (reconstruction mistake vs. WebGPU-vs-WebGL difference) and report the numbers and the diff image.
2. **Lite page** `lab/lite/src/lite/sceneN.ts` — the same scene in Babylon Lite's public API (scene setup code in
   `lab/lite/src/` is the user-facing reference: no `_internal` fields, no raw GPU objects). Build the same pre-export
   scene, export it with `exportSceneAsGlb(scene)`, reload the Blob with `loadGltf(engine, blob)` as the snippet's import
   does (into the same scene or a new one), and reproduce the post-load steps. Same query-param variants. Follow the
   existing Lite scene conventions (`lab/lite/src/lite/scene2.ts`): `registerScene`, `startEngine`, then
   `canvas.dataset.ready = "true"`. For any snippet step Lite cannot express, use the closest public Lite equivalent
   that gives the exported scene the same content, write a one-line comment saying so, and list it in your report.
   If the test cannot be reproduced at all, stop that scene and report why.
3. **Golden**: `golden N` (default variant). Never regenerate it to make a comparison pass.
4. **Compare**: `lite N [query]` for every variant. Iterate on the Lite page until the MAD is as low as it will go.
   For any remaining difference, isolate it (GUIDANCE §1b: which mesh/material) and classify it: Lite page mistake (fix),
   exporter behaviour (report with the exported glTF JSON evidence), or a Lite renderer/loader difference that exists
   without export too (report; check by rendering the same content loaded directly from the source asset if possible).
5. **Parity spec** `tests/lite/parity/scenes/<slug>.spec.ts` following `scene10-pbr-rough.spec.ts` / `scene315-*.spec.ts`:
   `getSceneConfig(N)`, `REFERENCE_DIR` = `reference/lite/<slug>`, `captureGolden(browser, { sceneId: N, timeout: 90_000 })`,
   one `test(...)` per Babylon.js test variant titled `Scene N — <Babylon.js test title> matches Babylon.js`, each
   navigating to `/sceneN.html[?variant]`, waiting with `waitForCanvasReady`, waiting for `#loader-overlay` to detach,
   screenshotting the canvas to `test-actual*.png`, comparing with the one golden (Babylon.js uses one reference image for
   all variants), and asserting `mad <= sceneConfig.maxMad`. Header comment: the Babylon.js test titles, playground id
   and reference image name, and what (if anything) could not be reproduced.
6. **Thumbnail**: `convert reference/lite/<slug>/babylon-ref-golden.png -resize 1280x720^ -gravity center -extent 1280x720 -quality 78 lab/public/thumbnails/sceneN.jpg`.
7. **Checks**: `pnpm exec eslint <your files>`, `pnpm exec prettier --check <your files>`,
   `pnpm exec tsc -p lab/tsconfig.typecheck.json --noEmit`, `pnpm exec tsc -p tests/lite/tsconfig.json --noEmit`.
   Leave no temp files in the repo (`git status --short` must show only your scene files, goldens and thumbnails).

## Report (final message — the only thing I see)

Per scene: files written; fidelity result (diff % vs errorRatio, MAD); Lite MAD per variant; every place the Lite page
deviates from the snippet and why; any exporter/renderer/loader finding with evidence; anything unmirrored or blocked.
