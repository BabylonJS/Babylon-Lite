/** MeshLoD page decoder unit tests.
 *
 *  Uses a mock meshopt decoder (no WASM/browser) to assert the decoder receives
 *  the exact mode/filter/count/stride, that a corrupt page is rejected before the
 *  codec is ever invoked, and that decoded index bounds and codec failures map to
 *  stable error codes. */

import { describe, expect, it } from "vitest";
import { decodeMeshLoDPage } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import { crc32c } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-format.js";
import { isMeshLoDError } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-errors.js";
import type { MeshoptDecoderModule } from "../../../../packages/babylon-lite/src/loader-gltf/meshopt-decode.js";
import type { MeshLoDPageRecord } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-testing.js";

const VERTEX_COUNT = 3;
const INDEX_COUNT = 3;
const DEC_VERTEX_BYTES = VERTEX_COUNT * 24;
const DEC_INDEX_BYTES = INDEX_COUNT * 2;

interface DecodeCall {
    targetLength: number;
    count: number;
    size: number;
    mode: string;
    filter?: string;
    sourceLength: number;
}

function mockDecoder(options?: { indexValues?: number[]; throwOnDecode?: boolean }): { decoder: MeshoptDecoderModule; calls: DecodeCall[] } {
    const calls: DecodeCall[] = [];
    const decoder: MeshoptDecoderModule = {
        ready: Promise.resolve(),
        decodeGltfBuffer(target, count, size, source, mode, filter) {
            calls.push({ targetLength: target.length, count, size, mode, filter, sourceLength: source.length });
            if (options?.throwOnDecode) {
                throw new Error("codec failure");
            }
            if (mode === "TRIANGLES") {
                const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
                const values = options?.indexValues ?? [0, 1, 2];
                for (let i = 0; i < count; i++) {
                    view.setUint16(i * 2, values[i] ?? 0, true);
                }
            }
        },
    };
    return { decoder, calls };
}

function buildStoredPage(): Uint8Array {
    const encVertexOffset = 64;
    const encVertexBytes = 10;
    const encIndexOffset = 74;
    const encIndexBytes = 6;
    const storedPage = new Uint8Array(128);
    const view = new DataView(storedPage.buffer);
    "MLPG".split("").forEach((ch, i) => (storedPage[i] = ch.charCodeAt(0)));
    view.setUint16(4, 1, true); // major
    view.setUint16(6, 64, true); // header bytes
    view.setUint32(8, 0, true); // page id
    view.setUint32(12, 0x3, true); // flags pinned|coarse
    view.setUint32(16, VERTEX_COUNT, true);
    view.setUint32(20, INDEX_COUNT, true);
    view.setUint32(24, encVertexOffset, true);
    view.setUint32(28, encVertexBytes, true);
    view.setUint32(32, DEC_VERTEX_BYTES, true);
    view.setUint32(36, encIndexOffset, true);
    view.setUint32(40, encIndexBytes, true);
    view.setUint32(44, DEC_INDEX_BYTES, true);
    view.setUint32(48, 24, true); // vertex stride
    view.setUint32(52, 2, true); // index stride
    for (let i = 0; i < encVertexBytes; i++) {
        storedPage[encVertexOffset + i] = i + 1;
    }
    for (let i = 0; i < encIndexBytes; i++) {
        storedPage[encIndexOffset + i] = i + 1;
    }
    return storedPage;
}

function pageFor(storedPage: Uint8Array): MeshLoDPageRecord {
    return {
        offset: 0,
        storedBytes: storedPage.length,
        meaningfulBytes: 80,
        decodedBytes: 65536,
        crc: crc32c(storedPage),
        vertexCount: VERTEX_COUNT,
        localIndexCount: INDEX_COUNT,
        vertexByteOffset: 0,
        indexByteOffset: DEC_VERTEX_BYTES,
        firstCluster: 0,
        clusterCount: 1,
        pinned: true,
        coarse: true,
        minDepth: 0,
        maxDepth: 0,
    };
}

function expectCode(fn: () => void, code: string): void {
    let threw: unknown;
    try {
        fn();
    } catch (error) {
        threw = error;
    }
    expect(isMeshLoDError(threw) && threw.code).toBe(code);
}

describe("decodeMeshLoDPage", () => {
    it("decodes vertices as ATTRIBUTES/NONE and indices as TRIANGLES/NONE", () => {
        const storedPage = buildStoredPage();
        const { decoder, calls } = mockDecoder();
        const result = decodeMeshLoDPage(storedPage, pageFor(storedPage), decoder);
        expect(result.vertexCount).toBe(3);
        expect(result.indexCount).toBe(3);
        expect(result.decoded.length).toBe(65536);
        expect(calls).toEqual([
            { targetLength: DEC_VERTEX_BYTES, count: 3, size: 24, mode: "ATTRIBUTES", filter: "NONE", sourceLength: 10 },
            { targetLength: DEC_INDEX_BYTES, count: 3, size: 2, mode: "TRIANGLES", filter: "NONE", sourceLength: 6 },
        ]);
    });

    it("rejects a CRC mismatch before invoking the decoder", () => {
        const storedPage = buildStoredPage();
        const page = pageFor(storedPage);
        storedPage[100] = storedPage[100]! ^ 0xff; // corrupt after computing the page CRC
        const { decoder, calls } = mockDecoder();
        expectCode(() => decodeMeshLoDPage(storedPage, page, decoder), "MLOD_PAGE_INTEGRITY");
        expect(calls).toHaveLength(0);
    });

    it("rejects a bad magic before invoking the decoder", () => {
        const storedPage = buildStoredPage();
        storedPage[0] = 0x58; // resealed below, so CRC passes and magic fails
        const { decoder, calls } = mockDecoder();
        expectCode(() => decodeMeshLoDPage(storedPage, pageFor(storedPage), decoder), "MLOD_PAGE_INTEGRITY");
        expect(calls).toHaveLength(0);
    });

    it("rejects unexpected strides before invoking the decoder", () => {
        const storedPage = buildStoredPage();
        new DataView(storedPage.buffer).setUint32(48, 25, true); // vertex stride != 24
        const { decoder, calls } = mockDecoder();
        expectCode(() => decodeMeshLoDPage(storedPage, pageFor(storedPage), decoder), "MLOD_PAGE_INTEGRITY");
        expect(calls).toHaveLength(0);
    });

    it("maps a codec failure to MLOD_DECODER_FAILURE", () => {
        const storedPage = buildStoredPage();
        const { decoder } = mockDecoder({ throwOnDecode: true });
        expectCode(() => decodeMeshLoDPage(storedPage, pageFor(storedPage), decoder), "MLOD_DECODER_FAILURE");
    });

    it("rejects an out-of-range decoded index", () => {
        const storedPage = buildStoredPage();
        const { decoder } = mockDecoder({ indexValues: [0, 1, 5] });
        expectCode(() => decodeMeshLoDPage(storedPage, pageFor(storedPage), decoder), "MLOD_PAGE_INTEGRITY");
    });
});
