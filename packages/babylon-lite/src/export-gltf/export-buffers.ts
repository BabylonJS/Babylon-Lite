/** Binary payload builder for the glTF exporter: bufferViews, accessors, alignment, min/max. */

import type { GltfAccessor, GltfAccessorType, GltfBufferView, GltfBufferViewTarget, GltfComponentType } from "./export-gltf-types.js";

/** @internal glTF accessor component types. */
export const UNSIGNED_SHORT = 5123;
/** @internal */
export const UNSIGNED_INT = 5125;
/** @internal */
export const FLOAT = 5126;
/** @internal bufferView target for vertex attributes. */
export const ARRAY_BUFFER = 34962;
/** @internal bufferView target for indices. */
export const ELEMENT_ARRAY_BUFFER = 34963;

/** @internal One accessor request. */
export interface AccessorDesc {
    readonly bufferView: number;
    readonly componentType: GltfComponentType;
    readonly count: number;
    readonly type: GltfAccessorType;
    readonly min?: number[];
    readonly max?: number[];
}

/** @internal Collects bufferViews and accessors and lays out the single GLB BIN buffer. */
export interface BufferBuilder {
    /** The glTF `bufferViews` array; `byteOffset`s are written by {@link BufferBuilder.finalize}. */
    readonly bufferViews: GltfBufferView[];
    readonly accessors: GltfAccessor[];
    /** Snapshot `bytes` into a new bufferView and return its index. The bytes are copied on the
     *  call, so later writes to the source never reach the output. A repeated call with the same
     *  view object and target returns the existing index. */
    addBufferView(bytes: ArrayBufferView, target?: GltfBufferViewTarget): number;
    addAccessor(desc: AccessorDesc): number;
    /** Lay out every bufferView and return the BIN payload (length 0 when nothing was added).
     *  Releases the staged copies, so it is called once, after the last bufferView is added. */
    finalize(): Uint8Array<ArrayBuffer>;
}

/** @internal Create an empty {@link BufferBuilder}. */
export function createBufferBuilder(): BufferBuilder {
    const bufferViews: GltfBufferView[] = [];
    const accessors: GltfAccessor[] = [];
    const payloads: Uint8Array[] = [];
    const viewIndex = new WeakMap<ArrayBufferView, Map<GltfBufferViewTarget | undefined, number>>();

    return {
        bufferViews,
        accessors,
        addBufferView(bytes, target) {
            let byTarget = viewIndex.get(bytes);
            const existing = byTarget?.get(target);
            if (existing !== undefined) {
                return existing;
            }
            const copy = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
            const view: GltfBufferView = { buffer: 0, byteLength: copy.byteLength };
            if (target !== undefined) {
                view.target = target;
            }
            const index = bufferViews.push(view) - 1;
            payloads.push(copy);
            if (!byTarget) {
                byTarget = new Map();
                viewIndex.set(bytes, byTarget);
            }
            byTarget.set(target, index);
            return index;
        },
        addAccessor(desc) {
            const accessor: GltfAccessor = { bufferView: desc.bufferView, componentType: desc.componentType, count: desc.count, type: desc.type };
            if (desc.max) {
                accessor.max = desc.max;
            }
            if (desc.min) {
                accessor.min = desc.min;
            }
            return accessors.push(accessor) - 1;
        },
        finalize() {
            // Babylon.js packing rule: order views by descending alignment need (4, 2, 1), stably, and
            // concatenate them with no padding. Every view whose length is a multiple of 4 then starts
            // 4-aligned, and every view whose length is a multiple of 2 starts 2-aligned.
            const order = payloads.map((_, i) => i);
            order.sort((a, b) => alignmentOf(payloads[b]!.byteLength) - alignmentOf(payloads[a]!.byteLength) || a - b);
            let total = 0;
            for (const i of order) {
                total += payloads[i]!.byteLength;
            }
            const out = new Uint8Array(total);
            let offset = 0;
            for (const i of order) {
                const bytes = payloads[i]!;
                out.set(bytes, offset);
                if (offset > 0) {
                    bufferViews[i]!.byteOffset = offset;
                }
                offset += bytes.byteLength;
            }
            payloads.length = 0;
            return out;
        },
    };
}

function alignmentOf(byteLength: number): number {
    return byteLength % 4 === 0 ? 4 : byteLength % 2 === 0 ? 2 : 1;
}

/** @internal Per-component minimum and maximum over `count` elements of `components` values each. */
export function computeMinMax(data: ArrayLike<number>, components: number, count = data.length / components): { min: number[]; max: number[] } {
    const min = new Array<number>(components).fill(Infinity);
    const max = new Array<number>(components).fill(-Infinity);
    for (let e = 0; e < count; e++) {
        const base = e * components;
        for (let c = 0; c < components; c++) {
            const v = data[base + c]!;
            if (v < min[c]!) {
                min[c] = v;
            }
            if (v > max[c]!) {
                max[c] = v;
            }
        }
    }
    if (count === 0) {
        min.fill(0);
        max.fill(0);
    }
    return { min, max };
}
