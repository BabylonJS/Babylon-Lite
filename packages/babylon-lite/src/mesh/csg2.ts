import { F32, U32 } from "../engine/typed-arrays.js";
import type { Manifold, ManifoldToplevel, Mesh as ManifoldMesh } from "manifold-3d";
import type { EngineContext } from "../engine/engine.js";
import type { Material } from "../material/material.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "./mesh.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { normalizeVec3 } from "../math/normalize-vec3.js";
import { createMeshFromData } from "./mesh-factories.js";

declare const csg2SolidBrand: unique symbol;

const MATERIAL_ID_RESERVE_COUNT = 65536;

/** A manifold-3d backed CSG solid for high-precision boolean mesh operations. */
export interface Csg2Solid {
    readonly [csg2SolidBrand]: true;
    /** @internal */
    _manifold: Manifold | null;
    /** @internal */
    readonly _numProp: number;
}

interface Csg2Runtime {
    readonly Manifold: typeof Manifold;
    readonly Mesh: typeof ManifoldMesh;
    readonly firstMaterialId: number;
}

interface GeometryBuffers {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly indices: Uint32Array;
    readonly uvs: Float32Array | undefined;
}

let csg2Runtime: Csg2Runtime | null = null;
let csg2RuntimePromise: Promise<Csg2Runtime> | null = null;

/** Returns whether the manifold-3d runtime has finished loading and CSG2 is usable. */
export function isCsg2Ready(): boolean {
    return csg2Runtime !== null;
}

/** Loads the manifold-3d WASM runtime. Must be awaited once before any CSG2 operation. */
export async function initializeCsg2Async(): Promise<void> {
    await getRuntimeAsync();
}

async function getRuntimeAsync(): Promise<Csg2Runtime> {
    if (csg2Runtime) {
        return csg2Runtime;
    }
    if (csg2RuntimePromise) {
        return csg2RuntimePromise;
    }

    csg2RuntimePromise = (async () => {
        const [module, wasm] = await Promise.all([import("manifold-3d"), import("manifold-3d/manifold.wasm?url")]);
        const manifoldModule: ManifoldToplevel = await module.default({
            locateFile: () => new URL(wasm.default, import.meta.url).href,
        });
        manifoldModule.setup();
        const runtime = {
            Manifold: manifoldModule.Manifold,
            Mesh: manifoldModule.Mesh,
            firstMaterialId: manifoldModule.Manifold.reserveIDs(MATERIAL_ID_RESERVE_COUNT),
        };
        csg2Runtime = runtime;
        return runtime;
    })();

    return csg2RuntimePromise;
}

function requireRuntime(): Csg2Runtime {
    if (!csg2Runtime) {
        throw new Error("CSG2 is not initialized. Call and await initializeCsg2Async() before using CSG2 operations.");
    }
    return csg2Runtime;
}

function requireSolidManifold(solid: Csg2Solid, operation: string): Manifold {
    const manifold = solid._manifold;
    if (!manifold) {
        throw new Error(`${operation} cannot use a disposed CSG2 solid.`);
    }
    return manifold;
}

function solidFromManifold(manifold: Manifold, numProp: number): Csg2Solid {
    return { _manifold: manifold, _numProp: numProp } as unknown as Csg2Solid;
}

function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
    return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}

function transformNormal(m: Mat4, inv: Mat4 | null, x: number, y: number, z: number): [number, number, number] {
    if (inv) {
        return normalizeVec3(inv[0]! * x + inv[1]! * y + inv[2]! * z, inv[4]! * x + inv[5]! * y + inv[6]! * z, inv[8]! * x + inv[9]! * y + inv[10]! * z, 1e-20);
    }
    return normalizeVec3(m[0]! * x + m[4]! * y + m[8]! * z, m[1]! * x + m[5]! * y + m[9]! * z, m[2]! * x + m[6]! * y + m[10]! * z, 1e-20);
}

function requireCpuGeometry(mesh: Mesh): GeometryBuffers {
    if (!mesh._cpuPositions) {
        throw new Error(`createCsg2FromMesh("${mesh.name}") requires CPU positions. Use a Babylon Lite mesh factory or loader that retains CPU geometry.`);
    }
    if (!mesh._cpuIndices) {
        throw new Error(`createCsg2FromMesh("${mesh.name}") requires CPU indices. Use a Babylon Lite mesh factory or loader that retains CPU geometry.`);
    }
    if (!mesh._cpuNormals) {
        throw new Error(`createCsg2FromMesh("${mesh.name}") requires CPU normals. Use a Babylon Lite mesh factory or loader that retains CPU geometry.`);
    }
    return {
        positions: mesh._cpuPositions,
        normals: mesh._cpuNormals,
        indices: mesh._cpuIndices,
        uvs: mesh._cpuUvs,
    };
}

