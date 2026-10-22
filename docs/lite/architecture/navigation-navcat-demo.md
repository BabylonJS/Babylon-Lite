# Navcat debugging and query-only demo

```ts
interface NavcatDebugGeometry {
    kind: "triangles" | "lines" | "points";
    positions: Float64Array; colors: Float32Array; indices?: Uint32Array;
}
interface NavcatDebugOptions { navMesh?: boolean; connections?: boolean; search?: NavcatPathResult }
createNavcatDebugGeometry(manager: NavcatManager, options?: NavcatDebugOptions): Promise<NavcatDebugGeometry[]>;
```

## Debug behavior

The optional debug runtime uses named Navcat helpers for the mesh, off-mesh links and retained path search nodes. Defaults are mesh true, connections true, no search. A supplied search must belong to this manager and current graph revision. Check liveness/mesh version after import and again before reading search results.

Return copied LH CPU triangle/line/point primitives with parallel RGB colors. Reflect Z; triangles use Lite winding after the reflection. SDK helper results currently contain triangles, lines and points; reject unsupported kinds rather than silently dropping geometry. No GPU buffers, materials, scene references or hooks are stored or created by the adapter. Callers own rendering and release any meshes they create. The path itself is already a caller-owned polyline in `NavcatPathResult.points`.

## Demo

Developer story: load a small baked navigation asset, choose route endpoints, see a complete/partial path, apply a passability or cost filter, inspect debug geometry, dispose and reload the backend. No Wasm download or in-browser generation is needed.

Use the existing lab engine/camera/light/standard-material/line factories. A procedural floor surrounding the central hole matches the original fixture; start/end markers and a path visualize queries in Lite coordinates. Select controls offer asymmetric start/end presets. Buttons query, replace/reload, dispose and reset the backend. A filter selector demonstrates a closed region and weighted traversal; a debug checkbox shows the baked mesh. Status announces ready/failure/path completeness and current route point count with `role=status`/aria-live. Controls remain keyboard accessible, responsive and labeled. Link to the pinned upstream SDK and docs for developer context.

The default runtime path imports only manager/query and optional CPU debug code; do not call the generation or connection mutation enablers in this demo. A fixture may include a baked connection if desired; unit tests verify dynamic mutation independently. Show graph teardown visibly by clearing debug/path geometry and reporting disposal; repeated reload/query must work.

Do not modify golden references or scene-config thresholds: maintainers explicitly requested a demo for this new API. Register `navcat` in demos-config.json and create its HTML/script, original JSON + recipe, and 1280×720 JPG in lab/public/thumbnails/demo-navcat.jpg. Demos are loaded through the existing production-bundle mechanism, outside parity scene registration.

## Validation

Build the native package and the single demo, exercise controls in Chrome, inspect actual network JS/WASM requests and the generated chunk graph. Query-only runtime must fetch no generator, crowd, Recast, Three or WASM. Full Navcat/mathcat bytes count toward runtime size; they are not excluded by the Recast/vendor accounting rules. Verify disposal/reload, no console/page errors and a representative thumbnail. Rendering uses existing APIs with no shader changes or parity claims.
