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
import { createSphereData } from "./create-sphere.js";
import type { SphereOptions } from "./create-sphere.js";
import { createBoxData } from "./create-box.js";
import { createTorusData } from "./create-torus.js";
import type { TorusOptions } from "./create-torus.js";
import { createFlatGroundData, createGroundFromHeightMap as createGroundCPU } from "./create-ground.js";
import type { GroundOptions } from "./create-ground.js";

/** Create a Mesh from raw geometry data + GPU device.
 *  No material is assigned — the caller must set mesh.material before adding to scene. */
function createMeshFromData(engine: EngineContextInternal, name: string, positions: Float32Array, normals: Float32Array, indices: Uint32Array, uvs?: Float32Array): Mesh {
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i]!,
            y = positions[i + 1]!,
            z = positions[i + 2]!;
        if (x < minX) {
            minX = x;
        }
        if (x > maxX) {
            maxX = x;
        }
        if (y < minY) {
            minY = y;
        }
        if (y > maxY) {
            maxY = y;
        }
        if (z < minZ) {
            minZ = z;
        }
        if (z > maxZ) {
            maxZ = z;
        }
    }
    const mesh = {
        name,
        material: null as any,
        receiveShadows: false,
        boundMin: isFinite(minX) ? ([minX, minY, minZ] as [number, number, number]) : undefined,
        boundMax: isFinite(maxX) ? ([maxX, maxY, maxZ] as [number, number, number]) : undefined,
        _materialDirty: false,
        _gpu: uploadMeshToGPU(engine, positions, normals, indices, uvs),
    } as unknown as MeshInternal;
    initMeshTransform(mesh);

    // Retain CPU geometry for detailed picking (ray-triangle intersection)
    mesh._cpuPositions = positions;
    mesh._cpuNormals = normals;
    mesh._cpuUvs = uvs;
    mesh._cpuIndices = indices;

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
