/** MeshLoD page decoder — validates a stored page and decodes its meshopt streams.
 *
 *  Reuses the shared lazy meshoptimizer decoder (the same `/meshopt_decoder.js`
 *  script + WASM singleton the glTF `EXT_meshopt_compression` path uses) so a
 *  MeshLoD scene loads exactly one decoder and non-MeshLoD scenes fetch none. The
 *  decoder is dynamically imported on the first page decode.
 *
 *  A page's integrity (CRC), stored-page framing, strides, stream ranges, and
 *  declared decoded sizes are validated BEFORE the codec runs; decoded index
 *  bounds are validated after. Vertex streams decode as `ATTRIBUTES`/`NONE` and
 *  index streams as `TRIANGLES`/`NONE` — matching the converter's
 *  `meshopt_encodeVertexBuffer`/`meshopt_encodeIndexBuffer` output (24-byte
 *  vertices, `u16` local indices). */

import type { MeshLoDPageRecord } from "./mesh-lod-runtime.js";
import type { MeshoptDecoderModule } from "../loader-gltf/meshopt-decode.js";
import { crc32c, DECODED_VERTEX_STRIDE, LOCAL_INDEX_STRIDE, STORED_PAGE_HEADER_SIZE, STORED_PAGE_MAGIC, STORED_PAGE_MAJOR } from "./mesh-lod-format.js";
import { createMeshLoDError } from "./mesh-lod-errors.js";

const SP = {
    magic: 0,
    major: 4,
    headerBytes: 6,
    pageId: 8,
    flags: 12,
    vertexCount: 16,
    localIndexCount: 20,
    encVertexOffset: 24,
    encVertexBytes: 28,
    decVertexBytes: 32,
    encIndexOffset: 36,
    encIndexBytes: 40,
    decIndexBytes: 44,
    vertexStride: 48,
    indexStride: 52,
} as const;

const VERTEX_MODE = "ATTRIBUTES";
const INDEX_MODE = "TRIANGLES";
const NO_FILTER = "NONE";

/** A decoded page: the full `decodedBytes` allocation (vertices at
 *  `vertexByteOffset`, `u16` indices at `indexByteOffset`, zero padding) ready for
 *  GPU upload, plus its element counts. */
export interface DecodedMeshLoDPage {
    readonly decoded: Uint8Array;
    readonly vertexCount: number;
    readonly indexCount: number;
}

let _decoder: MeshoptDecoderModule | null = null;

/** @internal Pre-seed (or clear) the shared decoder singleton. Used only by unit
 *  and integration tests to drive the loader with a mock decoder in Node, where the
 *  real `/meshopt_decoder.js` WASM script cannot load. Passing `null` resets it. */
export function _setMeshLoDPageDecoder(decoder: MeshoptDecoderModule | null): void {
    _decoder = decoder;
}

/** Lazily import and initialize the shared meshopt decoder (script + WASM). */
export async function getMeshLoDPageDecoder(): Promise<MeshoptDecoderModule> {
    if (_decoder) {
        return _decoder;
    }
    let getMeshoptDecoder: () => Promise<MeshoptDecoderModule>;
    try {
        ({ getMeshoptDecoder } = await import("../loader-gltf/meshopt-decode.js"));
    } catch (cause) {
        throw createMeshLoDError("MLOD_DECODER_LOAD", "failed to import the meshopt decoder module", { cause });
    }
    try {
        _decoder = await getMeshoptDecoder();
    } catch (cause) {
        throw createMeshLoDError("MLOD_DECODER_LOAD", "failed to load the meshopt decoder script", { cause });
    }
    return _decoder;
}

function rangeWithin(offset: number, length: number, total: number): boolean {
    return offset >= 0 && length >= 0 && offset + length <= total;
}

/** Validate and decode one stored page's streams into its decoded allocation.
 *  `storedPage` is the page's bytes `[offset, offset+storedBytes)`. */
