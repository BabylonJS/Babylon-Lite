/**
 * glTF 2.0 sparse accessor resolution (core spec feature).
 *
 * A sparse accessor stores a *base* set of values — either the referenced
 * `bufferView`, or an all-zero array when `bufferView` is absent — plus a compact
 * list of `(index, value)` overrides. Per spec, resolution starts from the base
 * and then OVERWRITES `sparse.count` elements: the element at position
 * `sparse.indices[i]` is replaced by `sparse.values[i]`. The `indices` view has
 * its own bufferView + unsigned componentType (UBYTE/USHORT/UINT); the `values`
 * view has its own bufferView and shares the accessor's componentType.
 *
 * The core accessor reader (`resolveAccessor`) has no notion of sparse — it only
 * dereferences a bufferView (or zero-fills when absent). Rather than teaching
 * every accessor consumer (geometry, animation, morph, skeleton, instancing)
 * about sparse, this `preParse` hook materializes each sparse accessor into a
 * freshly-appended, tightly-packed bufferView of the same componentType and
 * clears `.sparse`. Downstream, the accessor looks like any other plain
 * bufferView-backed accessor, so no other loader code changes.
 *
 * Dynamic-imported only when an accessor actually carries a `.sparse` property,
 * so non-sparse assets pay zero bytes and zero runtime cost.
 */

import { U8, DV } from "../engine/typed-arrays.js";
import type { GltfFeature } from "./gltf-feature.js";
import { TYPE_SIZES } from "./gltf-parser.js";

const BYTE = 5120;
const UNSIGNED_BYTE = 5121;
const SHORT = 5122;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const FLOAT = 5126;

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

interface SparseTarget {
    bufferView: number;
    byteOffset?: number;
    componentType?: number;
}
interface Sparse {
    count: number;
    indices: SparseTarget;
    values: SparseTarget;
}
interface Accessor {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    sparse?: Sparse;
}
interface BufferView {
    buffer?: number;
    byteOffset?: number;
    byteLength?: number;
    byteStride?: number;
}

function align4(n: number): number {
    return (n + 3) & ~3;
}

/** Byte size of a component type, with an explicit error for malformed/unsupported types. */
function componentBytes(componentType: number): number {
    const b = COMPONENT_BYTES[componentType];
    if (!b) {
        throw new Error(`glTF sparse: unsupported componentType ${componentType}`);
    }
    return b;
}

/** Read one unsigned integer sparse index. */
function readIndex(view: DataView, offset: number, componentType: number): number {
    switch (componentType) {
        case UNSIGNED_BYTE:
            return view.getUint8(offset);
        case UNSIGNED_SHORT:
            return view.getUint16(offset, true);
        case UNSIGNED_INT:
            return view.getUint32(offset, true);
        default:
            throw new Error(`glTF sparse: unsupported index componentType ${componentType}`);
    }
}

/** Read one raw component value (no normalization — a sparse substitution is byte-exact;
 *  normalized accessors are denormalized later, downstream, by their consumer). */
function readComponent(view: DataView, offset: number, componentType: number): number {
    switch (componentType) {
        case BYTE:
            return view.getInt8(offset);
        case UNSIGNED_BYTE:
            return view.getUint8(offset);
        case SHORT:
            return view.getInt16(offset, true);
        case UNSIGNED_SHORT:
            return view.getUint16(offset, true);
        case UNSIGNED_INT:
            return view.getUint32(offset, true);
        case FLOAT:
            return view.getFloat32(offset, true);
        default:
            throw new Error(`glTF sparse: unsupported value componentType ${componentType}`);
    }
}

/** Write one raw component value in the accessor's component type. */
function writeComponent(view: DataView, offset: number, componentType: number, value: number): void {
    switch (componentType) {
        case BYTE:
            view.setInt8(offset, value);
            break;
        case UNSIGNED_BYTE:
            view.setUint8(offset, value);
            break;
        case SHORT:
            view.setInt16(offset, value, true);
            break;
        case UNSIGNED_SHORT:
            view.setUint16(offset, value, true);
            break;
        case UNSIGNED_INT:
            view.setUint32(offset, value, true);
            break;
        case FLOAT:
            view.setFloat32(offset, value, true);
            break;
    }
}

