/** High-level mesh factory functions.
 *  Each creates geometry, uploads to GPU, and returns a Mesh.
 *  The caller adds to the scene via addToScene(scene, mesh).
 *
 *  Pillar 4b: plain data, no scene reference.
 *  Pillar 4c: materials own shaders — mesh just holds material props. */

import { bumpVisibilityEpoch, type EngineContext } from "../engine/engine.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { release } from "../resource/ref-count.js";
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
import { createCapsuleData } from "./create-capsule.js";
import type { CapsuleOptions } from "./create-capsule.js";
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
import { _markWorldMatrixDirty } from "../scene/world-matrix-state.js";

export interface MeshGeometryCapacityResult {
    readonly stable: boolean;
    readonly vertexCapacity: number;
    readonly indexCapacity: number;
}

function retainMeshGeometry(
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
    const [min, max] = computeAabb(positions);
    mesh.boundMin = isFinite(min[0]) ? min : undefined;
    mesh.boundMax = isFinite(max[0]) ? max : undefined;
    mesh._cpuPositions = positions;
    mesh._cpuNormals = normals;
    mesh._cpuUvs = uvs?.length ? uvs : undefined;
    mesh._cpuUv2s = uvs2?.length ? uvs2 : null;
    mesh._cpuTangents = tangents?.length ? tangents : null;
    mesh._cpuColors = colors?.length ? colors : null;
    mesh._cpuIndices = indices;
    mesh._cpuGpuIndices = indices;
    mesh._cpuIndexFormat = "uint32";
    engine._dlr?.m(mesh, mesh._cpuUv2s, mesh._cpuTangents, mesh._cpuColors, indices, "uint32");
}

function validateCapacityGeometry(
    mesh: Mesh,
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    uvs?: Float32Array,
    uvs2?: Float32Array,
    tangents?: Float32Array,
    colors?: Float32Array
): number {
    const gpu = mesh._gpu;
    const vertexCount = positions.length / 3;
    if (gpu._vbLayout || (gpu._refCount ?? 1) > 1) {
        throw new Error("updateMeshGeometryCapacity requires unshared, tightly-packed mesh geometry");
    }
    if (!Number.isInteger(vertexCount) || normals.length !== positions.length || indices.length % 3 !== 0 || gpu.indexFormat !== "uint32") {
        throw new Error("updateMeshGeometryCapacity requires coherent triangle-list geometry with uint32 indices");
    }
    const hasUvs = !!uvs && uvs.length > 0;
    const hasUv2s = !!uvs2 && uvs2.length > 0;
    const hasTangents = !!tangents && tangents.length > 0;
    const hasColors = !!colors && colors.length > 0;
    if (
        hasUvs !== !!gpu.hasUv ||
        (hasUvs && uvs!.length !== vertexCount * 2) ||
        hasUv2s !== !!gpu.hasUv2 ||
        (hasUv2s && uvs2!.length !== vertexCount * 2) ||
        hasTangents !== !!gpu.hasTangent ||
        (hasTangents && tangents!.length !== vertexCount * 4) ||
        hasColors !== !!gpu.hasColor ||
        (hasColors && colors!.length !== vertexCount * 4)
    ) {
        throw new Error("updateMeshGeometryCapacity requires unchanged optional-attribute layout");
    }
    return vertexCount;
}

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

/** Force cached render + shadow bundles to RE-RECORD on the next frame. The global epoch also reaches
 *  tasks recorded before their scene was registered; registered scenes retain their structural version bump. */
export function invalidateRenderBundles(engine: EngineContext): void {
    bumpVisibilityEpoch();
    for (const ctx of engine._renderingContexts) {
        const sc = ctx as { _renderableVersion?: number };
        if (sc._renderableVersion !== undefined) {
            sc._renderableVersion++;
        }
    }
}

/** Update a mesh's GPU vertex positions in place (e.g. CPU vertex animation).
 *  `positions` must hold tightly-packed XYZ floats.
 *  `vertexOffset` is the first destination vertex to overwrite (defaults to 0). `vertexCount` and
 *  `sourceVertexOffset` select a range from a retained full-size source array without allocating a view.
 *  The mesh must have been created via createMeshFromData / a mesh factory.
 *  Zero-allocation GPU upload only — CPU-side picking geometry is not refreshed. */
