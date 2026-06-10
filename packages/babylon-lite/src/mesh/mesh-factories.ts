/** High-level mesh factory functions.
 *  Each creates geometry, uploads to GPU, and returns a Mesh.
 *  The caller adds to the scene via addToScene(scene, mesh).
 *
 *  Pillar 4b: plain data, no scene reference.
 *  Pillar 4c: materials own shaders — mesh just holds material props. */

import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "./mesh.js";
import { initMeshTransform, uploadMeshToGPU } from "./mesh.js";
import { computeAabb } from "../math/compute-aabb.js";
import { createSphereData } from "./create-sphere.js";
import type { SphereOptions } from "./create-sphere.js";
import { createBoxData } from "./create-box.js";
import { createTorusData } from "./create-torus.js";
import type { TorusOptions } from "./create-torus.js";
import { createTorusKnotData } from "./create-torus-knot.js";
import type { TorusKnotOptions } from "./create-torus-knot.js";
import { createFlatGroundData, createGroundFromHeightMap as createGroundCPU } from "./create-ground.js";
import type { GroundOptions } from "./create-ground.js";
import { createCylinderData } from "./create-cylinder.js";
import type { CylinderOptions } from "./create-cylinder.js";
import { createPlaneData } from "./create-plane.js";
import type { PlaneOptions } from "./create-plane.js";
import { createDiscData } from "./create-disc.js";
import type { DiscOptions } from "./create-disc.js";
import { createPolyhedronData } from "./create-polyhedron.js";
import type { PolyhedronOptions } from "./create-polyhedron.js";
import { createRibbonData } from "./create-ribbon.js";
import type { RibbonOptions } from "./create-ribbon.js";
import { createTubeData } from "./create-tube.js";
import type { TubeOptions } from "./create-tube.js";
import { createExtrudeShapeData } from "./create-extrude.js";
import type { ExtrudeShapeOptions } from "./create-extrude.js";

/** Create a Mesh from raw geometry data + GPU device.
 *  No material is assigned — the caller must set mesh.material before adding to scene. */
export function createMeshFromData(
    engine: EngineContext,
    name: string,
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    uvs?: Float32Array,
    uvs2?: Float32Array,
    tangents?: Float32Array,
    colors?: Float32Array
): Mesh {
    const [min, max] = computeAabb(positions);
    const mesh = {
        name,
        material: null as unknown,
        receiveShadows: false,
        boundMin: isFinite(min[0]) ? min : undefined,
        boundMax: isFinite(max[0]) ? max : undefined,
        _materialDirty: false,
        _gpu: uploadMeshToGPU(engine, positions, normals, indices, uvs, uvs2, tangents, colors),
    } as unknown as Mesh;
    initMeshTransform(mesh);

    // Retain CPU geometry for detailed picking (ray-triangle intersection)
    mesh._cpuPositions = positions;
    mesh._cpuNormals = normals;
    mesh._cpuUvs = uvs;
    mesh._cpuIndices = indices;
    engine._dlr?.m(mesh, uvs2 ?? null, tangents ?? null, colors ?? null, indices, "uint32");

    return mesh;
}

/** Force every registered scene's cached render + shadow bundles to RE-RECORD on the next frame, by bumping
 *  each rendering context's `_renderableVersion` (the same signal a mesh add/remove or `resizeMeshGeometry`
 *  emits). Use after an out-of-band GPU buffer REALLOCATION that the cached bundles can't otherwise notice —
 *  e.g. growing a thin-instanced mesh's matrix buffer past its capacity (the bundle captured the old buffer
 *  handle and would bind a freed buffer). A no-op-cheap version bump; the actual re-record happens lazily. */
export function invalidateRenderBundles(engine: EngineContext): void {
    for (const ctx of engine._renderingContexts) {
        const sc = ctx as { _renderableVersion?: number };
        if (sc._renderableVersion !== undefined) {
            sc._renderableVersion++;
        }
    }
}

/** Update a mesh's GPU vertex positions in place (e.g. CPU vertex animation).
 *  `positions` must hold tightly-packed XYZ floats matching the mesh's vertex count.
 *  `vertexOffset` is the first vertex to overwrite (defaults to 0).
 *  The mesh must have been created via createMeshFromData / a mesh factory.
 *  Zero-allocation GPU upload only — CPU-side picking geometry is not refreshed. */
export function updateMeshPositions(engine: EngineContext, mesh: Mesh, positions: Float32Array, vertexOffset = 0): void {
    const gpu = mesh._gpu;
    engine._device.queue.writeBuffer(gpu.positionBuffer, vertexOffset * 3 * 4, positions.buffer as ArrayBuffer, positions.byteOffset, positions.byteLength);
}

/** Replace a mesh's GPU geometry IN PLACE with new (possibly larger or smaller) buffers, reusing the
 *  same Mesh object so existing references to it (scene entries, shadow-caster lists, materials) stay
 *  valid. Unlike `updateMeshPositions`, this REALLOCATES the GPU buffers, so it's the way to GROW a
 *  dynamically-generated mesh past its original vertex/index capacity (e.g. an ever-larger bridge whose
 *  box budget overflows). The old GPU buffers are destroyed to free device memory. Recomputes bounds. */
