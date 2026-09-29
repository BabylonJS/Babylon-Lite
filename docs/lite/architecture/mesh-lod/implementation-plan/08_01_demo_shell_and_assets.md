# Task 8.1: Build Demo Shell and Asset Packaging

## Goal

Create the standalone production-bundled MeshLoD statue demo using the same public lazy runtime path as applications.

## Requirements addressed

REQ-DEMO-1, REQ-DEMO-2, REQ-DEMO-3, REQ-NAME-3

## Background

The engine feature is complete. Follow `mosquito-amber.ts:40-121`, `demo-mosquito-amber.html:44-114`, and `bundle-demos-core.ts:202-282`. The demo loads the source GLB only for its three materials/node transforms, then removes/hides ordinary meshes and creates three MeshLoD instances.

## Files to modify/create

- `lab/lite/demo-mesh-lod.html`
- `lab/lite/src/demos/mesh-lod.ts`
- `demos-config.json` — `mesh-lod` gallery entry.
- `scripts/bundle-demos-core.ts` — copy `lab/public/mesh-lod`.
- `lab/public/thumbnails/demo-mesh-lod.jpg`

## APIs and structs involved

- Public engine/scene/glTF/MeshLoD APIs.
- `data-ready`, `data-error`, loading progress attributes.

## Implementation details

1. Create the standard fullscreen WebGPU page/loading overlay and accessible control/diagnostic containers.
2. Load environment, source GLB materials/transforms, and all three `.mlod` assets.
3. Create three instances using exact material objects and transforms; remove ordinary geometry before registration.
4. Add orbit/zoom camera framed from aggregate statue bounds.
5. Signal ready only after scene registration/first frame; set explicit error text/state on failure.
6. Add gallery metadata and a 1280×720 JPG thumbnail.
7. Copy MeshLoD assets into flat demo output for single/full demo builds.

## Targeted tests

- `pnpm build:bundle-demo mesh-lod`.
- Static inspection that built HTML/JS/assets exist and the demo imports public APIs only.

## Gotchas

- No demo-only loader/selector/cache/renderer.
- Demo-only GLB material preparation must not become a runtime dependency.

## Dependencies

- Phase 7 and Task 2.4 assets.

## Verification checklist

- [ ] Gallery card and thumbnail exist.
- [ ] Production bundle contains three `.mlod` assets.
- [ ] Demo reaches ready/error states correctly.
- [ ] Ordinary source meshes are not rendered.