export function updateMeshPositions(engine: EngineContext, mesh: Mesh, positions: Float32Array, vertexOffset = 0, vertexCount?: number, sourceVertexOffset = 0): void {
    writeVertexAttributeRange(engine, mesh, mesh._gpu.positionBuffer, positions, 3, vertexOffset, vertexCount, sourceVertexOffset);
}

function writeVertexAttributeRange(
    engine: EngineContext,
    mesh: Mesh,
    buffer: GPUBuffer,
    values: Float32Array,
    components: number,
    vertexOffset: number,
    vertexCount: number | undefined,
    sourceVertexOffset: number
): void {
    if ((mesh._gpu._refCount ?? 1) > 1) {
        throw new Error(`mesh attribute updates require unshared geometry: ${mesh.name}`);
    }
    const sourceVertexCount = values.length / components;
    const count = vertexCount ?? sourceVertexCount - sourceVertexOffset;
    if (
        !Number.isInteger(sourceVertexCount) ||
        !Number.isInteger(vertexOffset) ||
        vertexOffset < 0 ||
        !Number.isInteger(sourceVertexOffset) ||
        sourceVertexOffset < 0 ||
        !Number.isInteger(count) ||
        count < 0 ||
        sourceVertexOffset + count > sourceVertexCount
    ) {
        throw new Error("mesh attribute update requires a valid tightly-packed vertex range");
    }
    if (count === 0) {
        return;
    }
    const bytesPerVertex = components * 4;
    const destinationByteOffset = vertexOffset * bytesPerVertex;
    const byteLength = count * bytesPerVertex;
    if (destinationByteOffset + byteLength > buffer.size) {
        throw new Error("mesh attribute update requires a valid destination vertex range");
    }
    engine._device.queue.writeBuffer(buffer, destinationByteOffset, values.buffer as ArrayBuffer, values.byteOffset + sourceVertexOffset * bytesPerVertex, byteLength);
    _markWorldMatrixDirty(mesh);
}

/** Replace every attribute + index value of a tightly-packed procedural mesh without replacing its GPU
 *  buffers. Counts and optional-attribute presence must match the existing geometry; use
 *  `resizeMeshGeometry` when topology/layout changes. Stable buffer identities keep cached render/shadow
 *  bundles valid, while retained CPU geometry + bounds keep detailed picking and recovery exact. */
