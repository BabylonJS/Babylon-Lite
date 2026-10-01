/** Minimal valid `.mlod` container builder for unit tests.
 *
 *  Produces a byte-exact valid container (matching `mesh-lod-tool`'s writer
 *  layout) with a single terminal/pinned group of two clusters in one pinned
 *  64 KiB page. Tests parse it to confirm exact metadata, then mutate byte copies
 *  to confirm each stable error code fires. CRCs reuse the parser's `crc32c` so a
 *  flipped byte always breaks the stored checksum; the parser's agreement with
 *  the native writer is proven separately against the committed statue assets. */

import { crc32c, HEADER_SIZE, PAGE_ALIGNMENT, SECTION_ENTRY_SIZE } from "../../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-format.js";

const FLT_MAX = 3.4028234663852886e38;

/** Byte offsets of interesting fields for targeted mutation. */
export interface FixtureLayout {
    readonly directoryOffset: number;
    readonly headerCrc: number;
    readonly directoryCrc: number;
    readonly headerReserved: number;
    readonly provOffset: number;
    readonly groupOffset: number;
    readonly clusterOffset: number;
    readonly nodeOffset: number;
    readonly refOffset: number;
    readonly pageTableOffset: number;
    readonly pageDataOffset: number;
    readonly totalBytes: number;
    /** First section-directory entry byte offset. */
    readonly firstEntry: number;
}

export interface Fixture {
    readonly bytes: Uint8Array;
    readonly layout: FixtureLayout;
}

