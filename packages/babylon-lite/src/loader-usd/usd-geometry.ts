import type { EngineContext } from "../engine/engine.js";
import type { MeshGPU } from "../mesh/mesh.js";
import { BU } from "../engine/gpu-flags.js";
import { createMappedBuffer } from "../resource/gpu-buffers.js";
import type { UsdRecord } from "./usd-protocol.js";
import { usdFloats, usdUints, usdField } from "./usd-protocol.js";

/** @internal CPU geometry. Subsets retain the original vertex IDs for skin remapping. */
export interface UsdGeometry {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    uvs?: Float32Array;
    tangents?: Float32Array;
    colors?: Float32Array;
    vertexMap?: Uint32Array;
    record?: UsdRecord;
}

/** @internal Decode a polygon mesh. The missing-normal implementation is loaded only on demand. */
export async function readUsdGeometry(record: UsdRecord, data: ArrayBuffer): Promise<UsdGeometry> {
    const vertices = usdField(record, 1);
    const indices = usdUints(data, usdField(record, 13), usdField(record, 2));
    if (!vertices || !indices.length || indices.length % 3 || indices.some((index) => index >= vertices)) {
        throw new Error("Invalid USD triangle indices");
    }
    const flags = usdField(record, 3);
    const positions = usdFloats(data, usdField(record, 4), vertices * 3);
    if (!positions.every(Number.isFinite)) {
        throw new Error("Non-finite USD positions");
    }
    const normals =
        flags & 1 ? usdFloats(data, usdField(record, 5), vertices * 3) : (await import("../loader-gltf/gltf-normals.js")).computeSmoothNormals(positions, indices, vertices);
    const tangents = flags & 2 ? usdFloats(data, usdField(record, 6), vertices * 4) : undefined;
    const uvs = flags & 4 ? usdFloats(data, usdField(record, 7), vertices * 2) : undefined;
    const colors = flags & 8 ? usdFloats(data, usdField(record, 8), vertices * 4) : undefined;
    if (![normals, tangents, uvs, colors].every((stream) => !stream || stream.every(Number.isFinite))) {
        throw new Error("Non-finite USD vertex data");
    }
    return {
        positions,
        normals,
        indices,
        record,
        tangents,
        uvs,
        colors,
    };
}

/** @internal Compact a material subset once; all its instance placements reuse the result. */
export function usdSubset(source: UsdGeometry, start: number, count: number): UsdGeometry {
    if (start % 3 || count % 3 || !count || start + count > source.indices.length) {
        throw new Error("Invalid USD material subset index range");
    }
    if (start === 0 && count === source.indices.length) {
        return source;
    }
    const remap = new Map<number, number>();
    const vertices: number[] = [];
    const indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
        const original = source.indices[start + i]!;
        let mapped = remap.get(original);
        if (mapped === undefined) {
            mapped = vertices.length;
            remap.set(original, mapped);
            vertices.push(original);
        }
        indices[i] = mapped;
    }
    const copy = (stream: Float32Array, width: number): Float32Array => {
        const result = new Float32Array(vertices.length * width);
        for (let i = 0; i < vertices.length; i++) {
            for (let c = 0; c < width; c++) {
                result[i * width + c] = stream[vertices[i]! * width + c]!;
            }
        }
        return result;
    };
    return {
        positions: copy(source.positions, 3),
        normals: copy(source.normals, 3),
        indices,
        uvs: source.uvs ? copy(source.uvs, 2) : undefined,
        tangents: source.tangents ? copy(source.tangents, 4) : undefined,
        colors: source.colors ? copy(source.colors, 4) : undefined,
        vertexMap: Uint32Array.from(vertices),
        record: source.record,
    };
}

/** @internal Lite's RH-import convention keeps RH indices beneath a handedness-conversion root. */
export function usdReverseIndices(indices: Uint32Array): Uint32Array {
    const result = indices.slice();
    for (let i = 0; i < result.length; i += 3) {
        const first = result[i]!;
        result[i] = result[i + 2]!;
        result[i + 2] = first;
    }
    return result;
}

/** @internal Upload one shared geometry, releasing allocations if an upload fails. */
export function uploadUsdGeometry(engine: EngineContext, geometry: UsdGeometry): MeshGPU {
    const buffers: GPUBuffer[] = [];
    const upload = (values: ArrayBufferView, usage = BU.VERTEX): GPUBuffer => {
        const buffer = createMappedBuffer(engine, values, usage);
        buffers.push(buffer);
        return buffer;
    };
    try {
        return {
            positionBuffer: upload(geometry.positions),
            normalBuffer: upload(geometry.normals),
            uvBuffer: upload(geometry.uvs ?? new Float32Array((geometry.positions.length / 3) * 2)),
            tangentBuffer: geometry.tangents ? upload(geometry.tangents) : null,
            colorBuffer: geometry.colors ? upload(geometry.colors) : null,
            indexBuffer: upload(geometry.indices, BU.INDEX),
            indexCount: geometry.indices.length,
            indexFormat: "uint32",
            hasUv: !!geometry.uvs,
            hasTangent: !!geometry.tangents,
            hasColor: !!geometry.colors,
        };
    } catch (error) {
        buffers.forEach((buffer) => buffer.destroy());
        throw error;
    }
}