export function decodeMeshLoDPage(storedPage: Uint8Array, page: MeshLoDPageRecord, decoder: MeshoptDecoderModule): DecodedMeshLoDPage {
    // Integrity before anything else — never interpret a corrupt page.
    if (storedPage.length !== page.storedBytes || crc32c(storedPage) !== page.crc) {
        throw createMeshLoDError("MLOD_PAGE_INTEGRITY", "page CRC mismatch");
    }
    if (storedPage.length < STORED_PAGE_HEADER_SIZE) {
        throw createMeshLoDError("MLOD_PAGE_INTEGRITY", "truncated stored page header");
    }
    const view = new DataView(storedPage.buffer, storedPage.byteOffset, storedPage.byteLength);
    const u16 = (o: number): number => view.getUint16(o, true);
    const u32 = (o: number): number => view.getUint32(o, true);

    let magic = "";
    for (let i = 0; i < 4; i++) {
        magic += String.fromCharCode(storedPage[SP.magic + i]!);
    }
    if (magic !== STORED_PAGE_MAGIC) {
        throw createMeshLoDError("MLOD_PAGE_INTEGRITY", "bad stored page magic");
    }
    if (u16(SP.major) !== STORED_PAGE_MAJOR || u16(SP.headerBytes) !== STORED_PAGE_HEADER_SIZE) {
        throw createMeshLoDError("MLOD_PAGE_INTEGRITY", "unsupported stored page header");
    }

    const vertexCount = u32(SP.vertexCount);
    const indexCount = u32(SP.localIndexCount);
    const encVertexOffset = u32(SP.encVertexOffset);
    const encVertexBytes = u32(SP.encVertexBytes);
    const decVertexBytes = u32(SP.decVertexBytes);
    const encIndexOffset = u32(SP.encIndexOffset);
    const encIndexBytes = u32(SP.encIndexBytes);
    const decIndexBytes = u32(SP.decIndexBytes);

    if (u32(SP.vertexStride) !== DECODED_VERTEX_STRIDE || u32(SP.indexStride) !== LOCAL_INDEX_STRIDE) {
        throw createMeshLoDError("MLOD_PAGE_INTEGRITY", "unexpected stream strides");
    }
    if (vertexCount !== page.vertexCount || indexCount !== page.localIndexCount) {
        throw createMeshLoDError("MLOD_PAGE_INTEGRITY", "stored page counts disagree with the page table");
    }
    if (decVertexBytes !== vertexCount * DECODED_VERTEX_STRIDE || decIndexBytes !== indexCount * LOCAL_INDEX_STRIDE) {
        throw createMeshLoDError("MLOD_PAGE_INTEGRITY", "decoded stream sizes disagree with counts");
    }
    if (!rangeWithin(encVertexOffset, encVertexBytes, storedPage.length) || !rangeWithin(encIndexOffset, encIndexBytes, storedPage.length)) {
        throw createMeshLoDError("MLOD_PAGE_INTEGRITY", "encoded stream is out of bounds");
    }
    if (!(encVertexOffset + encVertexBytes <= encIndexOffset || encIndexOffset + encIndexBytes <= encVertexOffset)) {
        throw createMeshLoDError("MLOD_PAGE_INTEGRITY", "encoded streams overlap");
    }
    // Decoded layout: vertices then indices, both inside the page's allocation.
    if (page.vertexByteOffset + decVertexBytes > page.indexByteOffset || page.indexByteOffset + decIndexBytes > page.decodedBytes) {
        throw createMeshLoDError("MLOD_PAGE_INTEGRITY", "decoded layout exceeds the page allocation");
    }

    const decoded = new Uint8Array(page.decodedBytes);
    const vertexTarget = decoded.subarray(page.vertexByteOffset, page.vertexByteOffset + decVertexBytes);
    try {
        decoder.decodeGltfBuffer(vertexTarget, vertexCount, DECODED_VERTEX_STRIDE, storedPage.subarray(encVertexOffset, encVertexOffset + encVertexBytes), VERTEX_MODE, NO_FILTER);
        if (indexCount > 0) {
            const indexTarget = decoded.subarray(page.indexByteOffset, page.indexByteOffset + decIndexBytes);
            decoder.decodeGltfBuffer(indexTarget, indexCount, LOCAL_INDEX_STRIDE, storedPage.subarray(encIndexOffset, encIndexOffset + encIndexBytes), INDEX_MODE, NO_FILTER);
        }
    } catch (cause) {
        throw createMeshLoDError("MLOD_DECODER_FAILURE", "meshopt stream decode failed", { cause });
    }

    // Local indices must reference vertices inside this page.
    const indices = new Uint16Array(decoded.buffer, decoded.byteOffset + page.indexByteOffset, indexCount);
    for (let i = 0; i < indexCount; i++) {
        if (indices[i]! >= vertexCount) {
            throw createMeshLoDError("MLOD_PAGE_INTEGRITY", "decoded index is out of range");
        }
    }

    return { decoded, vertexCount, indexCount };
}