const feature: GltfFeature = {
    id: "_sparse",
    async preParse(json, binChunk) {
        const accessors: Accessor[] = json.accessors ?? [];
        const bufferViews: BufferView[] = json.bufferViews ?? [];

        // Collect sparse accessors and size the tightly-packed region to append.
        const sparseIdx: number[] = [];
        let appended = 0;
        for (let i = 0; i < accessors.length; i++) {
            const a = accessors[i]!;
            if (a.sparse) {
                sparseIdx.push(i);
                const cc = TYPE_SIZES[a.type] ?? 1;
                appended = align4(appended + a.count * cc * componentBytes(a.componentType));
            }
        }
        if (sparseIdx.length === 0) {
            return;
        }

        // New buffer: existing bytes (at offset 0) + tightly-packed materialized accessors.
        const baseLen = align4(binChunk.byteLength);
        const out = new ArrayBuffer(baseLen + appended);
        new U8(out).set(new U8(binChunk.buffer, binChunk.byteOffset, binChunk.byteLength));
        const outView = new DV(out);

        let cursor = baseLen;
        for (const i of sparseIdx) {
            const a = accessors[i]!;
            const sparse = a.sparse!;
            const cc = TYPE_SIZES[a.type] ?? 1;
            const compBytes = componentBytes(a.componentType);
            const elemBytes = cc * compBytes;
            const dstOffset = cursor;

            // 1) Base: copy the referenced bufferView (honoring byteStride) or leave zeros.
            //    bufferView/accessor byteOffsets are relative to the DataView's own byteOffset
            //    (DataView getters add it back), matching resolveAccessor / gltf-ext-quantization.
            if (a.bufferView !== undefined) {
                const bv = bufferViews[a.bufferView]!;
                const stride = bv.byteStride ?? elemBytes;
                const srcBase = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
                for (let v = 0; v < a.count; v++) {
                    for (let c = 0; c < cc; c++) {
                        const value = readComponent(binChunk, srcBase + v * stride + c * compBytes, a.componentType);
                        writeComponent(outView, dstOffset + (v * cc + c) * compBytes, a.componentType, value);
                    }
                }
            }

            // 2) Sparse override: replace element at indices[e] with values[e].
            const idxComponentType = sparse.indices.componentType;
            if (idxComponentType === undefined) {
                throw new Error("glTF sparse: indices.componentType is required");
            }
            const idxBv = bufferViews[sparse.indices.bufferView]!;
            const idxBase = (idxBv.byteOffset ?? 0) + (sparse.indices.byteOffset ?? 0);
            const idxBytes = componentBytes(idxComponentType);
            const valBv = bufferViews[sparse.values.bufferView]!;
            const valBase = (valBv.byteOffset ?? 0) + (sparse.values.byteOffset ?? 0);
            for (let e = 0; e < sparse.count; e++) {
                const target = readIndex(binChunk, idxBase + e * idxBytes, idxComponentType);
                if (target < 0 || target >= a.count) {
                    throw new Error(`glTF sparse: index ${target} out of range for accessor of count ${a.count}`);
                }
                for (let c = 0; c < cc; c++) {
                    const value = readComponent(binChunk, valBase + (e * cc + c) * compBytes, a.componentType);
                    writeComponent(outView, dstOffset + (target * cc + c) * compBytes, a.componentType, value);
                }
            }

            // Rebind the accessor onto the materialized region; the substitution is now baked in.
            const byteLength = elemBytes * a.count;
            a.bufferView = bufferViews.length;
            a.byteOffset = 0;
            bufferViews.push({ buffer: 0, byteOffset: dstOffset, byteLength });
            delete a.sparse;
            cursor = align4(cursor + byteLength);
        }

        return outView;
    },
};

export default feature;
