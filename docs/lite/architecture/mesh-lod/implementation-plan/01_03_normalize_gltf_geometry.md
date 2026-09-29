# Task 1.3: Normalize Supported glTF Geometry

## Goal

Use cgltf to parse, validate, select, and normalize supported glTF/GLB primitives into deterministic indexed CPU geometry.

## Requirements addressed

REQ-TOOL-3, REQ-GEO-1, REQ-GEO-2, REQ-GEO-3, REQ-GEO-4, REQ-TOOL-9

## Background

Tasks 1.1–1.2 provide the native build and selected mesh/primitive indices. This task creates the converter's strict source boundary before meshoptimizer is called.

## Files to modify/create

- `mesh-lod-tool/src/input.h`, `mesh-lod-tool/src/input.cpp` — cgltf parse/load/validate and selection.
- `mesh-lod-tool/src/normalize.h`, `mesh-lod-tool/src/normalize.cpp` — normalized vertices/indices and normals.
- `mesh-lod-tool/tests/fixtures/**` — supported and rejected minimal assets.
- `mesh-lod-tool/tests/tool_tests.cpp` — ingestion tests.

## APIs and structs involved

- Internal `NormalizedPrimitive`: mesh/primitive indices, positions `float32x3`, normals `float32x3`, UV0 `float32x2`, `uint32` indices, material facts, bounds.
- cgltf implementation macro belongs only in `input.cpp`.

## Implementation details

1. Parse with cgltf, load buffers, and call cgltf validation before accessor reads.
2. Select primitives in source order according to `ConversionOptions`.
3. Reject non-TRIANGLES, skins, morphs, alpha mask/blend, transmission, unsupported compression, sparse/unsupported layouts, bad strides, and non-finite data.
4. Require `POSITION`; require UV0 only when the material uses supported textures.
5. Materialize indexed geometry; generate sequential indices for unindexed input.
6. Generate finite angle-weighted normals when absent.
7. Preserve primitive-local coordinates and material boundaries.
8. Include mesh/primitive/accessor/extension context in errors.

## Targeted tests

- Equivalent `.gltf`/`.glb`, indexed/unindexed, missing normals, optional UV.
- One fixture for each required rejection class and malformed accessor/index case.

## Gotchas

- Never silently decode unsupported source compression.
- Bounds and generated normals must reject non-finite results.

## Dependencies

- Task 1.2 CLI and primitive selection.

## Verification checklist

- [ ] Supported fixtures normalize identically.
- [ ] Unindexed geometry becomes valid indexed geometry.
- [ ] Every unsupported case returns exit 4 or 5 with context.
- [ ] Input tests pass.
