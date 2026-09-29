# Task 8.2: Add Controls, Network Simulation, and Camera Path

## Goal

Add all required runtime controls, `.mlod`-only network simulation, and deterministic/manual camera behavior.

## Requirements addressed

REQ-DEMO-3, REQ-DEMO-4

## Background

Task 8.1 provides the running statue demo. Controls must call public runtime setters and the custom fetch seam rather than mutate internal state.

## Files to modify/create

- `lab/lite/src/demos/mesh-lod-controls.ts`
- `lab/lite/src/demos/mesh-lod-network-simulator.ts`
- `lab/lite/src/demos/mesh-lod-camera-path.ts`
- `lab/lite/src/demos/mesh-lod.ts`
- `lab/lite/demo-mesh-lod.html`

## APIs and structs involved

- `setMeshLoDScreenSpaceError`, `setMeshLoDCacheBudget`, `setMeshLoDStreamingPaused`, `setMeshLoDDebugView`.
- `MeshLoDRequestOptions.fetch`.

## Implementation details

1. Add SSE 0.5–16 px, budget 32–256 MiB, pause, bandwidth unlimited/0.5–64 MiB/s, latency 0–2000 ms, camera path toggle/reset, and debug selector.
2. Display effective values and validation errors.
3. Implement a fetch-compatible wrapper that delays/throttles only `.mlod` range response bodies while preserving headers/status/abort behavior.
4. Implement the 20-second looping two-segment smoothstep path around transformed aggregate bounds.
5. Advance automated mode at fixed 60 Hz; pointer/wheel/touch pauses, reset returns to `t=0`.
6. Ensure pause stops new fine progress without removing resident geometry.

## Targeted tests

- Unit tests for throttle/latency/abort/range preservation.
- Camera state assertions at 0, 5, 10, and 15 seconds.
- Manual control checklist.

## Gotchas

- Do not wrap unrelated environment/GLB/texture traffic.
- Do not use wall-clock integration for deterministic path samples.

## Dependencies

- Task 8.1.

## Verification checklist

- [ ] Every control changes public runtime state.
- [ ] Network simulation affects only page traffic.
- [ ] Deterministic timestamps repeat exactly.
- [ ] Manual interaction pauses the path.