export function updateMeshGeometry(
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
    const gpu = mesh._gpu;
    const vertexCount = positions.length / 3;
    const hasUvs = !!uvs && uvs.length > 0;
    const hasUv2s = !!uvs2 && uvs2.length > 0;
    const hasTangents = !!tangents && tangents.length > 0;
    const hasColors = !!colors && colors.length > 0;
    if (gpu._vbLayout || (gpu._refCount ?? 1) > 1) {
        throw new Error("updateMeshGeometry requires unshared, tightly-packed mesh geometry");
    }
    if (
        !Number.isInteger(vertexCount) ||
        mesh._cpuPositions?.length !== positions.length ||
        normals.length !== positions.length ||
        mesh._cpuIndices?.length !== indices.length ||
        indices.length > gpu.indexCount ||
        gpu.indexFormat !== "uint32"
    ) {
        throw new Error("updateMeshGeometry requires unchanged vertex/index counts; use resizeMeshGeometry for topology changes");
    }
    if (
        hasUvs !== !!gpu.hasUv ||
        (hasUvs && uvs!.length !== vertexCount * 2) ||
        hasUv2s !== !!gpu.hasUv2 ||
        (hasUv2s && uvs2!.length !== vertexCount * 2) ||
        hasTangents !== !!gpu.hasTangent ||
        (hasTangents && tangents!.length !== vertexCount * 4) ||
        hasColors !== !!gpu.hasColor ||
        (hasColors && colors!.length !== vertexCount * 4)
    ) {
        throw new Error("updateMeshGeometry requires unchanged optional-attribute layout; use resizeMeshGeometry for layout changes");
    }

    const queue = engine._device.queue;
    queue.writeBuffer(gpu.positionBuffer, 0, positions.buffer as ArrayBuffer, positions.byteOffset, positions.byteLength);
    queue.writeBuffer(gpu.normalBuffer, 0, normals.buffer as ArrayBuffer, normals.byteOffset, normals.byteLength);
    queue.writeBuffer(gpu.indexBuffer, 0, indices.buffer as ArrayBuffer, indices.byteOffset, indices.byteLength);
    if (hasUvs) {
        queue.writeBuffer(gpu.uvBuffer, 0, uvs!.buffer as ArrayBuffer, uvs!.byteOffset, uvs!.byteLength);
    }
    if (hasUv2s) {
        queue.writeBuffer(gpu.uv2Buffer!, 0, uvs2!.buffer as ArrayBuffer, uvs2!.byteOffset, uvs2!.byteLength);
    }
    if (hasTangents) {
        queue.writeBuffer(gpu.tangentBuffer!, 0, tangents!.buffer as ArrayBuffer, tangents!.byteOffset, tangents!.byteLength);
    }
    if (hasColors) {
        queue.writeBuffer(gpu.colorBuffer!, 0, colors!.buffer as ArrayBuffer, colors!.byteOffset, colors!.byteLength);
    }

    retainMeshGeometry(engine, mesh, positions, normals, indices, uvs, uvs2, tangents, colors);
    _markWorldMatrixDirty(mesh);
}

/** Update changing triangle-list geometry while retaining grow-only GPU buffer capacity. An internal indexed-
 *  indirect argument keeps the live draw count exact while cached render bundles stay stable. */
