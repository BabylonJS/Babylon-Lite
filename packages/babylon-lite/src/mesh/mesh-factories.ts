/** High-level mesh factory functions.
 *  Each creates geometry, uploads to GPU, and returns a Mesh.
 *  The caller adds to the scene via addToScene(scene, mesh).
 *
 *  Pillar 4b: plain data, no scene reference.
 *  Pillar 4c: materials own shaders — mesh just holds material props. */

import type { EngineContext } from "../engine/engine.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { Mesh } from "./mesh.js";
import type { MeshInternal } from "./mesh.js";
import { initMeshTransform, uploadMeshToGPU } from "./mesh.js";
import { computeAabb } from "../math/compute-aabb.js";
import { createSphereData } from "./create-sphere.js";
import type { SphereOptions } from "./create-sphere.js";
import { createBoxData } from "./create-box.js";
import { createTorusData } from "./create-torus.js";
import type { TorusOptions } from "./create-torus.js";
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
    engine: EngineContextInternal,
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
    } as unknown as MeshInternal;
    initMeshTransform(mesh);

    // Retain CPU geometry for detailed picking (ray-triangle intersection)
    mesh._cpuPositions = positions;
    mesh._cpuNormals = normals;
    mesh._cpuUvs = uvs;
    mesh._cpuIndices = indices;
    (engine as EngineContextInternal)._dlr?.m(mesh, uvs2 ?? null, tangents ?? null, colors ?? null, indices, "uint32");

    return mesh as Mesh;
}

/** Create a sphere mesh. Caller must assign material. */
export function createSphere(engine: EngineContext, options?: SphereOptions): Mesh {
    const data = createSphereData(options);
    return createMeshFromData(engine as EngineContextInternal, "sphere", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a box mesh. Caller must assign material. */
export function createBox(engine: EngineContext, size = 1): Mesh {
    const data = createBoxData(size);
    return createMeshFromData(engine as EngineContextInternal, "box", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a torus mesh. Caller must assign material. */
export function createTorus(engine: EngineContext, options?: TorusOptions): Mesh {
    const data = createTorusData(options);
    return createMeshFromData(engine as EngineContextInternal, "torus", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a ground mesh from a heightmap URL. Caller must assign material. */
export async function createGroundFromHeightMap(engine: EngineContext, url: string, options: GroundOptions): Promise<Mesh> {
    const data = await createGroundCPU(url, options);
    return createMeshFromData(engine as EngineContextInternal, "ground", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a flat ground mesh. Caller must assign material. */
export function createGround(engine: EngineContext, options?: GroundOptions): Mesh {
    const data = createFlatGroundData(options);
    return createMeshFromData(engine as EngineContextInternal, "ground", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a cylinder (or cone / truncated cone / prism) mesh. Caller must assign material. */
export function createCylinder(engine: EngineContext, options?: CylinderOptions): Mesh {
    const data = createCylinderData(options);
    return createMeshFromData(engine as EngineContextInternal, "cylinder", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a plane (unit quad facing -Z). Caller must assign material. */
export function createPlane(engine: EngineContext, options?: PlaneOptions): Mesh {
    const data = createPlaneData(options);
    return createMeshFromData(engine as EngineContextInternal, "plane", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a disc (or ring / pie slice via `arc`). Caller must assign material. */
export function createDisc(engine: EngineContext, options?: DiscOptions): Mesh {
    const data = createDiscData(options);
    return createMeshFromData(engine as EngineContextInternal, "disc", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a polyhedron (15 presets). Caller must assign material. */
export function createPolyhedron(engine: EngineContext, options?: PolyhedronOptions): Mesh {
    const data = createPolyhedronData(options);
    return createMeshFromData(engine as EngineContextInternal, "polyhedron", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a ribbon from an array of parallel Vec3 paths. Caller must assign material. */
export function createRibbon(engine: EngineContext, options: RibbonOptions): Mesh {
    const data = createRibbonData(options);
    return createMeshFromData(engine as EngineContextInternal, "ribbon", data.positions, data.normals, data.indices, data.uvs);
}

/** Create a tube (circular cross-section swept along a path). Caller must assign material. */
export function createTube(engine: EngineContext, options: TubeOptions): Mesh {
    const data = createTubeData(options);
    return createMeshFromData(engine as EngineContextInternal, "tube", data.positions, data.normals, data.indices, data.uvs);
}

/** Create an extruded shape (2D shape swept along a path). Caller must assign material. */
export function createExtrudeShape(engine: EngineContext, options: ExtrudeShapeOptions): Mesh {
    const data = createExtrudeShapeData(options);
    return createMeshFromData(engine as EngineContextInternal, "extrude", data.positions, data.normals, data.indices, data.uvs);
}
