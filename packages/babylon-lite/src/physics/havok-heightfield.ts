/**
 * Havok Physics V2 heightfield collision shape for Babylon Lite.
 *
 * Kept in a standalone module so the heightfield path adds bytes only to scenes
 * that actually import {@link createHeightFieldShape}. `createPhysicsShape` in
 * `havok.ts` intentionally does NOT reference this code, so primitive/mesh
 * physics scenes pay zero for it.
 *
 * ```ts
 *   const ground = await createGroundFromHeightMap(engine, url, opts);
 *   addToScene(scene, ground);
 *   const shape = createHeightFieldShape(world, { groundMesh: ground });
 *   const body = createPhysicsBody(world, ground, PhysicsMotionType.STATIC);
 *   setPhysicsBodyShape(world, body, shape);
 * ```
 */

import type { Mat4 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { PhysicsShapeType } from "./havok.js";
import type { PhysicsShape, PhysicsWorld } from "./havok.js";

/** Options for {@link createHeightFieldShape}. */
export interface HeightFieldShapeOptions {
    /**
     * Ground mesh whose world-space vertex grid defines the heightfield. When set, the
     * sample count, world size, and height data are derived from the mesh (the explicit
     * fields below are ignored). The mesh must be a regular `(N+1)×(N+1)` grid such as the
     * one produced by `createGroundFromHeightMap`.
     */
    groundMesh?: Mesh;
    /** Explicit: number of height samples along X. */
    numHeightFieldSamplesX?: number;
    /** Explicit: number of height samples along Z. */
    numHeightFieldSamplesZ?: number;
    /** Explicit: world-space size along X. */
    heightFieldSizeX?: number;
    /** Explicit: world-space size along Z. */
    heightFieldSizeZ?: number;
    /** Explicit: row-major height samples (`numHeightFieldSamplesX * numHeightFieldSamplesZ`). */
    heightFieldData?: Float32Array;
}

interface ResolvedHeightField {
    numX: number;
    numZ: number;
    sizeX: number;
    sizeZ: number;
    data: Float32Array;
}

/**
 * Create a Havok heightfield collision shape. Attach it to a STATIC body bound to the
 * ground mesh so the heightfield aligns with the visible terrain.
 * @param world - The physics world.
 * @param options - Ground mesh source or explicit heightfield parameters.
 * @returns The created shape handle.
 */
export function createHeightFieldShape(world: PhysicsWorld, options: HeightFieldShapeOptions): PhysicsShape {
    const { _hknp: hknp } = world;
    const resolved = options.groundMesh ? optionsFromGroundMesh(options.groundMesh) : resolveExplicit(options);

    const { numX, numZ, sizeX, sizeZ, data } = resolved;
    const totalNumHeights = numX * numZ;
    const bufferBegin = hknp._malloc(totalNumHeights * 4);
    const heightBuffer = new Float32Array(hknp.HEAPU8.buffer, bufferBegin, totalNumHeights);
    for (let x = 0; x < numX; x++) {
        for (let z = 0; z < numZ; z++) {
            const hkIndex = z * numX + x;
            const bjsIndex = (numX - 1 - x) * numZ + z;
            heightBuffer[hkIndex] = data[bjsIndex]!;
        }
    }
    const scaleX = sizeX / (numX - 1);
    const scaleZ = sizeZ / (numZ - 1);
    const hkShape = hknp.HP_Shape_CreateHeightField(numX, numZ, [scaleX, 1, scaleZ], bufferBegin)[1];
    hknp._free(bufferBegin);

    return { _hkShape: hkShape, _type: PhysicsShapeType.HEIGHTFIELD };
}

function resolveExplicit(options: HeightFieldShapeOptions): ResolvedHeightField {
    if (
        options.numHeightFieldSamplesX === undefined ||
        options.numHeightFieldSamplesZ === undefined ||
        options.heightFieldSizeX === undefined ||
        options.heightFieldSizeZ === undefined ||
        options.heightFieldData === undefined
    ) {
        throw new Error("createHeightFieldShape requires either a groundMesh or full explicit heightfield parameters.");
    }
    return {
        numX: options.numHeightFieldSamplesX,
        numZ: options.numHeightFieldSamplesZ,
        sizeX: options.heightFieldSizeX,
        sizeZ: options.heightFieldSizeZ,
        data: options.heightFieldData,
    };
}

/**
 * Build heightfield data from a ground mesh's world-space vertex grid, mirroring Babylon.js'
 * `HavokPlugin._createOptionsFromGroundMesh` so Lite and BJS produce identical heightfields.
 */
function optionsFromGroundMesh(mesh: Mesh): ResolvedHeightField {
    const localPositions = mesh._cpuPositions;
    if (!localPositions || localPositions.length === 0) {
        throw new Error("createHeightFieldShape ground mesh has no vertex positions.");
    }

    const world = mesh.worldMatrix as Mat4;
    const vertexCount = localPositions.length / 3;
    const pos = new Float32Array(localPositions.length);
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < localPositions.length; i += 3) {
        const lx = localPositions[i]!;
        const ly = localPositions[i + 1]!;
        const lz = localPositions[i + 2]!;
        const wx = world[0]! * lx + world[4]! * ly + world[8]! * lz + world[12]!;
        const wy = world[1]! * lx + world[5]! * ly + world[9]! * lz + world[13]!;
        const wz = world[2]! * lx + world[6]! * ly + world[10]! * lz + world[14]!;
        pos[i] = wx;
        pos[i + 1] = wy;
        pos[i + 2] = wz;
        if (wx < minX) {
            minX = wx;
        }
        if (wy < minY) {
            minY = wy;
        }
        if (wz < minZ) {
            minZ = wz;
        }
        if (wx > maxX) {
            maxX = wx;
        }
        if (wy > maxY) {
            maxY = wy;
        }
        if (wz > maxZ) {
            maxZ = wz;
        }
    }

    const sideSamples = Math.sqrt(vertexCount);
    if (!Number.isInteger(sideSamples) || sideSamples < 2) {
        throw new Error(
            `createHeightFieldShape requires a regular (N+1)×(N+1) grid mesh (e.g. from createGroundFromHeightMap); got ${vertexCount} vertices, which is not the square of an integer ≥ 2.`
        );
    }
    const arraySize = sideSamples - 1;
    const extendX = (maxX - minX) / 2;
    const extendZ = (maxZ - minZ) / 2;
    const dim = Math.min(extendX, extendZ);
    if (dim <= 0) {
        throw new Error("createHeightFieldShape ground mesh has zero extent in X or Z; cannot build a heightfield.");
    }
    const elementSize = (dim * 2) / arraySize;

    const samples = arraySize + 1;
    const matrix = new Float32Array(samples * samples);
    matrix.fill(minY);
    for (let i = 0; i < pos.length; i += 3) {
        const x = Math.round((pos[i]! - minX) / elementSize);
        const z = arraySize - Math.round((pos[i + 2]! - minZ) / elementSize);
        const y = pos[i + 1]! - minY;
        matrix[z * samples + x] = y;
    }

    return {
        numX: samples,
        numZ: samples,
        sizeX: extendX * 2,
        sizeZ: extendZ * 2,
        data: matrix,
    };
}