export function resizeMeshGeometry(
    engine: EngineContext,
    mesh: Mesh,
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    uvs?: Float32Array,
    uvs2?: Float32Array,
    tangents?: Float32Array,
    colors?: Float32Array
): void {
    const old = mesh._gpu;
    // A geometry REALLOCATION: any cached draw recording that captured raw buffer handles (e.g. the main
    // opaque render bundle or the shadow task's bundle) must re-record, or it would keep binding the OLD
    // buffers we're about to free. Resize is a structural (vertex-count) change — conceptually a scene
    // mutation — so bump every registered scene's renderable version, which is exactly what the cached
    // bundles already key off to know they must rebuild. (A mesh holds no scene reference per pillar 4b,
    // so we can't target just its owner; bumping all registered scenes is a no-op for any without it.)
    for (const ctx of engine._renderingContexts) {
        const sc = ctx as { _renderableVersion?: number };
        if (sc._renderableVersion !== undefined) {
            sc._renderableVersion++;
        }
    }
    // Allocate the NEW buffers and swap them in FIRST, so any subsequent frame records from the new
    // geometry. The OLD buffers may still be referenced by a frame that was already submitted to the GPU
    // this tick, so we must NOT destroy them synchronously — that hits the validation error
    // "Buffer used in submit while destroyed". Defer their destruction until the GPU has drained the
    // currently-submitted work (onSubmittedWorkDone), by which point nothing references them.
    mesh._gpu = uploadMeshToGPU(engine, positions, normals, indices, uvs, uvs2, tangents, colors);
    const [min, max] = computeAabb(positions);
    mesh.boundMin = isFinite(min[0]) ? min : undefined;
    mesh.boundMax = isFinite(max[0]) ? max : undefined;

    // Retain CPU geometry for detailed picking + device-loss recovery (mirror createMeshFromData).
    mesh._cpuPositions = positions;
    mesh._cpuNormals = normals;
    mesh._cpuUvs = uvs;
    mesh._cpuIndices = indices;
    engine._dlr?.m(mesh, uvs2 ?? null, tangents ?? null, colors ?? null, indices, "uint32");

    void engine._device.queue
        .onSubmittedWorkDone()
        .then(() => {
            try {
                old.positionBuffer.destroy();
                old.normalBuffer.destroy();
                old.indexBuffer.destroy();
                old.uvBuffer.destroy();
                old.uv2Buffer?.destroy();
                old.tangentBuffer?.destroy();
                old.colorBuffer?.destroy();
            } catch {
                // Device may have been lost/disposed before the deferred destroy ran — nothing to free.
            }
        })
        .catch(() => {});
}

/** Re-upload (part of) a mesh's NORMAL buffer — the twin of `updateMeshPositions` for dynamically
 *  re-generated geometry whose per-vertex normals change (e.g. a swept tube re-fitted each rebuild).
 *  No-op if the mesh was created without normals. Zero-allocation GPU upload only. */
export function updateMeshNormals(engine: EngineContext, mesh: Mesh, normals: Float32Array, vertexOffset = 0): void {
    const gpu = mesh._gpu;
    if (!gpu.normalBuffer) {
        return;
    }
    engine._device.queue.writeBuffer(gpu.normalBuffer, vertexOffset * 3 * 4, normals.buffer as ArrayBuffer, normals.byteOffset, normals.byteLength);
}

/** Re-upload (part of) a mesh's COLOR buffer — the twin of `updateMeshNormals`/`updateMeshPositions`
 *  for dynamically re-generated geometry whose per-vertex colors change (e.g. a procedural mesh whose
 *  parts are re-tinted each rebuild). The color attribute is vec4 (16 bytes/vertex). No-op if the mesh
 *  was created without colors. Zero-allocation GPU upload only. */
export function updateMeshColors(engine: EngineContext, mesh: Mesh, colors: Float32Array, vertexOffset = 0): void {
    const gpu = mesh._gpu;
    if (!gpu.colorBuffer) {
        return;
    }
    engine._device.queue.writeBuffer(gpu.colorBuffer, vertexOffset * 4 * 4, colors.buffer as ArrayBuffer, colors.byteOffset, colors.byteLength);
}

/** Re-upload (part of) a mesh's UV buffer — the twin of `updateMeshNormals`/`updateMeshColors` for
 *  dynamically re-generated geometry whose per-vertex UVs change (e.g. a procedural mesh whose parts
 *  carry per-rebuild UV payloads). The uv attribute is vec2 (8 bytes/vertex). No-op if the mesh was
 *  created without UVs. Zero-allocation GPU upload only. */
export function updateMeshUvs(engine: EngineContext, mesh: Mesh, uvs: Float32Array, vertexOffset = 0): void {
    const gpu = mesh._gpu;
    if (!gpu.uvBuffer) {
        return;
    }
    engine._device.queue.writeBuffer(gpu.uvBuffer, vertexOffset * 2 * 4, uvs.buffer as ArrayBuffer, uvs.byteOffset, uvs.byteLength);
}

