/** MeshLoD `.mlod` binary parser and validator (architecture section 8).
 *
 *  Parses a complete container buffer into immutable metadata records and
 *  independently re-validates every structural, integrity, and hierarchy
 *  invariant the native converter enforced. This is the TypeScript counterpart of
 *  the C++ `validateContainer`: malformed, truncated, corrupt, or
 *  version-incompatible bytes fail with a stable {@link MeshLoDError} before any
 *  asset is registered. Codec (meshopt) page streams are NOT decoded here — page
 *  CRC and stored-page framing are validated, but vertex/index decoding is the
 *  page-decoder task's job.
 *
 *  All multi-byte values are little-endian; every field offset mirrors
 *  MegameshCLI's `include/mlod_format.h`. */

import type { MeshLoDCluster, MeshLoDGroup, MeshLoDHeader, MeshLoDHierarchyNode, MeshLoDPageRecord, MeshLoDSectionEntry } from "./mesh-lod-runtime.js";
import type { MeshLoDError, MeshLoDErrorCode, MeshLoDErrorContext } from "./mesh-lod-errors.js";
import type { MeshLoDMetadata } from "./mesh-lod.js";
import { createMeshLoDError } from "./mesh-lod-errors.js";

// ─── Global constants (mirror mlod_format.h) ─────────────────────────

export const MLOD_MAGIC = "MESHLOD\0";
export const FORMAT_MAJOR = 1;
export const FORMAT_MINOR = 0;
export const READER_MAJOR = 1;
export const READER_MINOR = 0;
export const ENDIAN_TAG = 0x01020304;

export const HEADER_SIZE = 256;
export const SECTION_ENTRY_SIZE = 64;
export const GROUP_RECORD_SIZE = 64;
export const CLUSTER_RECORD_SIZE = 64;
export const HIERARCHY_NODE_SIZE = 32;
export const PAGE_TABLE_RECORD_SIZE = 64;
export const STORED_PAGE_HEADER_SIZE = 64;

export const SECTION_ALIGNMENT = 64;
export const PAGE_ALIGNMENT = 64 * 1024;
export const DECODED_VERTEX_STRIDE = 24;
export const LOCAL_INDEX_STRIDE = 2;
export const PAGE_MAX_BYTES = 256 * 1024;

export const STORED_PAGE_MAGIC = "MLPG";
export const STORED_PAGE_MAJOR = 1;

export const SECTION_PROVENANCE_JSON = 1;
export const SECTION_GROUPS = 2;
export const SECTION_CLUSTERS = 3;
export const SECTION_HIERARCHY_NODES = 4;
export const SECTION_GROUP_PAGE_REFS = 5;
export const SECTION_PAGE_TABLE = 6;
export const SECTION_PAGE_DATA = 7;
export const REQUIRED_SECTION_COUNT = 7;

const SECTION_FLAG_REQUIRED = 1 << 0;
const SECTION_FLAG_OPTIONAL = 1 << 1;
const SECTION_FLAG_PER_ITEM_CRC = 1 << 2;
const SECTION_FLAG_PAGE_DATA = 1 << 3;

const ATTR_POSITION = 1 << 0;
const ATTR_NORMAL = 1 << 1;

const GROUP_FLAG_TERMINAL = 1 << 0;
const GROUP_FLAG_PINNED_COARSE = 1 << 1;
const CLUSTER_FLAG_NORMAL_CONE = 1 << 0;

const PAGE_FLAG_PINNED = 1 << 0;
const PAGE_FLAG_COARSE = 1 << 1;

// ─── CRC32C (Castagnoli, reflected — matches crc32c.cpp) ─────────────

let _crcTable: Uint32Array | null = null;

function crcTable(): Uint32Array {
    if (_crcTable) {
        return _crcTable;
    }
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let crc = i;
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 1 ? 0x82f63b78 ^ (crc >>> 1) : crc >>> 1;
        }
        table[i] = crc >>> 0;
    }
    return (_crcTable = table);
}

