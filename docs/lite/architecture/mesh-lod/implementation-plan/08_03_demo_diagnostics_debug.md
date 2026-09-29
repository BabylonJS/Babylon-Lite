# Task 8.3: Add Diagnostics, Debug Views, and Fallback Scenarios

## Goal

Expose required live metrics, material-owned debug palettes/legends, GPU timing status, and visible coarse-fallback demonstrations.

## Requirements addressed

REQ-DEMO-5, REQ-DEMO-6, REQ-DEMO-7

## Background

Task 8.2 provides controls and deterministic scenarios. Runtime diagnostics already expose selection/request/cache values; GPU timing uses existing render-task timing APIs.

## Files to modify/create

- `lab/lite/src/demos/mesh-lod-diagnostics.ts`
- `lab/lite/src/demos/mesh-lod.ts`
- `lab/lite/demo-mesh-lod.html`
- `packages/babylon-lite/src/material/pbr/pbr-mesh-lod-renderable.ts` — final debug output variants/legend values if not complete.
- `tests/lite/unit/mesh-lod/mesh-lod-debug-view.test.ts`

## APIs and structs involved

- `getMeshLoDDiagnostics`, `setMeshLoDDebugView`.
- Debug modes: none, meshlet ID, LOD depth, selected group, page residency, requested pages.
- Render-task GPU timing status.

## Implementation details

1. Update source/rendered triangles, selected meshlets, visible/fallback groups, depth, selected/unmet SSE, page state counts, bytes, GPU/CPU cache, concurrency, and pause state.
2. Label bytes as MiB and distinguish selected versus unmet SSE.
3. Show GPU timing duration only when supported; otherwise show `unsupported`.
4. Implement stable hash/palette debug colors in the PBR-owned fragment output and a visible active legend.
5. Add reproducible delayed, paused, unavailable, and terminal-failure controls/scenarios.
6. Keep debug output observational: no selection/residency/demand mutation.

## Targeted tests

- Diagnostics formatting/status tests.
- Debug view key/palette tests.
- Manual screenshots/checks for all five views and fallback scenarios.

## Gotchas

- Zero must not represent unsupported timing.
- Page failure colors must not imply the coarse surface is missing.

## Dependencies

- Tasks 8.1–8.2 and Phase 6 diagnostics.

## Verification checklist

- [ ] Every required metric updates live.
- [ ] Every debug mode has a visible legend.
- [ ] Unsupported timing is explicit.
- [ ] Statue remains complete in all fallback scenarios.
