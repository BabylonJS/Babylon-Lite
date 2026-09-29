# Task 1.4: Build Clustered Hierarchy and Meshlets

## Goal

Convert normalized primitives into validated clustered group-DAG data and an eight-wide hierarchy forest.

## Requirements addressed

REQ-TOOL-4, REQ-GEO-5, REQ-GEO-6, REQ-GEO-7

## Background

Task 1.3 supplies indexed primitive-local geometry. This task uses the pinned meshoptimizer `clusterlod.h` algorithms and produces an in-memory hierarchy; file encoding is deferred.

## Files to modify/create

- `mesh-lod-tool/src/hierarchy.h`, `mesh-lod-tool/src/hierarchy.cpp` — cluster/group DAG and spatial forest.
- `mesh-lod-tool/src/normalize.*` — boundary-protection metadata if required.
- `mesh-lod-tool/tests/tool_tests.cpp` — hierarchy invariants.

## APIs and structs involved

- Internal group fields matching the future 64-byte group record.
- Internal cluster fields matching the future 64-byte cluster record.
- Internal hierarchy node fields matching the future 32-byte eight-wide node.
- `clodBuild`, `clodLocalIndices`, `clodBuildHierarchy(node_width=8)`.

## Implementation details

1. Define `CLUSTERLOD_IMPLEMENTATION` in exactly one translation unit.
2. Preserve UV seams/shared group boundaries with mandatory simplification protection.
3. Run clustered LOD generation with canonical CLI settings.
4. Record callback order, group depth/error, contiguous clusters, `refinedGroupId`, bounds, source triangle coverage, and original vertex indices.
5. Generate meshlet-local indices with `clodLocalIndices`.
6. Build one eight-wide spatial tree per DAG depth; roots occupy the first `levelCount` nodes.
7. Mark finite `FLT_MAX` terminal groups and validate that they form complete coarse coverage.
8. Validate references, contiguity, bounds, finite errors, cluster limits, and exact surface coverage on small fixtures.

## Targeted tests

- Single triangle group, multi-level simplification, seam protection, multiple material primitives.
- Exhaustive small-DAG cut enumeration proving no missing/duplicate regions.

## Gotchas

- Simplification must never cross primitive/material boundaries.
- Runtime crack freedom depends on both offline boundary locking and later atomic group residency.

## Dependencies

- Task 1.3 normalized geometry.

## Verification checklist

- [ ] Non-empty fixtures emit groups, clusters, and hierarchy nodes.
- [ ] Terminal groups cover the complete source surface.
- [ ] All references and meshlet limits validate.
- [ ] Hierarchy tests pass.