/**
 * Builds a {@link Csg2Solid} from a mesh's CPU geometry, baking its world transform.
 * @param mesh - Source mesh; must retain CPU positions, normals, and indices.
 * @param materialSlot - Material slot index (0 to 65535) tagged onto the solid's triangles.
 * @returns A CSG2 solid; call {@link disposeCsg2} when finished to free WASM memory.
 */
export function createCsg2FromMesh(mesh: Mesh, materialSlot = 0): Csg2Solid {
    const runtime = requireRuntime();
    if (materialSlot < 0 || materialSlot >= MATERIAL_ID_RESERVE_COUNT || !Number.isInteger(materialSlot)) {
        throw new Error(`createCsg2FromMesh("${mesh.name}") materialSlot must be an integer from 0 to ${MATERIAL_ID_RESERVE_COUNT - 1}.`);
    }

    const geometry = requireCpuGeometry(mesh);
    const vertexCount = geometry.positions.length / 3;
    const numProp = 8;
    const vertProperties = new F32(vertexCount * numProp);
    const world = mesh.worldMatrix;
    const invWorld = mat4Invert(world);

    for (let i = 0; i < vertexCount; i++) {
        const p = i * 3;
        const uv = i * 2;
        const out = i * numProp;
        const [x, y, z] = transformPoint(world, geometry.positions[p]!, geometry.positions[p + 1]!, geometry.positions[p + 2]!);
        const [nx, ny, nz] = transformNormal(world, invWorld, geometry.normals[p]!, geometry.normals[p + 1]!, geometry.normals[p + 2]!);
        vertProperties[out] = x;
        vertProperties[out + 1] = y;
        vertProperties[out + 2] = z;
        vertProperties[out + 3] = nx;
        vertProperties[out + 4] = ny;
        vertProperties[out + 5] = nz;
        vertProperties[out + 6] = geometry.uvs?.[uv] ?? 0;
        vertProperties[out + 7] = geometry.uvs?.[uv + 1] ?? 0;
    }

    const triVerts = new U32(geometry.indices.length);
    for (let i = 0; i < geometry.indices.length; i += 3) {
        triVerts[i] = geometry.indices[i + 2]!;
        triVerts[i + 1] = geometry.indices[i + 1]!;
        triVerts[i + 2] = geometry.indices[i]!;
    }

    const manifoldMesh = new runtime.Mesh({
        numProp,
        vertProperties,
        triVerts,
        runIndex: new U32([0]),
        runOriginalID: new U32([runtime.firstMaterialId + materialSlot]),
    });
    manifoldMesh.merge();

    try {
        // manifold-3d's `setup()` replaces `Manifold` with a factory function,
        // `function (mesh) { const m = new ManifoldCtor(mesh); …; return m; }`, that has no
        // `this` reference. A downstream esbuild/terser minifier (the dist build, or any
        // consumer bundling `build/lib`) rewrites such a function expression into an arrow
        // function, which is NOT constructable — so `new runtime.Manifold(mesh)` throws
        // "Manifold is not a constructor". The wrapper returns the solid whether invoked with
        // or without `new`, so call it as a plain factory to stay robust under minification.
        const manifoldFactory = runtime.Manifold as unknown as (mesh: ManifoldMesh) => Manifold;
        return solidFromManifold(manifoldFactory(manifoldMesh), numProp);
    } catch (err) {
        throw new Error(`Error while creating CSG2 from mesh "${mesh.name}".`, { cause: err });
    }
}

function runBooleanOperation(operation: "difference" | "intersection" | "union", a: Csg2Solid, b: Csg2Solid): Csg2Solid {
    const runtime = requireRuntime();
    if (a._numProp !== b._numProp) {
        throw new Error("CSG2 operations require solids with the same vertex property layout.");
    }
    return solidFromManifold(runtime.Manifold[operation](requireSolidManifold(a, `csg2 ${operation}`), requireSolidManifold(b, `csg2 ${operation}`)), a._numProp);
}

/** Returns the boolean difference (`a` − `b`) of two solids as a new solid. */
export function csg2Subtract(a: Csg2Solid, b: Csg2Solid): Csg2Solid {
    return runBooleanOperation("difference", a, b);
}

/** Returns the boolean intersection (`a` ∩ `b`) of two solids as a new solid. */
export function csg2Intersect(a: Csg2Solid, b: Csg2Solid): Csg2Solid {
    return runBooleanOperation("intersection", a, b);
}

/** Returns the boolean union (`a` ∪ `b`) of two solids as a new solid. */
export function csg2Add(a: Csg2Solid, b: Csg2Solid): Csg2Solid {
    return runBooleanOperation("union", a, b);
}