/** CRC32C over `bytes[begin, end)`. Returns an unsigned 32-bit integer. */
export function crc32c(bytes: Uint8Array, begin = 0, end = bytes.length): number {
    const table = crcTable();
    let crc = 0xffffffff;
    for (let i = begin; i < end; i++) {
        crc = (table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// ─── Parsed container ────────────────────────────────────────────────

/** Provenance strings parsed from the canonical `PROVENANCE_JSON` section. */
export interface MeshLoDProvenance {
    readonly toolVersion: string;
    readonly meshoptimizerRevision: string;
    readonly cgltfRevision: string;
}

/** Fully parsed and validated container metadata. */
export interface ParsedMeshLoDContainer {
    readonly header: MeshLoDHeader;
    readonly sections: readonly MeshLoDSectionEntry[];
    readonly provenance: MeshLoDProvenance;
    readonly groups: readonly MeshLoDGroup[];
    readonly clusters: readonly MeshLoDCluster[];
    readonly hierarchyNodes: readonly MeshLoDHierarchyNode[];
    readonly pageRecords: readonly MeshLoDPageRecord[];
    readonly groupPageRefs: Uint32Array;
}

// ─── Little-endian reader ────────────────────────────────────────────

class Reader {
    readonly bytes: Uint8Array;
    private readonly view: DataView;

    constructor(bytes: Uint8Array) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    u16(offset: number): number {
        return this.view.getUint16(offset, true);
    }

    u32(offset: number): number {
        return this.view.getUint32(offset, true);
    }

    i32(offset: number): number {
        return this.view.getInt32(offset, true);
    }

    f32(offset: number): number {
        return this.view.getFloat32(offset, true);
    }

    /** Reads a u64 as a Number, failing if it exceeds the safe-integer range. */
    u64(offset: number): number {
        const value = this.view.getBigUint64(offset, true);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw fail("MLOD_INVALID_LAYOUT", "64-bit value exceeds the safe integer range", { byteOffset: offset });
        }
        return Number(value);
    }

    ascii(offset: number, length: number): string {
        let s = "";
        for (let i = 0; i < length; i++) {
            s += String.fromCharCode(this.bytes[offset + i]!);
        }
        return s;
    }

    hex(offset: number, length: number): string {
        let s = "";
        for (let i = 0; i < length; i++) {
            s += this.bytes[offset + i]!.toString(16).padStart(2, "0");
        }
        return s;
    }

    allZero(offset: number, length: number): boolean {
        for (let i = 0; i < length; i++) {
            if (this.bytes[offset + i] !== 0) {
                return false;
            }
        }
        return true;
    }
}

function fail(code: MeshLoDErrorCode, message: string, context?: MeshLoDErrorContext): MeshLoDError {
    return createMeshLoDError(code, `.mlod: ${message}`, context);
}

// ─── Header ──────────────────────────────────────────────────────────

const H = {
    magic: 0,
    formatMajor: 8,
    formatMinor: 10,
    minReaderMajor: 12,
    minReaderMinor: 14,
    endianTag: 16,
    headerBytes: 20,
    containerFlags: 24,
    sectionCount: 28,
    directoryOffset: 32,
    directoryBytes: 40,
    bootstrapBytes: 48,
    totalFileBytes: 56,
    sourceDigest: 64,
    buildFingerprint: 96,
    hierarchyId: 128,
    meshIndex: 144,
    primitiveIndex: 148,
    sourceTriangleCount: 152,
    totalClusterTriangles: 160,
    clusterCount: 168,
    groupCount: 172,
    nodeCount: 176,
    pageCount: 180,
    pinnedPageCount: 184,
    levelCount: 188,
    attributeMask: 192,
    vertexStride: 196,
    boundsMin: 200,
    boundsMax: 212,
    maxNonterminalError: 224,
    headerCrc: 228,
    directoryCrc: 232,
    reserved: 236,
    reservedSize: 20,
} as const;

function decodeHeader(reader: Reader): MeshLoDHeader {
    const size = reader.bytes.length;
    if (size < HEADER_SIZE) {
        throw fail("MLOD_TRUNCATED", "file smaller than the header", { expected: HEADER_SIZE, actual: size });
    }
    if (reader.ascii(H.magic, 8) !== MLOD_MAGIC) {
        throw fail("MLOD_BAD_MAGIC", "bad container magic");
    }
    const formatMajor = reader.u16(H.formatMajor);
    const formatMinor = reader.u16(H.formatMinor);
    const minReaderMajor = reader.u16(H.minReaderMajor);
    const minReaderMinor = reader.u16(H.minReaderMinor);
    if (formatMajor !== FORMAT_MAJOR) {
        throw fail("MLOD_UNSUPPORTED_VERSION", "unsupported format major", { expected: FORMAT_MAJOR, actual: formatMajor });
    }
    if (minReaderMajor > READER_MAJOR || (minReaderMajor === READER_MAJOR && minReaderMinor > READER_MINOR)) {
        throw fail("MLOD_UNSUPPORTED_VERSION", "container requires a newer reader", {
            expected: `${READER_MAJOR}.${READER_MINOR}`,
            actual: `${minReaderMajor}.${minReaderMinor}`,
        });
    }
    if (reader.u32(H.endianTag) !== ENDIAN_TAG) {
        throw fail("MLOD_UNSUPPORTED_ENDIAN", "bad endian tag");
    }
    if (reader.u32(H.headerBytes) !== HEADER_SIZE) {
        throw fail("MLOD_HEADER_INTEGRITY", "bad header size", { expected: HEADER_SIZE, actual: reader.u32(H.headerBytes) });
    }
    const totalFileBytes = reader.u64(H.totalFileBytes);
    const bootstrapBytes = reader.u64(H.bootstrapBytes);
    if (bootstrapBytes < HEADER_SIZE || bootstrapBytes > totalFileBytes) {
        throw fail("MLOD_INVALID_LAYOUT", "bootstrap bytes are out of range", { expected: totalFileBytes, actual: bootstrapBytes });
    }
    if (!reader.allZero(H.reserved, H.reservedSize)) {
        throw fail("MLOD_INVALID_LAYOUT", "header reserved bytes are not zero", { byteOffset: H.reserved });
    }

    // Header CRC is computed over the full 256-byte header with its own field zeroed.
    const storedHeaderCrc = reader.u32(H.headerCrc);
    const headerCopy = reader.bytes.slice(0, HEADER_SIZE);
    headerCopy[H.headerCrc] = 0;
    headerCopy[H.headerCrc + 1] = 0;
    headerCopy[H.headerCrc + 2] = 0;
    headerCopy[H.headerCrc + 3] = 0;
    if (crc32c(headerCopy) !== storedHeaderCrc) {
        throw fail("MLOD_HEADER_INTEGRITY", "header CRC mismatch", { byteOffset: H.headerCrc });
    }

    return {
        formatMajor,
        formatMinor,
        minReaderMajor,
        minReaderMinor,
        containerFlags: reader.u32(H.containerFlags),
        sectionCount: reader.u32(H.sectionCount),
        directoryOffset: reader.u64(H.directoryOffset),
        directoryBytes: reader.u64(H.directoryBytes),
        bootstrapBytes,
        totalFileBytes,
        sourceSha256: reader.hex(H.sourceDigest, 32),
        buildFingerprintSha256: reader.hex(H.buildFingerprint, 32),
        hierarchyId: reader.hex(H.hierarchyId, 16),
        meshIndex: reader.u32(H.meshIndex),
        primitiveIndex: reader.u32(H.primitiveIndex),
        sourceTriangleCount: reader.u64(H.sourceTriangleCount),
        hierarchyTriangleCount: reader.u64(H.totalClusterTriangles),
        clusterCount: reader.u32(H.clusterCount),
        groupCount: reader.u32(H.groupCount),
        hierarchyNodeCount: reader.u32(H.nodeCount),
        pageCount: reader.u32(H.pageCount),
        pinnedPageCount: reader.u32(H.pinnedPageCount),
        levelCount: reader.u32(H.levelCount),
        attributeMask: reader.u32(H.attributeMask),
        vertexStride: reader.u32(H.vertexStride),
        boundsMin: [reader.f32(H.boundsMin), reader.f32(H.boundsMin + 4), reader.f32(H.boundsMin + 8)],
        boundsMax: [reader.f32(H.boundsMax), reader.f32(H.boundsMax + 4), reader.f32(H.boundsMax + 8)],
        maxNonterminalError: reader.f32(H.maxNonterminalError),
    };
}

/** Validate the header and confirm the buffer holds at least the coarse bootstrap
 *  region (and no more than the declared file). */
function parseHeader(reader: Reader): MeshLoDHeader {
    const header = decodeHeader(reader);
    const size = reader.bytes.length;
    if (size > header.totalFileBytes) {
        throw fail("MLOD_INVALID_LAYOUT", "buffer size exceeds the declared file size", { expected: header.totalFileBytes, actual: size });
    }
    if (size < header.bootstrapBytes) {
        throw fail("MLOD_TRUNCATED", "buffer shorter than the coarse bootstrap region", { expected: header.bootstrapBytes, actual: size });
    }
    return header;
}

// ─── Section directory ───────────────────────────────────────────────

const SE = {
    type: 0,
    flags: 4,
    offset: 8,
    storedBytes: 16,
    decodedBytes: 24,
    elementCount: 32,
    elementStride: 36,
    crc: 40,
    alignment: 44,
    reserved: 48,
    reservedSize: 16,
} as const;

function rangeWithin(offset: number, length: number, total: number): boolean {
    return offset >= 0 && length >= 0 && offset + length <= total;
}

function rangesDisjoint(offsetA: number, lengthA: number, offsetB: number, lengthB: number): boolean {
    return offsetA + lengthA <= offsetB || offsetB + lengthB <= offsetA;
}

function parseDirectory(reader: Reader, header: MeshLoDHeader): MeshLoDSectionEntry[] {
    const size = header.totalFileBytes;
    const { sectionCount, directoryOffset, directoryBytes } = header;
    if (sectionCount !== REQUIRED_SECTION_COUNT) {
        throw fail("MLOD_INVALID_LAYOUT", "unexpected section count", { expected: REQUIRED_SECTION_COUNT, actual: sectionCount });
    }
    if (directoryBytes !== sectionCount * SECTION_ENTRY_SIZE) {
        throw fail("MLOD_INVALID_LAYOUT", "directory size disagrees with the section count");
    }
    if (!rangeWithin(directoryOffset, directoryBytes, size) || directoryOffset + directoryBytes > PAGE_ALIGNMENT) {
        throw fail("MLOD_INVALID_LAYOUT", "directory is out of the first 64 KiB", { byteOffset: directoryOffset });
    }
    if (reader.u32(H.directoryCrc) !== crc32c(reader.bytes, directoryOffset, directoryOffset + directoryBytes)) {
        throw fail("MLOD_DIRECTORY_INTEGRITY", "directory CRC mismatch");
    }

    const entries: MeshLoDSectionEntry[] = [];
    let previousType = 0;
    for (let i = 0; i < sectionCount; i++) {
        const base = directoryOffset + i * SECTION_ENTRY_SIZE;
        if (!reader.allZero(base + SE.reserved, SE.reservedSize)) {
            throw fail("MLOD_INVALID_LAYOUT", "section entry reserved bytes are not zero", { byteOffset: base + SE.reserved });
        }
        const type = reader.u32(base + SE.type);
        const flags = reader.u32(base + SE.flags);
        const offset = reader.u64(base + SE.offset);
        const storedBytes = reader.u64(base + SE.storedBytes);
        const decodedBytes = reader.u64(base + SE.decodedBytes);
        const elementCount = reader.u32(base + SE.elementCount);
        const elementStride = reader.u32(base + SE.elementStride);
        const crc = reader.u32(base + SE.crc);
        const alignment = reader.u32(base + SE.alignment);

        if (i > 0 && type <= previousType) {
            throw fail("MLOD_INVALID_LAYOUT", "directory is not sorted by section type", { sectionType: type });
        }
        previousType = type;
        if (type !== i + 1) {
            throw fail("MLOD_INVALID_LAYOUT", "missing or misordered required section", { sectionType: type });
        }
        if (!rangeWithin(offset, storedBytes, size)) {
            throw fail("MLOD_INVALID_LAYOUT", "section range is out of bounds", { sectionType: type, byteOffset: offset });
        }
        if (alignment === 0 || offset % alignment !== 0) {
            throw fail("MLOD_INVALID_LAYOUT", "section is not aligned", { sectionType: type, byteOffset: offset });
        }
        const pageData = (flags & SECTION_FLAG_PAGE_DATA) !== 0;
        if (!pageData) {
            if (decodedBytes !== storedBytes) {
                throw fail("MLOD_INVALID_LAYOUT", "metadata decoded size disagrees with stored size", { sectionType: type });
            }
            if (crc32c(reader.bytes, offset, offset + storedBytes) !== crc) {
                throw fail("MLOD_SECTION_INTEGRITY", "section CRC mismatch", { sectionType: type });
            }
        } else if (crc !== 0) {
            throw fail("MLOD_INVALID_LAYOUT", "page-data section must have a zero section CRC", { sectionType: type });
        }

        entries.push({
            type,
            flags,
            required: (flags & SECTION_FLAG_REQUIRED) !== 0,
            optional: (flags & SECTION_FLAG_OPTIONAL) !== 0,
            perItemCrc: (flags & SECTION_FLAG_PER_ITEM_CRC) !== 0,
            pageData,
            offset,
            storedBytes,
            decodedBytes,
            elementCount,
            elementStride,
            crc,
            alignment,
        });
    }

    // No section may overlap the directory or another section (touching allowed).
    for (let i = 0; i < sectionCount; i++) {
        const a = entries[i]!;
        if (a.storedBytes > 0 && a.offset < directoryOffset + directoryBytes && !rangesDisjoint(a.offset, a.storedBytes, directoryOffset, directoryBytes)) {
            throw fail("MLOD_INVALID_LAYOUT", "a section overlaps the directory", { sectionType: a.type });
        }
        for (let j = i + 1; j < sectionCount; j++) {
            const b = entries[j]!;
            if (!rangesDisjoint(a.offset, a.storedBytes, b.offset, b.storedBytes)) {
                throw fail("MLOD_INVALID_LAYOUT", "two sections overlap", { sectionType: a.type });
            }
        }
    }
    return entries;
}

// ─── Provenance JSON ─────────────────────────────────────────────────

function parseProvenance(reader: Reader, entry: MeshLoDSectionEntry): MeshLoDProvenance {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(reader.bytes.subarray(entry.offset, entry.offset + entry.storedBytes));
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (cause) {
        throw fail("MLOD_INVALID_LAYOUT", "provenance JSON is not valid", { sectionType: SECTION_PROVENANCE_JSON, cause });
    }
    if (typeof parsed !== "object" || parsed === null) {
        throw fail("MLOD_INVALID_LAYOUT", "provenance JSON is not an object", { sectionType: SECTION_PROVENANCE_JSON });
    }
    const record = parsed as Record<string, unknown>;
    const readString = (key: string): string => {
        const value = record[key];
        if (typeof value !== "string") {
            throw fail("MLOD_INVALID_LAYOUT", `provenance is missing string field ${key}`, { sectionType: SECTION_PROVENANCE_JSON });
        }
        return value;
    };
    return {
        toolVersion: readString("toolVersion"),
        meshoptimizerRevision: readString("meshoptimizerRevision"),
        cgltfRevision: readString("cgltfRevision"),
    };
}

// ─── Records ─────────────────────────────────────────────────────────

const GR = {
    sphere: 0,
    error: 16,
    depth: 20,
    firstCluster: 24,
    clusterCount: 28,
    firstPageRef: 32,
    pageRefCount: 36,
    flags: 38,
    sourceTriangles: 40,
    emittedTriangles: 44,
} as const;
const CR = {
    sphere: 0,
    error: 16,
    groupId: 20,
    refinedGroupId: 24,
    pageId: 28,
    firstVertex: 32,
    firstLocalIndex: 36,
    vertexCount: 40,
    triangleCount: 42,
    sourceTriangles: 44,
    flags: 48,
    normalCone: 52,
    coneCutoff: 56,
} as const;
const NR = { sphere: 0, error: 16, group: 20, firstChild: 24, childCount: 28 } as const;
const PT = {
    offset: 0,
    storedBytes: 8,
    meaningfulBytes: 12,
    decodedBytes: 16,
    crc: 20,
    vertexCount: 24,
    localIndexCount: 28,
    vertexByteOffset: 32,
    indexByteOffset: 36,
    firstCluster: 40,
    clusterCount: 44,
    flags: 48,
    minDepth: 52,
    maxDepth: 54,
} as const;
const SP = { magic: 0, major: 4, headerBytes: 6, pageId: 8 } as const;

function parseGroups(reader: Reader, entry: MeshLoDSectionEntry, header: MeshLoDHeader): MeshLoDGroup[] {
    requireSection(entry, header.groupCount, GROUP_RECORD_SIZE, "GROUPS");
    const groups: MeshLoDGroup[] = [];
    for (let g = 0; g < header.groupCount; g++) {
        const base = entry.offset + g * GROUP_RECORD_SIZE;
        const flags = reader.u16(base + GR.flags);
        const depth = reader.u32(base + GR.depth);
        const firstCluster = reader.u32(base + GR.firstCluster);
        const clusterCount = reader.u32(base + GR.clusterCount);
        const firstPageRef = reader.u32(base + GR.firstPageRef);
        const pageRefCount = reader.u16(base + GR.pageRefCount);
        if (depth >= header.levelCount) {
            throw fail("MLOD_INVALID_HIERARCHY", "group depth exceeds the level count", { byteOffset: base });
        }
        if (firstCluster + clusterCount > header.clusterCount) {
            throw fail("MLOD_INVALID_HIERARCHY", "group cluster range is out of bounds", { byteOffset: base });
        }
        groups.push({
            center: [reader.f32(base + GR.sphere), reader.f32(base + GR.sphere + 4), reader.f32(base + GR.sphere + 8)],
            radius: reader.f32(base + GR.sphere + 12),
            simplifiedError: reader.f32(base + GR.error),
            depth,
            firstCluster,
            clusterCount,
            firstPageRef,
            pageRefCount,
            terminal: (flags & GROUP_FLAG_TERMINAL) !== 0,
            pinned: (flags & GROUP_FLAG_PINNED_COARSE) !== 0,
            sourceTriangleCount: reader.u32(base + GR.sourceTriangles),
            outputTriangleCount: reader.u32(base + GR.emittedTriangles),
        });
    }
    return groups;
}

function parseClusters(reader: Reader, entry: MeshLoDSectionEntry, header: MeshLoDHeader): MeshLoDCluster[] {
    requireSection(entry, header.clusterCount, CLUSTER_RECORD_SIZE, "CLUSTERS");
    const clusters: MeshLoDCluster[] = [];
    for (let c = 0; c < header.clusterCount; c++) {
        const base = entry.offset + c * CLUSTER_RECORD_SIZE;
        const groupId = reader.u32(base + CR.groupId);
        const refinedGroupId = reader.i32(base + CR.refinedGroupId);
        const pageId = reader.u32(base + CR.pageId);
        if (groupId >= header.groupCount) {
            throw fail("MLOD_INVALID_HIERARCHY", "cluster owning group is out of range", { byteOffset: base });
        }
        if (refinedGroupId !== -1 && (refinedGroupId < 0 || refinedGroupId >= groupId)) {
            throw fail("MLOD_INVALID_HIERARCHY", "cluster refined group is invalid", { byteOffset: base });
        }
        if (pageId >= header.pageCount) {
            throw fail("MLOD_INVALID_HIERARCHY", "cluster page id is out of range", { byteOffset: base });
        }
        const flags = reader.u32(base + CR.flags);
        let normalCone: readonly [number, number, number, number] | null = null;
        if ((flags & CLUSTER_FLAG_NORMAL_CONE) !== 0) {
            const packed = reader.u32(base + CR.normalCone);
            const snorm8 = (shift: number): number => {
                const byte = (packed >>> shift) & 0xff;
                return (byte >= 0x80 ? byte - 0x100 : byte) / 127;
            };
            const cutoff = reader.f32(base + CR.coneCutoff);
            if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff >= 1) {
                throw fail("MLOD_INVALID_HIERARCHY", "cluster normal cone cutoff is invalid", { byteOffset: base + CR.coneCutoff });
            }
            normalCone = [snorm8(0), snorm8(8), snorm8(16), cutoff];
        }
        clusters.push({
            center: [reader.f32(base + CR.sphere), reader.f32(base + CR.sphere + 4), reader.f32(base + CR.sphere + 8)],
            radius: reader.f32(base + CR.sphere + 12),
            error: reader.f32(base + CR.error),
            groupId,
            refinedGroupId,
            pageId,
            vertexOffset: reader.u32(base + CR.firstVertex),
            indexOffset: reader.u32(base + CR.firstLocalIndex),
            vertexCount: reader.u16(base + CR.vertexCount),
            triangleCount: reader.u16(base + CR.triangleCount),
            sourceTriangleCount: reader.u32(base + CR.sourceTriangles),
            normalCone,
        });
    }
    return clusters;
}

function parseNodes(reader: Reader, entry: MeshLoDSectionEntry, header: MeshLoDHeader): MeshLoDHierarchyNode[] {
    requireSection(entry, header.hierarchyNodeCount, HIERARCHY_NODE_SIZE, "HIERARCHY_NODES");
    const nodes: MeshLoDHierarchyNode[] = [];
    for (let n = 0; n < header.hierarchyNodeCount; n++) {
        const base = entry.offset + n * HIERARCHY_NODE_SIZE;
        const group = reader.i32(base + NR.group);
        const childOffset = reader.u32(base + NR.firstChild);
        const childCount = reader.u32(base + NR.childCount);
        if (group === -1) {
            if (childCount === 0 || childCount > 8 || childOffset + childCount > header.hierarchyNodeCount) {
                throw fail("MLOD_INVALID_HIERARCHY", "internal node children are invalid", { byteOffset: base });
            }
        } else if (group < 0 || group >= header.groupCount || childCount !== 0) {
            throw fail("MLOD_INVALID_HIERARCHY", "leaf node is invalid", { byteOffset: base });
        }
        nodes.push({
            center: [reader.f32(base + NR.sphere), reader.f32(base + NR.sphere + 4), reader.f32(base + NR.sphere + 8)],
            radius: reader.f32(base + NR.sphere + 12),
            error: reader.f32(base + NR.error),
            groupId: group,
            childOffset,
            childCount,
        });
    }
    if (nodes.length < header.levelCount) {
        throw fail("MLOD_INVALID_HIERARCHY", "hierarchy has fewer nodes than levels");
    }
    // Each level starts at its own root (nodes 0..levelCount-1). Walk the
    // resulting forest without recursion and reject shared/cyclic children.
    const state = new Uint8Array(nodes.length);
    const stack: number[] = [];
    for (let level = header.levelCount - 1; level >= 0; level--) {
        stack.push(level);
    }
    let visited = 0;
    while (stack.length > 0) {
        const id = stack.pop()!;
        if (id < 0) {
            state[~id] = 2;
            continue;
        }
        if (state[id] !== 0) {
            throw fail("MLOD_INVALID_HIERARCHY", "hierarchy contains a cycle or shared child", { byteOffset: entry.offset + id * HIERARCHY_NODE_SIZE });
        }
        state[id] = 1;
        visited++;
        stack.push(~id);
        const node = nodes[id]!;
        for (let child = node.childCount - 1; child >= 0; child--) {
            stack.push(node.childOffset + child);
        }
    }
    if (visited !== nodes.length) {
        throw fail("MLOD_INVALID_HIERARCHY", "hierarchy contains unreachable nodes", { expected: nodes.length, actual: visited });
    }
    return nodes;
}

function parseGroupPageRefs(reader: Reader, entry: MeshLoDSectionEntry, header: MeshLoDHeader): Uint32Array {
    if (entry.type !== SECTION_GROUP_PAGE_REFS || entry.elementStride !== 4 || entry.storedBytes !== entry.elementCount * 4) {
        throw fail("MLOD_INVALID_LAYOUT", "group-page-refs section is malformed", { sectionType: SECTION_GROUP_PAGE_REFS });
    }
    const refs = new Uint32Array(entry.elementCount);
    for (let r = 0; r < entry.elementCount; r++) {
        const value = reader.u32(entry.offset + r * 4);
        if (value >= header.pageCount) {
            throw fail("MLOD_INVALID_HIERARCHY", "group page ref is out of range", { byteOffset: entry.offset + r * 4 });
        }
        refs[r] = value;
    }
    return refs;
}

function parsePages(reader: Reader, pageTable: MeshLoDSectionEntry, pageData: MeshLoDSectionEntry, header: MeshLoDHeader): MeshLoDPageRecord[] {
    requireSection(pageTable, header.pageCount, PAGE_TABLE_RECORD_SIZE, "PAGE_TABLE");
    if (pageData.elementCount !== header.pageCount) {
        throw fail("MLOD_INVALID_LAYOUT", "page-data element count disagrees with the header");
    }
    const size = header.totalFileBytes;
    const available = reader.bytes.length;
    const pages: MeshLoDPageRecord[] = [];
    const ranges: Array<[number, number]> = [];
    let previousPageEnd = pageData.offset;
    let pinnedEnd = pageData.offset;

    for (let p = 0; p < header.pageCount; p++) {
        const base = pageTable.offset + p * PAGE_TABLE_RECORD_SIZE;
        const offset = reader.u64(base + PT.offset);
        const storedBytes = reader.u32(base + PT.storedBytes);
        const decodedBytes = reader.u32(base + PT.decodedBytes);
        const crc = reader.u32(base + PT.crc);
        const flags = reader.u32(base + PT.flags);
        const firstCluster = reader.u32(base + PT.firstCluster);
        const clusterCount = reader.u32(base + PT.clusterCount);

        if (offset % PAGE_ALIGNMENT !== 0 || storedBytes % PAGE_ALIGNMENT !== 0 || storedBytes < PAGE_ALIGNMENT || storedBytes > PAGE_MAX_BYTES) {
            throw fail("MLOD_INVALID_LAYOUT", "page violates 64-256 KiB alignment", { pageId: p, byteOffset: base });
        }
        if (decodedBytes === 0 || decodedBytes > PAGE_MAX_BYTES) {
            throw fail("MLOD_INVALID_LAYOUT", "decoded page allocation is outside the format limits", {
                pageId: p,
                byteOffset: base + PT.decodedBytes,
                expected: `1-${PAGE_MAX_BYTES} bytes`,
                actual: decodedBytes,
            });
        }
        if (!rangeWithin(offset, storedBytes, size) || offset !== previousPageEnd) {
            throw fail("MLOD_INVALID_LAYOUT", "page data is not contiguous", { pageId: p, byteOffset: offset });
        }
        previousPageEnd = offset + storedBytes;
        // Page DATA (CRC + stored-page framing) is validated only for pages present
        // in the available bytes. During a coarse bootstrap the fine pages are
        // beyond `available`; they are validated per-page as they stream in.
        if (offset + storedBytes <= available) {
            if (crc32c(reader.bytes, offset, offset + storedBytes) !== crc) {
                throw fail("MLOD_PAGE_INTEGRITY", "page CRC mismatch", { pageId: p, byteOffset: offset });
            }
            if (reader.ascii(offset + SP.magic, 4) !== STORED_PAGE_MAGIC) {
                throw fail("MLOD_PAGE_INTEGRITY", "bad stored page magic", { pageId: p, byteOffset: offset });
            }
            if (reader.u32(offset + SP.pageId) !== p) {
                throw fail("MLOD_PAGE_INTEGRITY", "stored page id mismatch", { pageId: p, byteOffset: offset });
            }
        }
        const pinned = (flags & PAGE_FLAG_PINNED) !== 0;
        if (pinned !== p < header.pinnedPageCount) {
            throw fail("MLOD_INVALID_HIERARCHY", "pinned pages are not a contiguous prefix", { pageId: p });
        }
        if (pinned) {
            pinnedEnd = offset + storedBytes;
        }
        if (firstCluster + clusterCount > header.clusterCount) {
            throw fail("MLOD_INVALID_HIERARCHY", "page cluster range is out of bounds", { pageId: p });
        }
        ranges.push([firstCluster, clusterCount]);

        pages.push({
            offset,
            storedBytes,
            meaningfulBytes: reader.u32(base + PT.meaningfulBytes),
            decodedBytes,
            crc,
            vertexCount: reader.u32(base + PT.vertexCount),
            localIndexCount: reader.u32(base + PT.localIndexCount),
            vertexByteOffset: reader.u32(base + PT.vertexByteOffset),
            indexByteOffset: reader.u32(base + PT.indexByteOffset),
            firstCluster,
            clusterCount,
            pinned,
            coarse: (flags & PAGE_FLAG_COARSE) !== 0,
            minDepth: reader.u16(base + PT.minDepth),
            maxDepth: reader.u16(base + PT.maxDepth),
        });
    }

    // Pages tile every cluster exactly once (page ids are pinned-first ordered).
    ranges.sort((a, b) => a[0] - b[0]);
    let tiling = 0;
    for (const [first, count] of ranges) {
        if (first !== tiling) {
            throw fail("MLOD_INVALID_HIERARCHY", "page cluster ranges do not tile");
        }
        tiling += count;
    }
    if (tiling !== header.clusterCount) {
        throw fail("MLOD_INVALID_HIERARCHY", "pages do not cover every cluster", { expected: header.clusterCount, actual: tiling });
    }
    if (previousPageEnd !== size) {
        throw fail("MLOD_INVALID_LAYOUT", "page data does not reach the end of the file", { expected: size, actual: previousPageEnd });
    }
    if (header.bootstrapBytes !== pinnedEnd) {
        throw fail("MLOD_INVALID_LAYOUT", "bootstrap bytes do not match the pinned page prefix", { expected: pinnedEnd, actual: header.bootstrapBytes });
    }
    return pages;
}

function validateRecordReferences(
    groups: readonly MeshLoDGroup[],
    clusters: readonly MeshLoDCluster[],
    refs: Uint32Array,
    pages: readonly MeshLoDPageRecord[],
    groupOffset: number,
    clusterOffset: number
): void {
    for (let g = 0; g < groups.length; g++) {
        const group = groups[g]!;
        if (group.firstPageRef + group.pageRefCount > refs.length) {
            throw fail("MLOD_INVALID_HIERARCHY", "group page refs are out of range", { byteOffset: groupOffset + g * GROUP_RECORD_SIZE + GR.firstPageRef });
        }
    }
    for (let c = 0; c < clusters.length; c++) {
        const cluster = clusters[c]!;
        const page = pages[cluster.pageId]!;
        const base = clusterOffset + c * CLUSTER_RECORD_SIZE;
        if (c < page.firstCluster || c >= page.firstCluster + page.clusterCount) {
            throw fail("MLOD_INVALID_HIERARCHY", "cluster is not in its owning page range", { byteOffset: base + CR.pageId });
        }
        if (cluster.vertexOffset + cluster.vertexCount > page.vertexCount) {
            throw fail("MLOD_INVALID_HIERARCHY", "cluster vertices exceed their page", { byteOffset: base + CR.firstVertex });
        }
        if (cluster.indexOffset + cluster.triangleCount * 3 > page.localIndexCount) {
            throw fail("MLOD_INVALID_HIERARCHY", "cluster local indices exceed their page", { byteOffset: base + CR.firstLocalIndex });
        }
    }
}

function requireSection(entry: MeshLoDSectionEntry, count: number, stride: number, name: string): void {
    if (entry.elementCount !== count || entry.elementStride !== stride || entry.storedBytes !== count * stride) {
        throw fail("MLOD_INVALID_LAYOUT", `${name} section counts disagree with the header`, { sectionType: entry.type });
    }
}

// ─── Header-level cross checks ───────────────────────────────────────

function validateHeaderInvariants(header: MeshLoDHeader): void {
    if ((header.attributeMask & (ATTR_POSITION | ATTR_NORMAL)) !== (ATTR_POSITION | ATTR_NORMAL)) {
        throw fail("MLOD_INVALID_LAYOUT", "attribute mask is missing position or normal");
    }
    if (header.vertexStride !== DECODED_VERTEX_STRIDE) {
        throw fail("MLOD_INVALID_LAYOUT", "unexpected decoded vertex stride", { expected: DECODED_VERTEX_STRIDE, actual: header.vertexStride });
    }
    if (header.pinnedPageCount > header.pageCount) {
        throw fail("MLOD_INVALID_LAYOUT", "pinned page count exceeds the page count");
    }
    for (const value of [...header.boundsMin, ...header.boundsMax, header.maxNonterminalError]) {
        if (!Number.isFinite(value)) {
            throw fail("MLOD_INVALID_HIERARCHY", "header bounds or error is not finite");
        }
    }
}

// ─── Public entry point ──────────────────────────────────────────────

/** Peek the header of a bootstrap chunk (the first read) to learn how many bytes
 *  the coarse bootstrap region and the full file occupy. Validates only the
 *  header (magic, version, endian, size, CRC); the caller fetches the remaining
 *  bootstrap bytes before a full {@link parseMeshLoDContainer}. */
export function readBootstrapExtent(bytes: Uint8Array): { totalFileBytes: number; bootstrapBytes: number } {
    const header = decodeHeader(new Reader(bytes));
    return { totalFileBytes: header.totalFileBytes, bootstrapBytes: header.bootstrapBytes };
}

/** Parse and validate a `.mlod` container. Accepts either a complete file
 *  (`bytes.length === totalFileBytes`) or a coarse bootstrap region
 *  (`bytes.length === bootstrapBytes`): metadata, references, the full page-table
 *  structure, and pinned pages are always validated; fine-page CRC and framing are
 *  validated only for pages present in `bytes`. Throws a stable
 *  {@link MeshLoDError} on any malformed, corrupt, truncated, or
 *  version-incompatible input. */
export function parseMeshLoDContainer(bytes: Uint8Array): ParsedMeshLoDContainer {
    const reader = new Reader(bytes);
    const header = parseHeader(reader);
    validateHeaderInvariants(header);
    const sections = parseDirectory(reader, header);
    const provenance = parseProvenance(reader, sections[SECTION_PROVENANCE_JSON - 1]!);
    const groups = parseGroups(reader, sections[SECTION_GROUPS - 1]!, header);
    const clusters = parseClusters(reader, sections[SECTION_CLUSTERS - 1]!, header);
    const hierarchyNodes = parseNodes(reader, sections[SECTION_HIERARCHY_NODES - 1]!, header);
    const groupPageRefs = parseGroupPageRefs(reader, sections[SECTION_GROUP_PAGE_REFS - 1]!, header);
    const pageRecords = parsePages(reader, sections[SECTION_PAGE_TABLE - 1]!, sections[SECTION_PAGE_DATA - 1]!, header);
    validateRecordReferences(groups, clusters, groupPageRefs, pageRecords, sections[SECTION_GROUPS - 1]!.offset, sections[SECTION_CLUSTERS - 1]!.offset);
    return { header, sections, provenance, groups, clusters, hierarchyNodes, pageRecords, groupPageRefs };
}

/** Build the public {@link MeshLoDMetadata} view from a parsed container. */
export function toMeshLoDMetadata(parsed: ParsedMeshLoDContainer): MeshLoDMetadata {
    const { header, provenance } = parsed;
    return {
        formatMajor: header.formatMajor,
        formatMinor: header.formatMinor,
        toolVersion: provenance.toolVersion,
        meshoptimizerRevision: provenance.meshoptimizerRevision,
        cgltfRevision: provenance.cgltfRevision,
        sourceSha256: header.sourceSha256,
        buildFingerprintSha256: header.buildFingerprintSha256,
        meshIndex: header.meshIndex,
        primitiveIndex: header.primitiveIndex,
        sourceTriangleCount: header.sourceTriangleCount,
        hierarchyTriangleCount: header.hierarchyTriangleCount,
        clusterCount: header.clusterCount,
        groupCount: header.groupCount,
        hierarchyNodeCount: header.hierarchyNodeCount,
        hierarchyDepth: header.levelCount,
        pageCount: header.pageCount,
        pinnedPageCount: header.pinnedPageCount,
        boundsMin: header.boundsMin,
        boundsMax: header.boundsMax,
    };
}
