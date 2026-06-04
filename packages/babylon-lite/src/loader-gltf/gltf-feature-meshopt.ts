/**
 * EXT_meshopt_compression feature.
 *
 * Runs as a `preParse` hook — before any accessor is read — so the core loader
 * and accessor reader stay unaware of meshopt. This module is only
 * dynamic-imported when the asset's `extensionsUsed` lists
 * EXT_meshopt_compression, which in turn loads the meshoptimizer decoder
 * (`meshopt-decode.ts`) lazily.
 *
 * EXT_meshopt_compression is a bufferView-level codec: each compressed
 * bufferView carries an extension object describing the compressed source
 * (`buffer`/`byteOffset`/`byteLength`), the decoded layout (`count`/`byteStride`)
 * and the codec (`mode`/`filter`). We decode every compressed bufferView, copy
 * through every uncompressed one, and pack the results into a single contiguous
 * binary chunk, rewriting `bufferViews` to point into it. Accessor byteOffsets
 * are bufferView-relative and the per-bufferView layout (count * byteStride) is
 * preserved, so the existing accessor reader resolves the decoded data
 * transparently.
 */

import type { GltfFeature } from "./gltf-feature.js";
import { getMeshoptDecoder } from "./meshopt-decode.js";

interface MeshoptExt {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride: number;
    count: number;
    mode: string;
    filter?: string;
}

interface BufferView {
    buffer?: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
    extensions?: { EXT_meshopt_compression?: MeshoptExt; [k: string]: unknown };
}

/** Round up to the next 4-byte boundary so relocated bufferViews stay aligned
 *  for Float32Array / Uint16Array / Uint32Array views over the packed buffer. */
function align4(n: number): number {
    return (n + 3) & ~3;
}

const feature: GltfFeature = {
    id: "EXT_meshopt_compression",
    async preParse(json, binChunk) {
        const bufferViews: BufferView[] = json.bufferViews ?? [];
        const decoder = await getMeshoptDecoder();

        // Pass 1: materialize each bufferView (decode meshopt ones, copy the rest)
        // and compute the packed-buffer offset for each.
        const materialized: Uint8Array[] = new Array(bufferViews.length);
        const newOffsets: number[] = new Array(bufferViews.length);
        let total = 0;
        for (let i = 0; i < bufferViews.length; i++) {
            const bv = bufferViews[i]!;
            const ext = bv.extensions?.EXT_meshopt_compression;
            let bytes: Uint8Array;
            if (ext) {
                if ((ext.buffer ?? 0) !== 0) {
                    throw new Error(`EXT_meshopt_compression: compressed source buffer ${ext.buffer} is not buffer 0 (unsupported)`);
                }
                const source = new Uint8Array(binChunk.buffer, binChunk.byteOffset + (ext.byteOffset ?? 0), ext.byteLength);
                const target = new Uint8Array(ext.count * ext.byteStride);
                decoder.decodeGltfBuffer(target, ext.count, ext.byteStride, source, ext.mode, ext.filter ?? "NONE");
                bytes = target;
            } else {
                if ((bv.buffer ?? 0) !== 0) {
                    throw new Error(`EXT_meshopt_compression: uncompressed bufferView in buffer ${bv.buffer} is not buffer 0 (unsupported)`);
                }
                bytes = new Uint8Array(binChunk.buffer.slice(binChunk.byteOffset + (bv.byteOffset ?? 0), binChunk.byteOffset + (bv.byteOffset ?? 0) + bv.byteLength));
            }
            materialized[i] = bytes;
            newOffsets[i] = total;
            total = align4(total + bytes.length);
        }

        // Pass 2: pack into a single contiguous buffer and rewrite bufferViews.
        const packed = new Uint8Array(total);
        for (let i = 0; i < bufferViews.length; i++) {
            const bv = bufferViews[i]!;
            packed.set(materialized[i]!, newOffsets[i]!);
            bv.buffer = 0;
            bv.byteOffset = newOffsets[i]!;
            bv.byteLength = materialized[i]!.length;
            if (bv.extensions) {
                delete bv.extensions.EXT_meshopt_compression;
            }
        }

        return new DataView(packed.buffer);
    },
};

export default feature;
