# Navcat geometry and solo generation

```ts
interface NavcatGeometry { positions: Float64Array; indices: Uint32Array }
interface NavcatBuildOptions {
    cellSize?: number; cellHeight?: number;
    agentRadius?: number; agentHeight?: number; maxClimb?: number; maxSlope?: number;
    minRegionArea?: number; mergeRegionArea?: number;
    maxSimplificationError?: number; maxEdgeLength?: number; maxVerticesPerPoly?: number;
    detailSampleDistance?: number; detailSampleMaxError?: number;
}
extractNavcatGeometry(meshes: readonly Mesh[]): NavcatGeometry;
generateNavcatMesh(geometry: NavcatGeometry, options?: NavcatBuildOptions): Promise<string>;
```

## Source geometry

Extraction returns caller-owned RH/CCW CPU triangles. Read retained `_cpuPositions`, `_cpuIndices` and the up-to-date `worldMatrix`; do not copy normals or require shading data. Concatenate selected mesh vertices with index offsets. Reject missing/malformed/nonfinite geometry, invalid indices, non-triangle topology, singular/non-affine transforms, retired meshes and live skeleton/morph/VAT/thin-instance geometry. This operation represents selected static geometry, not an animated frame or instance expansion. Caller may bake/expand such geometry before extraction.

Transform each local point by column-major affine world matrix, then negate world Z. Keep Float64 precision throughout. With determinant sign `s` and authored sign `a = mesh._authoredSign ?? 1`, swap each triangle's last two indices iff `s !== a`. This matches Lite's rendered authored front face: procedural ground has LH winding and glTF's RH geometry is marked authored sign -1 under its root Z flip. Do not unconditionally reverse winding after the Z reflection.

Zero/negative scale, translation, nonuniform scale and parent transforms are covered through the current world matrix. Empty mesh lists fail clearly. The helper changes neither source geometry nor any mesh state and does not reference a scene/engine.

## Generation

`generateNavcatMesh` consumes RH/CCW geometry, not Lite-local arrays. Copy all positions/indices and normalized options synchronously, before any import await. Validate complete triples, finite positions and in-range integral indices before typed conversion. Preserve float64 position precision.

After lazy importing the generation runtime, call pinned SDK `generateSoloNavMesh` from `navcat/blocks`; serialize only its `navMesh`. Intermediates are local and discarded. No manager, workers, timers, Three, Recast or WASM are created. An empty/unwalkable generated mesh remains valid JSON whose queries return failure. Generation is synchronous CPU work after the async import and is intended for offline tooling or explicit application use.

Default options are cellSize .15, cellHeight .1, agentRadius .3, agentHeight 1.8, maxClimb .4, maxSlope 45 degrees, minRegionArea 1, mergeRegionArea 20, maxSimplificationError 1.3, maxEdgeLength 12, maxVerticesPerPoly 6, detailSampleDistance .9 and detailSampleMaxError .1.

Derive SDK voxel radius/height with ceil(world/cell), climb with floor(world/cell); pass physical values unchanged for the SDK world fields. borderSize is 0 (solo mesh). Region/edge/detail settings otherwise pass through unchanged to the named SDK options. Cell dimensions and height are positive; radius/climb/region/error/edge/detail values are nonnegative; slope is in [0,90]; maxVerticesPerPoly is an integer in [3,6].

## Original fixture and provenance

A checked-in recipe builds a 12×8 ground with a central 2×4 rectangular hole from independently authored unit quads. It generates raw Navcat JSON with the default physical options. Source positions are RH/CCW. The recipe marks the lower central passage as area 2 for passability/cost demonstrations. The query-only demo loads this JSON and does not import the recipe or generator. No third-party geometry, demo source or copied navigation algorithms are included.

## Tests

Generate/query a real flat ground, then mirrored and glTF-authored equivalents. Assert translated/scaled coordinates and unchanged source arrays. Reject unsupported geometry explicitly. Verify input mutation after starting generation cannot alter the result, custom build parameters survive in JSON, invalid options fail before SDK execution, and generation is absent from a query-only production bundle with an observable positive generation control.