/** Frees the WASM memory backing a solid. The solid must not be used afterwards. */
export function disposeCsg2(solid: Csg2Solid): void {
    if (solid._manifold) {
        solid._manifold.delete();
        solid._manifold = null;
    }
}

function materialSlotFromOriginalId(runtime: Csg2Runtime, originalId: number, name: string): number {
    const materialSlot = originalId - runtime.firstMaterialId;
    if (materialSlot < 0 || materialSlot >= MATERIAL_ID_RESERVE_COUNT) {
        throw new Error(`createMeshesFromCsg2("${name}") received an unknown Manifold material original ID ${originalId}.`);
    }
    return materialSlot;
}

function appendTriangle(
    output: { positions: number[]; normals: number[]; uvs: number[]; indices: number[] },
    mesh: ManifoldMesh,
    triVerts: Uint32Array,
    numProp: number,
    triIndex: number
): void {
    const base = output.positions.length / 3;
    for (let corner = 2; corner >= 0; corner--) {
        const vertexIndex = triVerts[triIndex + corner]!;
        const prop = vertexIndex * numProp;
        output.positions.push(mesh.vertProperties[prop]!, mesh.vertProperties[prop + 1]!, mesh.vertProperties[prop + 2]!);
        output.normals.push(mesh.vertProperties[prop + 3]!, mesh.vertProperties[prop + 4]!, mesh.vertProperties[prop + 5]!);
        output.uvs.push(mesh.vertProperties[prop + 6]!, mesh.vertProperties[prop + 7]!);
        output.indices.push(base + (2 - corner));
    }
}

function createMeshFromOutput(engine: EngineContext, name: string, output: { positions: number[]; normals: number[]; uvs: number[]; indices: number[] }): Mesh {
    if (output.positions.length === 0) {
        throw new Error(`Unable to build CSG2 mesh "${name}". Manifold has 0 vertices for this output.`);
    }
    return createMeshFromData(engine, name, new F32(output.positions), new F32(output.normals), new U32(output.indices), new F32(output.uvs));
}

/**
 * Triangulates a {@link Csg2Solid} into a single renderable mesh.
 * @param name - Name for the created mesh.
 */
export function createMeshFromCsg2(engine: EngineContext, solid: Csg2Solid, name = "csg2"): Mesh {
    requireRuntime();
    const mesh = requireSolidManifold(solid, `createMeshFromCsg2("${name}")`).getMesh();
    const output = { positions: [] as number[], normals: [] as number[], uvs: [] as number[], indices: [] as number[] };
    for (let i = 0; i < mesh.triVerts.length; i += 3) {
        appendTriangle(output, mesh, mesh.triVerts, solid._numProp, i);
    }
    return createMeshFromOutput(engine, name, output);
}

/**
 * Triangulates a {@link Csg2Solid} into one mesh per material slot.
 * @param materials - Materials indexed by the material slots assigned during construction.
 * @param name - Base name; each sub-mesh is suffixed with its slot index.
 * @returns One mesh per distinct material slot, each assigned its corresponding material.
 */
export function createMeshesFromCsg2(engine: EngineContext, solid: Csg2Solid, materials: readonly Material[], name = "csg2"): Mesh[] {
    const runtime = requireRuntime();
    const mesh = requireSolidManifold(solid, `createMeshesFromCsg2("${name}")`).getMesh();
    const outputs: Array<{ materialSlot: number; positions: number[]; normals: number[]; uvs: number[]; indices: number[] }> = [];

    for (let run = 0; run < mesh.numRun; run++) {
        const originalId = mesh.runOriginalID[run]!;
        const materialSlot = materialSlotFromOriginalId(runtime, originalId, name);
        let output = outputs.find((entry) => entry.materialSlot === materialSlot);
        if (!output) {
            output = { materialSlot, positions: [], normals: [], uvs: [], indices: [] };
            outputs.push(output);
        }

        const start = mesh.runIndex[run] ?? 0;
        const end = mesh.runIndex[run + 1] ?? mesh.triVerts.length;
        for (let i = start; i < end; i += 3) {
            appendTriangle(output, mesh, mesh.triVerts, solid._numProp, i);
        }
    }

    outputs.sort((a, b) => a.materialSlot - b.materialSlot);
    return outputs.map((output) => {
        const material = materials[output.materialSlot];
        if (!material) {
            throw new Error(`createMeshesFromCsg2("${name}") missing material for CSG2 material slot ${output.materialSlot}.`);
        }
        const result = createMeshFromOutput(engine, `${name}_sub${output.materialSlot}`, output);
        result.material = material;
        return result;
    });
}