function alignUp(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

/** Build a valid minimal container. */
export function buildMinimalContainer(): Fixture {
    const provJson = '{"cgltfRevision":"cgltf-rev","meshoptimizerRevision":"meshopt-rev","toolVersion":"1.0.0-test"}';
    const prov = new TextEncoder().encode(provJson);

    const groupBytes = 64;
    const clusterBytes = 128;
    const nodeBytes = 32;
    const refBytes = 4;
    const pageTableBytes = 64;
    const pageBytes = PAGE_ALIGNMENT; // one 64 KiB page

    const directoryOffset = alignUp(HEADER_SIZE, 64);
    const directoryBytes = 7 * SECTION_ENTRY_SIZE;
    let cursor = directoryOffset + directoryBytes;
    const provOffset = alignUp(cursor, 64);
    cursor = provOffset + prov.length;
    const groupOffset = alignUp(cursor, 64);
    cursor = groupOffset + groupBytes;
    const clusterOffset = alignUp(cursor, 64);
    cursor = clusterOffset + clusterBytes;
    const nodeOffset = alignUp(cursor, 64);
    cursor = nodeOffset + nodeBytes;
    const refOffset = alignUp(cursor, 64);
    cursor = refOffset + refBytes;
    const pageTableOffset = alignUp(cursor, 64);
    cursor = pageTableOffset + pageTableBytes;
    const pageDataOffset = alignUp(cursor, PAGE_ALIGNMENT);
    const totalBytes = pageDataOffset + pageBytes;
    const bootstrapBytes = totalBytes; // the single pinned page is last

    const bytes = new Uint8Array(totalBytes);
    const view = new DataView(bytes.buffer);
    const wU16 = (o: number, v: number): void => view.setUint16(o, v, true);
    const wU32 = (o: number, v: number): void => view.setUint32(o, v, true);
    const wI32 = (o: number, v: number): void => view.setInt32(o, v, true);
    const wU64 = (o: number, v: number): void => view.setBigUint64(o, BigInt(v), true);
    const wF32 = (o: number, v: number): void => view.setFloat32(o, v, true);
    const wAscii = (o: number, s: string): void => {
        for (let i = 0; i < s.length; i++) {
            bytes[o + i] = s.charCodeAt(i);
        }
    };

    // ── Sections ──
    bytes.set(prov, provOffset);

    // group 0: terminal + pinned, 2 clusters, 1 page ref
    wF32(groupOffset + 0, 0);
    wF32(groupOffset + 4, 0);
    wF32(groupOffset + 8, 0);
    wF32(groupOffset + 12, 1); // radius
    wF32(groupOffset + 16, FLT_MAX); // terminal error
    wU32(groupOffset + 20, 0); // depth
    wU32(groupOffset + 24, 0); // firstCluster
    wU32(groupOffset + 28, 2); // clusterCount
    wU32(groupOffset + 32, 0); // firstPageRef
    wU16(groupOffset + 36, 1); // pageRefCount
    wU16(groupOffset + 38, 0x1 | 0x2); // terminal | pinned
    wU32(groupOffset + 40, 2); // sourceTriangles
    wU32(groupOffset + 44, 2); // emittedTriangles

    // clusters 0 and 1
    for (let c = 0; c < 2; c++) {
        const b = clusterOffset + c * 64;
        wF32(b + 0, 0);
        wF32(b + 4, 0);
        wF32(b + 8, 0);
        wF32(b + 12, 1);
        wF32(b + 16, 0.5); // error
        wU32(b + 20, 0); // groupId
        wI32(b + 24, -1); // refinedGroupId
        wU32(b + 28, 0); // pageId
        wU32(b + 32, c * 3); // firstVertex
        wU32(b + 36, c * 3); // firstLocalIndex
        wU16(b + 40, 3); // vertexCount
        wU16(b + 42, 1); // triangleCount
        wU32(b + 44, 1); // sourceTriangles
    }

    // node 0: leaf → group 0
    wF32(nodeOffset + 0, 0);
    wF32(nodeOffset + 4, 0);
    wF32(nodeOffset + 8, 0);
    wF32(nodeOffset + 12, 1);
    wF32(nodeOffset + 16, FLT_MAX);
    wI32(nodeOffset + 20, 0); // group 0
    wU32(nodeOffset + 24, 0); // firstChild
    wU32(nodeOffset + 28, 0); // childCount

    // group-page refs: [0]
    wU32(refOffset, 0);

    // page table record 0
    wU64(pageTableOffset + 0, pageDataOffset);
    wU32(pageTableOffset + 8, pageBytes); // stored
    wU32(pageTableOffset + 12, pageBytes); // meaningful
    wU32(pageTableOffset + 16, pageBytes); // decoded
    // crc filled after page bytes are written
    wU32(pageTableOffset + 24, 6); // vertexCount
    wU32(pageTableOffset + 28, 6); // localIndexCount
    wU32(pageTableOffset + 32, 0); // vertexByteOffset
    wU32(pageTableOffset + 36, 6 * 24); // indexByteOffset
    wU32(pageTableOffset + 40, 0); // firstCluster
    wU32(pageTableOffset + 44, 2); // clusterCount
    wU32(pageTableOffset + 48, 0x1 | 0x2); // pinned | coarse
    wU16(pageTableOffset + 52, 0); // minDepth
    wU16(pageTableOffset + 54, 0); // maxDepth

    // stored page framing
    wAscii(pageDataOffset + 0, "MLPG");
    wU16(pageDataOffset + 4, 1); // major
    wU16(pageDataOffset + 6, 64); // header bytes
    wU32(pageDataOffset + 8, 0); // pageId
    wU32(pageDataOffset + 12, 0x1 | 0x2); // flags
    wU32(pageDataOffset + 16, 6); // vertexCount
    wU32(pageDataOffset + 20, 6); // localIndexCount
    wU32(pageDataOffset + 24, 64); // encVertexOffset (right after the 64-byte stored header)
    wU32(pageDataOffset + 28, 16); // encVertexBytes
    wU32(pageDataOffset + 32, 6 * 24); // decVertexBytes
    wU32(pageDataOffset + 36, 80); // encIndexOffset
    wU32(pageDataOffset + 40, 12); // encIndexBytes
    wU32(pageDataOffset + 44, 6 * 2); // decIndexBytes
    wU32(pageDataOffset + 48, 24); // vertex stride
    wU32(pageDataOffset + 52, 2); // index stride
    // Dummy encoded streams — a mock decoder ignores their content but the framing
    // (disjoint, in-bounds ranges) must validate before the codec is invoked.
    for (let i = 0; i < 28; i++) {
        bytes[pageDataOffset + 64 + i] = i + 1;
    }
    wU32(pageTableOffset + 20, crc32c(bytes, pageDataOffset, pageDataOffset + pageBytes));

    // ── Directory (sorted by type) ──
    const entry = (i: number, type: number, flags: number, offset: number, stored: number, decoded: number, count: number, stride: number, alignment: number): void => {
        const b = directoryOffset + i * SECTION_ENTRY_SIZE;
        wU32(b + 0, type);
        wU32(b + 4, flags);
        wU64(b + 8, offset);
        wU64(b + 16, stored);
        wU64(b + 24, decoded);
        wU32(b + 32, count);
        wU32(b + 36, stride);
        wU32(b + 44, alignment);
        const crc = flags & 0x8 ? 0 : crc32c(bytes, offset, offset + stored);
        wU32(b + 40, crc);
    };
    entry(0, 1, 0x1, provOffset, prov.length, prov.length, prov.length, 0, 64);
    entry(1, 2, 0x1, groupOffset, groupBytes, groupBytes, 1, 64, 64);
    entry(2, 3, 0x1, clusterOffset, clusterBytes, clusterBytes, 2, 64, 64);
    entry(3, 4, 0x1, nodeOffset, nodeBytes, nodeBytes, 1, 32, 64);
    entry(4, 5, 0x1, refOffset, refBytes, refBytes, 1, 4, 64);
    entry(5, 6, 0x1, pageTableOffset, pageTableBytes, pageTableBytes, 1, 64, 64);
    entry(6, 7, 0x1 | 0x8, pageDataOffset, pageBytes, pageBytes, 1, 0, PAGE_ALIGNMENT);
    const directoryCrc = crc32c(bytes, directoryOffset, directoryOffset + directoryBytes);

    // ── Header ──
    wAscii(0, "MESHLOD");
    bytes[7] = 0;
    wU16(8, 1); // format major
    wU16(10, 0); // format minor
    wU16(12, 1); // min reader major
    wU16(14, 0); // min reader minor
    wU32(16, 0x01020304); // endian tag
    wU32(20, HEADER_SIZE); // header bytes
    wU32(24, 0); // container flags
    wU32(28, 7); // section count
    wU64(32, directoryOffset);
    wU64(40, directoryBytes);
    wU64(48, bootstrapBytes);
    wU64(56, totalBytes);
    // sourceDigest (64..95) + buildFingerprint (96..127) + hierarchyId (128..143) left zero
    wU32(144, 0); // mesh index
    wU32(148, 0); // primitive index
    wU64(152, 2); // source triangle count
    wU64(160, 2); // total cluster triangles
    wU32(168, 2); // cluster count
    wU32(172, 1); // group count
    wU32(176, 1); // node count
    wU32(180, 1); // page count
    wU32(184, 1); // pinned page count
    wU32(188, 1); // level count
    wU32(192, 0x1 | 0x2); // attribute mask: position | normal
    wU32(196, 24); // vertex stride
    wF32(200, -1);
    wF32(204, -1);
    wF32(208, -1);
    wF32(212, 1);
    wF32(216, 1);
    wF32(220, 1);
    wF32(224, 0); // max nonterminal error
    wU32(228, 0); // header CRC placeholder
    wU32(232, directoryCrc);
    const headerCrc = crc32c(bytes, 0, HEADER_SIZE);
    wU32(228, headerCrc);

    return {
        bytes,
        layout: {
            directoryOffset,
            headerCrc: 228,
            directoryCrc: 232,
            headerReserved: 236,
            provOffset,
            groupOffset,
            clusterOffset,
            nodeOffset,
            refOffset,
            pageTableOffset,
            pageDataOffset,
            totalBytes,
            firstEntry: directoryOffset,
        },
    };
}

/** Recompute every page CRC, section CRC, the directory CRC, and the header CRC
 *  so a structural mutation reaches the parser's post-integrity validation
 *  instead of tripping an earlier checksum. Reads the layout back out of the
 *  (possibly mutated) bytes. */
export function resealContainer(bytes: Uint8Array): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rU32 = (o: number): number => view.getUint32(o, true);
    const rU64 = (o: number): number => Number(view.getBigUint64(o, true));
    const wU32 = (o: number, v: number): void => view.setUint32(o, v, true);

    const directoryOffset = rU64(32);
    const directoryBytes = rU64(40);
    const sectionCount = rU32(28);
    const pageCount = rU32(180);

    // Page CRCs first (page-table section is index 5, type 6).
    const pageTableOffset = rU64(directoryOffset + 5 * SECTION_ENTRY_SIZE + 8);
    for (let p = 0; p < pageCount; p++) {
        const rec = pageTableOffset + p * 64;
        const pOffset = rU64(rec + 0);
        const pStored = rU32(rec + 8);
        wU32(rec + 20, crc32c(bytes, pOffset, pOffset + pStored));
    }
    // Metadata section CRCs (page-data section, flag bit 3, keeps zero CRC).
    for (let i = 0; i < sectionCount; i++) {
        const e = directoryOffset + i * SECTION_ENTRY_SIZE;
        if (rU32(e + 4) & 0x8) {
            continue;
        }
        const off = rU64(e + 8);
        const stored = rU64(e + 16);
        wU32(e + 40, crc32c(bytes, off, off + stored));
    }
    // Directory CRC, then header CRC (its own field zeroed while computing).
    wU32(232, crc32c(bytes, directoryOffset, directoryOffset + directoryBytes));
    wU32(228, 0);
    wU32(228, crc32c(bytes, 0, HEADER_SIZE));
}