export function updateMeshGeometryCapacity(
    engine: EngineContext,
    mesh: Mesh,
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    uvs?: Float32Array,
    uvs2?: Float32Array,
    tangents?: Float32Array,
    colors?: Float32Array,
    reserveFactor = 1.25
): MeshGeometryCapacityResult {
    if (!Number.isFinite(reserveFactor) || reserveFactor < 1) {
        throw new Error("updateMeshGeometryCapacity requires reserveFactor >= 1");
    }
    const vertexCount = validateCapacityGeometry(mesh, positions, normals, indices, uvs, uvs2, tangents, colors);
    const oldGpu = mesh._gpu;
    const vertexCapacity = oldGpu._vertexCapacity ?? (mesh._cpuPositions ? mesh._cpuPositions.length / 3 : vertexCount);
    const indexCapacity = oldGpu._indexCapacity ?? oldGpu.indexCount;

    if (vertexCount > vertexCapacity || indices.length > indexCapacity) {
        const nextVertexCapacity = vertexCount > vertexCapacity ? Math.ceil(vertexCount * reserveFactor) : vertexCapacity;
        const requestedIndexCapacity = indices.length > indexCapacity ? Math.ceil(indices.length * reserveFactor) : indexCapacity;
        const nextIndexCapacity = Math.ceil(requestedIndexCapacity / 3) * 3;
        const paddedPositions = new Float32Array(nextVertexCapacity * 3);
        const paddedNormals = new Float32Array(nextVertexCapacity * 3);
        const paddedIndices = new Uint32Array(nextIndexCapacity);
        paddedPositions.set(positions);
        paddedNormals.set(normals);
        paddedIndices.set(indices);
        const paddedUvs = uvs?.length ? new Float32Array(nextVertexCapacity * 2) : undefined;
        const paddedUv2s = uvs2?.length ? new Float32Array(nextVertexCapacity * 2) : undefined;
        const paddedTangents = tangents?.length ? new Float32Array(nextVertexCapacity * 4) : undefined;
        const paddedColors = colors?.length ? new Float32Array(nextVertexCapacity * 4) : undefined;
        paddedUvs?.set(uvs!);
        paddedUv2s?.set(uvs2!);
        paddedTangents?.set(tangents!);
        paddedColors?.set(colors!);
        resizeMeshGeometry(engine, mesh, paddedPositions, paddedNormals, paddedIndices, paddedUvs, paddedUv2s, paddedTangents, paddedColors);
        mesh._gpu._vertexCapacity = nextVertexCapacity;
        mesh._gpu._indexCapacity = nextIndexCapacity;
        mesh._gpu._indexScratch = paddedIndices;
        retainMeshGeometry(engine, mesh, positions, normals, indices, uvs, uvs2, tangents, colors);
        return { stable: false, vertexCapacity: nextVertexCapacity, indexCapacity: nextIndexCapacity };
    }

    oldGpu._vertexCapacity = vertexCapacity;
    oldGpu._indexCapacity = indexCapacity;
    const paddedIndices = oldGpu._indexScratch?.length === indexCapacity ? oldGpu._indexScratch : (oldGpu._indexScratch = new Uint32Array(indexCapacity));
    paddedIndices.fill(0);
    paddedIndices.set(indices);
    const queue = engine._device.queue;
    queue.writeBuffer(oldGpu.positionBuffer, 0, positions.buffer as ArrayBuffer, positions.byteOffset, positions.byteLength);
    queue.writeBuffer(oldGpu.normalBuffer, 0, normals.buffer as ArrayBuffer, normals.byteOffset, normals.byteLength);
    queue.writeBuffer(oldGpu.indexBuffer, 0, paddedIndices.buffer as ArrayBuffer, paddedIndices.byteOffset, paddedIndices.byteLength);
    if (uvs?.length) {
        queue.writeBuffer(oldGpu.uvBuffer, 0, uvs.buffer as ArrayBuffer, uvs.byteOffset, uvs.byteLength);
    }
    if (uvs2?.length) {
        queue.writeBuffer(oldGpu.uv2Buffer!, 0, uvs2.buffer as ArrayBuffer, uvs2.byteOffset, uvs2.byteLength);
    }
    if (tangents?.length) {
        queue.writeBuffer(oldGpu.tangentBuffer!, 0, tangents.buffer as ArrayBuffer, tangents.byteOffset, tangents.byteLength);
    }
    if (colors?.length) {
        queue.writeBuffer(oldGpu.colorBuffer!, 0, colors.buffer as ArrayBuffer, colors.byteOffset, colors.byteLength);
    }
    retainMeshGeometry(engine, mesh, positions, normals, indices, uvs, uvs2, tangents, colors);
    _markWorldMatrixDirty(mesh);
    return { stable: true, vertexCapacity, indexCapacity };
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
    invalidateRenderBundles(engine);
    // Allocate the NEW buffers and swap them in FIRST, so any subsequent frame records from the new
    // geometry. The OLD buffers may still be referenced by the next frame command buffer, especially when
    // resize happens during async scene construction before the first submit. Retire them through the engine's
    // frame-gated queue so destruction cannot run before that command buffer has submitted and drained.
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
    _markWorldMatrixDirty(mesh);
    // `cloneTransformNode` shares the exact MeshGPU object between siblings. Replacing this mesh's
    // `_gpu` drops one ownership claim; only retire the old buffers when no sibling still references
    // them. Otherwise a later frame would legitimately bind the clone's still-live geometry after it
    // had been destroyed.
    if (release(old)) {
        retireGpuResources(engine, () => {
            old.positionBuffer.destroy();
            old.normalBuffer.destroy();
            old.indexBuffer.destroy();
            old.uvBuffer.destroy();
            old.uv2Buffer?.destroy();
            old.tangentBuffer?.destroy();
            old.colorBuffer?.destroy();
        });
    }
}

/** Re-upload (part of) a mesh's NORMAL buffer — the twin of `updateMeshPositions` for dynamically
 *  re-generated geometry whose per-vertex normals change (e.g. a swept tube re-fitted each rebuild).
 *  No-op if the mesh was created without normals. Zero-allocation GPU upload only. */
