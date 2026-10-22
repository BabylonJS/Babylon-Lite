# Optional Navcat navigation

## Purpose and requirements

Issue [411](https://github.com/BabylonJS/Babylon-Lite/issues/411) adds a pure-JavaScript alternative alongside unchanged Recast. The agreed demo consumes offline-baked JSON; generation is independently optional. No Babylon.js API parity is claimed.

The MVP covers nearest polygon, complete/partial paths, surface raycasts/movement, custom passability/costs, solo generation, off-mesh connections, debug geometry, replacement and deterministic teardown. Crowd simulation, workers, dynamic obstacles and tiled generation are outside this version.

## Contracts

- Public handles are pure state; all behavior is standalone root-package exports. No SDK types, GPU handles or additional package entry points enter the public declarations.
- Public positions/directions use Lite left-handed Y-up coordinates. Raw JSON and generation input use Navcat right-handed Y-up/CCW coordinates. Convert Z exactly once at the boundary.
- Each manager exclusively owns a JSON-parsed mesh. Query results and debug arrays are caller-owned snapshots, never borrowed SDK buffers.
- Node reference 0 and connection ID 0 are valid. References become stale on mesh replacement, disposal or graph mutation; location/connection handles reject foreign managers and stale revisions.
- Query callbacks are synchronous. Nested queries or mutations from a callback throw a clear error, with recovery through `finally`; SDK scratch storage is shared and cannot support reentry.
- Never retain a scene, engine, DOM element, worker, timer, event hook or GPU allocation in the manager.

## Architecture

`navcat.ts` holds the async factory and lifecycle functions. It dynamically imports `navcat-runtime.ts`, which statically imports only named SDK query exports. `navcat-queries.ts` delegates synchronous queries through the initialized runtime. `navcat-state.ts` owns validation, lifecycle/reentry checks and coordinate conversion without importing the SDK at runtime.

`navcat-generation.ts` copies/validates input before importing `navcat-generation-runtime.ts` and `navcat/blocks`. `navcat-connections.ts` independently imports the connection runtime. `navcat-debug.ts` independently imports the debug runtime. A query-only consumer must retain none of these optional implementations. No changes are required in the render loop or Recast backend.

The native lib build bundles SDK code into ordinary chunks; query and generation must stay separable. Both bundled MIT licenses (Navcat 0.4.1 and mathcat 0.0.12) are included by the existing NOTICE pipeline. mathcat is explicitly declared for attribution resolution. Neither becomes a published runtime dependency or public type dependency. Three is unused.

## Specification links

- [API and results](navigation-navcat-api.md)
- [Ownership, JSON and filters](navigation-navcat-data.md)
- [Geometry and solo generation](navigation-navcat-generation.md)
- [Debugging and demo](navigation-navcat-demo.md)

## Verification and tasks

1. Verify exact-version SDK JSON/query/filter/link/winding and bundle feasibility with an original fixture.
2. Implement the specified modules and root exports, then the original offline-baked demo.
3. Real-SDK units cover asymmetric coordinate conversion, zero references, complete/partial paths, ray miss/hit, movement, filters, invalid inputs, stale handles, callback reentry and teardown/reload.
4. Generation tests cover physical option conversion, input ownership and transformed/mirrored/glTF ground. Debug tests cover owned arrays and stale search results.
5. Published-root probes check clean declarations/metadata, Node without WebGPU and positive query runtime behavior. Bundle probes prove unused-backend elimination and query-only generation/crowd/Recast/WASM exclusion with positive generation controls.
6. Build/run only the new demo and existing control scenes 165, 213 and Recast 170. Count all Navcat/mathcat runtime bytes; do not change thresholds, baseline data or goldens. Existing scene bytes must remain unchanged.
7. Run formatting, lint, all six type projects, native builds, scoped tests and composition with related open PRs. Review code/provenance/privacy before commit and ready PR.

## Pipeline / shader configuration

None: this is CPU navigation. Debug geometry is caller-owned data rendered using existing mesh/line factories; it introduces no shader or pipeline variant.

## File manifest

Native `navigation/navcat*.ts`; architecture `navigation-navcat*.md`; real-SDK unit/build tests; `lab/lite/src/demos/navcat.ts`, `lab/lite/demo-navcat.html`, original JSON asset/recipe, demo catalog and JPG thumbnail; native dependency/lockfile/license list updates.

## Usage

```ts
import { createNavcatManager, findNavcatPath, disposeNavcatManager } from "@babylonjs/lite";
const manager = await createNavcatManager(bakedNavMeshJson); // raw RH Navcat 0.4.1 JSON
const path = findNavcatPath(manager, { x: -4, y: 0, z: 2 }, { x: 4, y: 0, z: -2 });
// path.points are LH snapshots; path.success may describe a partial route.
disposeNavcatManager(manager);
```

## Verified behavior

The real-SDK suites cover 53 Navcat cases and 27 existing Recast cases. Published-root checks include external-SDK-free declarations, complete root API and both MIT texts. Shipped-library positive controls execute query-only and generation bundles; the unused backend is eliminated. Six intentional coordinate, partial-status, retention, stale-reference, winding and reentry mutants are detected. The original demo exercises desktop/mobile controls, replacement, disposal and reload without page/network errors. No parity or performance claim is made.