/** Re-upload (part of) a mesh's second UV buffer (uv2) — the twin of `updateMeshUvs` for dynamically
 *  re-generated geometry whose per-vertex uv2 payload changes each rebuild (e.g. a procedural batch that
 *  re-bakes per-vertex AO / gradient data). The uv2 attribute is vec2 (8 bytes/vertex). No-op if the mesh
 *  was created without uv2. Zero-allocation GPU upload only. */
export function updateMeshUv2(engine: EngineContext, mesh: Mesh, uvs2: Float32Array, vertexOffset = 0): void {
    const gpu = mesh._gpu;
    if (!gpu.uv2Buffer) {
        return;
    }
    engine._device.queue.writeBuffer(gpu.uv2Buffer, vertexOffset * 2 * 4, uvs2.buffer as ArrayBuffer, uvs2.byteOffset, uvs2.byteLength);
}

/** Re-upload (part of) a mesh's TANGENT buffer — the twin of `updateMeshColors` for dynamically
 *  re-generated geometry whose per-vertex tangent (vec4) payload changes each rebuild (e.g. a procedural
 *  batch that streams a per-vertex coordinate frame / mask through the tangent slot). The tangent attribute
 *  is vec4 (16 bytes/vertex). No-op if the mesh was created without tangents. Zero-allocation GPU upload only. */
export function updateMeshTangents(engine: EngineContext, mesh: Mesh, tangents: Float32Array, vertexOffset = 0): void {
    const gpu = mesh._gpu;
    if (!gpu.tangentBuffer) {
        return;
    }
    engine._device.queue.writeBuffer(gpu.tangentBuffer, vertexOffset * 4 * 4, tangents.buffer as ArrayBuffer, tangents.byteOffset, tangents.byteLength);
}

/** Create a sphere mesh. Caller must assign material. */
export function createSphere(engine: EngineContext, options?: SphereOptions): Mesh {
    const data = createSphereData(options);
    return createMeshFromData(engine as EngineContext, "sphere", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a box mesh. Caller must assign material. */
export function createBox(engine: EngineContext, size = 1): Mesh {
    const data = createBoxData(size);
    return createMeshFromData(engine as EngineContext, "box", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a torus mesh. Caller must assign material. */
export function createTorus(engine: EngineContext, options?: TorusOptions): Mesh {
    const data = createTorusData(options);
    return createMeshFromData(engine as EngineContext, "torus", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a torus-knot mesh. Caller must assign material. */
export function createTorusKnot(engine: EngineContext, options?: TorusKnotOptions): Mesh {
    const data = createTorusKnotData(options);
    return createMeshFromData(engine as EngineContext, "torusKnot", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a ground mesh from a heightmap URL. Caller must assign material. */
export async function createGroundFromHeightMap(engine: EngineContext, url: string, options: GroundOptions): Promise<Mesh> {
    const data = await createGroundCPU(url, options);
    return createMeshFromData(engine as EngineContext, "ground", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a flat ground mesh. Caller must assign material. */
export function createGround(engine: EngineContext, options?: GroundOptions): Mesh {
    const data = createFlatGroundData(options);
    return createMeshFromData(engine as EngineContext, "ground", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a cylinder (or cone / truncated cone / prism) mesh. Caller must assign material. */
export function createCylinder(engine: EngineContext, options?: CylinderOptions): Mesh {
    const data = createCylinderData(options);
    return createMeshFromData(engine as EngineContext, "cylinder", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a plane (unit quad facing -Z). Caller must assign material. */
export function createPlane(engine: EngineContext, options?: PlaneOptions): Mesh {
    const data = createPlaneData(options);
    return createMeshFromData(engine as EngineContext, "plane", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a disc (or ring / pie slice via `arc`). Caller must assign material. */
export function createDisc(engine: EngineContext, options?: DiscOptions): Mesh {
    const data = createDiscData(options);
    return createMeshFromData(engine as EngineContext, "disc", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a polyhedron (15 presets). Caller must assign material. */
export function createPolyhedron(engine: EngineContext, options?: PolyhedronOptions): Mesh {
    const data = createPolyhedronData(options);
    return createMeshFromData(engine as EngineContext, "polyhedron", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a ribbon from an array of parallel Vec3 paths. Caller must assign material. */
export function createRibbon(engine: EngineContext, options: RibbonOptions): Mesh {
    const data = createRibbonData(options);
    return createMeshFromData(engine as EngineContext, "ribbon", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a tube (circular cross-section swept along a path). Caller must assign material. */
export function createTube(engine: EngineContext, options: TubeOptions): Mesh {
    const data = createTubeData(options);
    return createMeshFromData(engine as EngineContext, "tube", data.positions, data.normals, data.indices, data.uvs);
}

/** Create an extruded shape (2D shape swept along a path). Caller must assign material. */
export function createExtrudeShape(engine: EngineContext, options: ExtrudeShapeOptions): Mesh {
    const data = createExtrudeShapeData(options);
    return createMeshFromData(engine as EngineContext, "extrude", data.positions, data.normals, data.indices, data.uvs);
}