export function updateMeshNormals(engine: EngineContext, mesh: Mesh, normals: Float32Array, vertexOffset = 0, vertexCount?: number, sourceVertexOffset = 0): void {
    const gpu = mesh._gpu;
    if (!gpu.normalBuffer) {
        return;
    }
    writeVertexAttributeRange(engine, mesh, gpu.normalBuffer, normals, 3, vertexOffset, vertexCount, sourceVertexOffset);
}

/** Re-upload (part of) a mesh's COLOR buffer — the twin of `updateMeshNormals`/`updateMeshPositions`
 *  for dynamically re-generated geometry whose per-vertex colors change (e.g. a procedural mesh whose
 *  parts are re-tinted each rebuild). The color attribute is vec4 (16 bytes/vertex). No-op if the mesh
 *  was created without colors. Zero-allocation GPU upload only. */
export function updateMeshColors(engine: EngineContext, mesh: Mesh, colors: Float32Array, vertexOffset = 0, vertexCount?: number, sourceVertexOffset = 0): void {
    const gpu = mesh._gpu;
    if (!gpu.colorBuffer) {
        return;
    }
    writeVertexAttributeRange(engine, mesh, gpu.colorBuffer, colors, 4, vertexOffset, vertexCount, sourceVertexOffset);
}

/** Re-upload (part of) a mesh's UV buffer — the twin of `updateMeshNormals`/`updateMeshColors` for
 *  dynamically re-generated geometry whose per-vertex UVs change (e.g. a procedural mesh whose parts
 *  carry per-rebuild UV payloads). The uv attribute is vec2 (8 bytes/vertex). No-op if the mesh was
 *  created without UVs. Zero-allocation GPU upload only. */
export function updateMeshUvs(engine: EngineContext, mesh: Mesh, uvs: Float32Array, vertexOffset = 0, vertexCount?: number, sourceVertexOffset = 0): void {
    const gpu = mesh._gpu;
    if (!gpu.uvBuffer) {
        return;
    }
    writeVertexAttributeRange(engine, mesh, gpu.uvBuffer, uvs, 2, vertexOffset, vertexCount, sourceVertexOffset);
}

/** Re-upload (part of) a mesh's second UV buffer (uv2) — the twin of `updateMeshUvs` for dynamically
 *  re-generated geometry whose per-vertex uv2 payload changes each rebuild (e.g. a procedural batch that
 *  re-bakes per-vertex AO / gradient data). The uv2 attribute is vec2 (8 bytes/vertex). No-op if the mesh
 *  was created without uv2. Zero-allocation GPU upload only. */
export function updateMeshUv2(engine: EngineContext, mesh: Mesh, uvs2: Float32Array, vertexOffset = 0, vertexCount?: number, sourceVertexOffset = 0): void {
    const gpu = mesh._gpu;
    if (!gpu.uv2Buffer) {
        return;
    }
    writeVertexAttributeRange(engine, mesh, gpu.uv2Buffer, uvs2, 2, vertexOffset, vertexCount, sourceVertexOffset);
}

/** Re-upload (part of) a mesh's TANGENT buffer — the twin of `updateMeshColors` for dynamically
 *  re-generated geometry whose per-vertex tangent (vec4) payload changes each rebuild (e.g. a procedural
 *  batch that streams a per-vertex coordinate frame / mask through the tangent slot). The tangent attribute
 *  is vec4 (16 bytes/vertex). No-op if the mesh was created without tangents. Zero-allocation GPU upload only. */
export function updateMeshTangents(engine: EngineContext, mesh: Mesh, tangents: Float32Array, vertexOffset = 0, vertexCount?: number, sourceVertexOffset = 0): void {
    const gpu = mesh._gpu;
    if (!gpu.tangentBuffer) {
        return;
    }
    writeVertexAttributeRange(engine, mesh, gpu.tangentBuffer, tangents, 4, vertexOffset, vertexCount, sourceVertexOffset);
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

/** Create a capsule (cylinder capped by two hemispheres) mesh. Caller must assign material. */
export function createCapsule(engine: EngineContext, options?: CapsuleOptions): Mesh {
    const data = createCapsuleData(options);
    return createMeshFromData(engine as EngineContext, "capsule", data.positions, data.normals, data.indices, data.uvs);
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
