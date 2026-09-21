# Inspector Material and Texture Parity Goals

## Context

Issue #55 tracks Inspector Lite. This feature delivers its P4 milestone: expand Inspector v2 material and texture inspection parity for Babylon Lite.

## Goals

- Expand the existing public-only `getMaterialFamily` and `getMaterialTextures` discovery contracts into complete Inspector v2 material and texture inspection flows without private-field or GPU-handle duck typing.
- Define and implement an explicit coverage matrix for every Babylon Lite material family and texture kind exposed by those public contracts. For each supported property, classify whether Inspector displays it, edits it, or navigates through it; unsupported Babylon.js-only state must be omitted rather than simulated.
- Present deterministic material and texture identity, display names, family/type information, and supported properties with behavior consistent with Inspector v2.
- Let users navigate from an inspected material to each referenced texture and keep displayed values current when scene state changes at runtime.
- Route edits through public Lite setters and the required `markMaterialUboDirty` or `rebuildMaterial` path so uniform-only changes, shader-feature changes, and shared-texture consumers update correctly.
- Preserve Babylon Lite's pure-state, one-way ownership, root-only public API, and zero-module-side-effect architecture.
- Avoid exposing raw WebGPU handles through public APIs.
- Keep Inspector integration optional and verify zero runtime-loaded byte growth for representative applications that do not enable it.
- Cover the supported material and texture inspection behavior with focused tests and repository-required quality checks.

## Non-Goals

- Texture preview and export tooling, tracked separately as P11b in issue #55.
- New rendering features or broader Babylon.js material APIs solely to make unsupported properties appear in Inspector.
- Inspection of non-public implementation details, raw WebGPU resources, or Babylon.js-only material and texture types that have no Lite equivalent.
- Visual/parity golden updates or bundle-size ceiling changes.
