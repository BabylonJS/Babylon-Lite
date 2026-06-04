/**
 * KHR_mesh_quantization (+ post-meshopt) dequantization feature.
 *
 * Runs as a `preParse` hook, after EXT_meshopt_compression. The core accessor
 * reader (`resolveAccessor`) only understands tightly-packed FLOAT / UBYTE /
 * USHORT / UINT data and ignores `byteStride`; quantized assets store vertex
 * attributes (and meshopt-filtered animation outputs) as normalized or signed
 * integers, sometimes padded by a `byteStride`. This feature rewrites every such
 * accessor into a freshly-appended, tightly-packed FLOAT bufferView so the rest
 * of the loader stays completely unaware of quantization. It is dynamic-imported
 * only when `extensionsUsed` lists KHR_mesh_quantization, so non-quantized scenes
 * pay nothing.
 *
 * Conversion rule (role-agnostic, derived from the accessor alone):
 *   - signed component types (BYTE/SHORT) → FLOAT (core would otherwise throw)
 *   - `normalized` accessors → FLOAT (core would otherwise read raw ints)
 *   - strided FLOAT accessors → tightly-packed FLOAT (core ignores byteStride)
 * Unsigned non-normalized integer accessors (JOINTS_0, indices) are left intact:
 * they are already tight and the skeleton / index paths expect integers.
 */

import type { GltfFeature } from "./gltf-feature.js";

const BYTE = 5120;
const UNSIGNED_BYTE = 5121;
const SHORT = 5122;
const UNSIGNED_SHORT = 5123;
const FLOAT = 5126;

const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

interface Accessor {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    normalized?: boolean;
    count: number;
    type: string;
}

interface BufferView {
    buffer?: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
}

function align4(n: number): number {
    return (n + 3) & ~3;
}

/** Read one component as a float, applying glTF normalization when requested. */
function readComponent(view: DataView, offset: number, componentType: number, normalized: boolean): number {
    switch (componentType) {
        case BYTE: {
            const c = view.getInt8(offset);
            return normalized ? Math.max(c / 127, -1) : c;
        }
        case UNSIGNED_BYTE: {
            const c = view.getUint8(offset);
            return normalized ? c / 255 : c;
        }
        case SHORT: {
            const c = view.getInt16(offset, true);
            return normalized ? Math.max(c / 32767, -1) : c;
        }
        case UNSIGNED_SHORT: {
            const c = view.getUint16(offset, true);
            return normalized ? c / 65535 : c;
        }
        case FLOAT:
            return view.getFloat32(offset, true);
        default:
            throw new Error(`KHR_mesh_quantization: unsupported componentType ${componentType}`);
    }
}

const feature: GltfFeature = {
    id: "KHR_mesh_quantization",
    async preParse(json, binChunk) {
        const accessors: Accessor[] = json.accessors ?? [];
        const bufferViews: BufferView[] = json.bufferViews ?? [];

        // Decide which accessors need rewriting and how many float bytes to append.
        const convert: number[] = [];
        let appended = 0;
        for (let i = 0; i < accessors.length; i++) {
            const a = accessors[i]!;
            if (a.bufferView === undefined) {
                continue;
            }
            const componentCount = TYPE_COMPONENTS[a.type] ?? 1;
            const stride = bufferViews[a.bufferView]?.byteStride;
            const signed = a.componentType === BYTE || a.componentType === SHORT;
            const stridedFloat = a.componentType === FLOAT && stride !== undefined && stride !== componentCount * 4;
            if (signed || a.normalized === true || stridedFloat) {
                convert.push(i);
                appended = align4(appended + a.count * componentCount * 4);
            }
        }

        if (convert.length === 0) {
            return;
        }

        // Build a new buffer: existing data (normalized to offset 0) + appended floats.
        const baseLen = align4(binChunk.byteLength);
        const out = new ArrayBuffer(baseLen + appended);
        new Uint8Array(out).set(new Uint8Array(binChunk.buffer, binChunk.byteOffset, binChunk.byteLength));
        const outView = new DataView(out);

        let cursor = baseLen;
        for (const i of convert) {
            const a = accessors[i]!;
            const bv = bufferViews[a.bufferView!]!;
            const componentCount = TYPE_COMPONENTS[a.type] ?? 1;
            const compBytes = COMPONENT_BYTES[a.componentType]!;
            const stride = bv.byteStride ?? componentCount * compBytes;
            // bufferView/accessor byteOffsets are relative to the DataView's own
            // byteOffset (DataView getters add it back), matching resolveAccessor.
            const srcBase = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);

            const dstOffset = cursor;
            for (let v = 0; v < a.count; v++) {
                for (let c = 0; c < componentCount; c++) {
                    const value = readComponent(binChunk, srcBase + v * stride + c * compBytes, a.componentType, !!a.normalized);
                    outView.setFloat32(dstOffset + (v * componentCount + c) * 4, value, true);
                }
            }

            const byteLength = a.count * componentCount * 4;
            const newBvIndex = bufferViews.length;
            bufferViews.push({ buffer: 0, byteOffset: dstOffset, byteLength });
            a.bufferView = newBvIndex;
            a.byteOffset = 0;
            a.componentType = FLOAT;
            a.normalized = false;
            cursor = align4(cursor + byteLength);
        }

        return outView;
    },
};

export default feature;
