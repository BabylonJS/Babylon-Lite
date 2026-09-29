# MeshLoD Demo — Verification Record (REQ-VERIFY-6)

The standalone MeshLoD statue demo is verified against every `REQ-DEMO-*`
requirement by an automated Playwright workflow that drives the
**production-bundled** demo (`/lite/bundle/demos/mesh-lod.js`) in real WebGPU.

- **Automated suite:** `tests/lite/demo/mesh-lod-demo.spec.ts`
- **Run:** `pnpm build:bundle-demo mesh-lod && npx playwright test tests/lite/demo/mesh-lod-demo.spec.ts`
- **Guardrails:** no golden images are added or changed; no performance test is run;
  the browser test loads the tree-shaken production bundle, not raw TypeScript.

## Requirement → evidence

| Requirement | Evidence (test / observation) | Result |
| --- | --- | --- |
| **REQ-DEMO-1** — standalone conventions (WebGPU page, bundled entry, gallery metadata, loading/progress, ready/error, JPG thumbnail) | `demos-config.json` `mesh-lod` entry renders a gallery card + `lab/public/thumbnails/demo-mesh-lod.jpg` (1280×720). Workflow test asserts `data-ready`, three instances, and that the loading overlay is removed once ready. Error banner covered below. | ✅ |
| **REQ-DEMO-2** — application-equivalent loading via the public lazy path | Demo uses only `loadMeshLoD` → `createMeshLoDInstance` → `addMeshLoDToScene` (no demo loader/selector/cache/renderer). The build tree-shaking test (`tests/lite/build/mesh-lod-tree-shaking.test.ts`) proves the MeshLoD runtime chunk loads only for a `loadMeshLoD` consumer. Workflow test asserts the statue streams and refines. | ✅ |
| **REQ-DEMO-3** — orbit/zoom + optional deterministic path | Workflow test: a drag + wheel change the rendered view; enabling the path animates the view; a manual gesture pauses it (idle view stable). Deterministic-path test: `?pathTime=0/5/10/15` produce the documented azimuth/elevation keyframes, a bounds-independent radius ratio of 3.2, and byte-repeatable state on reload. | ✅ |
| **REQ-DEMO-4** — controls (SSE, cache budget, streaming pause, bandwidth, latency) | Workflow test drives each control and asserts the effective value display (`8.0 px`, `64 MiB`, `250 ms`, `Unlimited`) with no validation error. Pause + bandwidth/latency only affect `.mlod` traffic (the simulator wraps `MeshLoDRequestOptions.fetch`; environment/GLB use the untouched global fetch). | ✅ |
| **REQ-DEMO-5** — diagnostics (source/rendered triangles, meshlets, groups, depth, selected/unmet SSE, page state, bytes, GPU/CPU cache, GPU timing) | Workflow test asserts rendered triangles exceed the coarse bound (streamed), byte metrics are MiB-labelled, hierarchy depth ≥ 12, selected vs unmet SSE are distinct rows, and GPU timing is an explicit status (`unsupported`/`pending`/`disabled`/`N.NN ms`) — never a fake `0.00 ms`. Units documented in the panel. | ✅ |
| **REQ-DEMO-6** — debug views (meshlet ID, LOD depth, selected group, page residency, requested pages) + legend | Workflow test selects each of the five views and asserts: a visible legend, the render recolors vs the material view, and the statue stays complete (rendered > coarse). Palettes are material-owned WGSL (`pbr-mesh-lod-compose.ts`); the demo switches to CPU reference selection while a view is active so all views render. | ✅ |
| **REQ-DEMO-7** — uninterrupted coarse fallback while fine pages are delayed/paused/unavailable/terminally failed | Workflow test triggers the Paused, Offline (network unavailable), and Corrupt (terminal integrity failure) scenarios and asserts the statue remains completely represented (rendered > coarse) throughout; diagnostics expose fallback groups + failed/pending page counts. Delayed = high simulated latency. | ✅ |
| **Ready / error states** | Workflow test asserts `data-ready`. Error-state test aborts all `.mlod` requests, then asserts the canvas reaches `data-error` and the fatal-error banner (`#demoError`) becomes visible while the loading overlay hides. | ✅ |

## Notes

- **GPU vs CPU selection.** The demo defaults to the production GPU selection path;
  its async control-buffer readback drives streaming, diagnostics, and adaptive
  draw growth. Debug views switch to CPU reference selection (semantically the
  "diagnostic" path) because the per-cluster debug attribute is packed by the CPU
  expansion; both paths are proven equivalent by the Phase-5 equivalence fixtures.
- **Coarse-fallback demonstrations.** Offline/Corrupt scenarios fault-inject only
  `.mlod` traffic. Because the small statue can fully stream quickly, they most
  visibly demonstrate that already-resident geometry keeps rendering (no holes,
  no regression); when fine pages are demanded during the impaired window, the
  failed/pending counts rise while the coarse surface stays whole.
- **No parity/perf impact.** MeshLoD is tree-shaken from every parity scene, so the
  engine debug-view addition does not change any scene's rendering or bundle size.
