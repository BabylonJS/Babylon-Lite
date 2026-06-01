// Clean-room parser for the Quake 1 BSP format (version 29), reimplemented from
// the publicly documented format spec (Olivier Montanuy's Unofficial Quake
// Specs §4 and id Software's bspfile.h struct layouts). Reads only the 15
// canonical lumps; any BSPX extension data appended after them is ignored.

const BSP_VERSION = 29;
const HEADER_LUMPS = 15;

// Lump indices.
export const LUMP_ENTITIES = 0;
export const LUMP_PLANES = 1;
export const LUMP_TEXTURES = 2;
export const LUMP_VERTEXES = 3;
export const LUMP_NODES = 5;
export const LUMP_TEXINFO = 6;
export const LUMP_FACES = 7;
export const LUMP_LIGHTING = 8;
export const LUMP_LEAFS = 10;
export const LUMP_MARKSURFACES = 11;
export const LUMP_EDGES = 12;
export const LUMP_SURFEDGES = 13;
export const LUMP_MODELS = 14;
export const LUMP_CLIPNODES = 9;

/** TEX_SPECIAL flag (sky / liquid surfaces — no lightmap). */
export const TEX_SPECIAL = 1;

export interface BspFace {
    planeNum: number;
    side: number;
    firstEdge: number;
    numEdges: number;
    texInfo: number;
    styles: [number, number, number, number];
    lightOfs: number; // byte offset into lighting lump, or -1
}

export interface BspTexInfo {
    /** [sx, sy, sz, sOffset, tx, ty, tz, tOffset]. */
    vecs: Float32Array;
    miptex: number;
    flags: number;
}

export interface BspMipTex {
    name: string;
    width: number;
    height: number;
    /** Decoded level-0 palette indices (width*height), or null if not embedded. */
    indices: Uint8Array | null;
}

export interface BspModel {
    mins: [number, number, number];
    maxs: [number, number, number];
    origin: [number, number, number];
    /** Clipnode hull roots: [0]=BSP node root, [1..3]=collision hull roots. */
    headNode: [number, number, number, number];
    firstFace: number;
    numFaces: number;
}

/** Quake plane: normal·p = planeDist. (Field intentionally NOT named `dist`: the
 *  demo bundler's WGSL identifier-mangle pass rewrites the token `dist`→`dst`,
 *  which would corrupt every `.dist` property access in the bundled JS.) */
export interface BspPlane {
    normal: [number, number, number];
    planeDist: number;
    type: number;
}

/**
 * Collision clipnodes (pre-expanded BSP hulls). children >= 0 index another
 * clipnode; children < 0 are CONTENTS_* leaf values (CONTENTS_SOLID = -2).
 */
export interface BspClipNodes {
    planeNum: Int32Array;
    child0: Int16Array;
    child1: Int16Array;
}

/**
 * Rendering BSP tree (hull 0, point hull). Used for exact point/line traces such
 * as monster line-of-sight, where the expanded player clip hulls would be wrong.
 * A child >= 0 indexes another node; a child < 0 references leaf `-(child) - 1`,
 * whose CONTENTS_* value lives in `leafContents`.
 */
export interface BspNodes {
    planeNum: Int32Array;
    child0: Int32Array;
    child1: Int32Array;
    leafContents: Int32Array;
}

export interface BspData {
    vertices: Float32Array; // n*3 (Quake coords: x fwd, y left, z up)
    edges: Int32Array; // n*2 vertex indices
    surfEdges: Int32Array; // n signed edge refs
    faces: BspFace[];
    texInfos: BspTexInfo[];
    mipTextures: BspMipTex[];
    lighting: Uint8Array; // grayscale lightmap samples
    models: BspModel[];
    planes: BspPlane[];
    clipNodes: BspClipNodes;
    nodes: BspNodes;
    entities: string;
}

interface Lump {
    ofs: number;
    len: number;
}

function readLumps(view: DataView): Lump[] {
    const lumps: Lump[] = [];
    for (let i = 0; i < HEADER_LUMPS; i++) {
        const o = 4 + i * 8;
        lumps.push({ ofs: view.getInt32(o, true), len: view.getInt32(o + 4, true) });
    }
    return lumps;
}

function parseVertices(buf: ArrayBuffer, lump: Lump): Float32Array {
    const count = (lump.len / 12) | 0;
    const out = new Float32Array(count * 3);
    const dv = new DataView(buf, lump.ofs, count * 12);
    for (let i = 0; i < count * 3; i++) out[i] = dv.getFloat32(i * 4, true);
    return out;
}

function parseEdges(buf: ArrayBuffer, lump: Lump): Int32Array {
    const count = (lump.len / 4) | 0;
    const out = new Int32Array(count * 2);
    const dv = new DataView(buf, lump.ofs, count * 4);
    for (let i = 0; i < count; i++) {
        out[i * 2] = dv.getUint16(i * 4, true);
        out[i * 2 + 1] = dv.getUint16(i * 4 + 2, true);
    }
    return out;
}

function parseSurfEdges(buf: ArrayBuffer, lump: Lump): Int32Array {
    const count = (lump.len / 4) | 0;
    const out = new Int32Array(count);
    const dv = new DataView(buf, lump.ofs, count * 4);
    for (let i = 0; i < count; i++) out[i] = dv.getInt32(i * 4, true);
    return out;
}

function parseFaces(buf: ArrayBuffer, lump: Lump): BspFace[] {
    const SIZE = 20;
    const count = (lump.len / SIZE) | 0;
    const dv = new DataView(buf, lump.ofs, count * SIZE);
    const faces: BspFace[] = [];
    for (let i = 0; i < count; i++) {
        const o = i * SIZE;
        faces.push({
            planeNum: dv.getUint16(o, true),
            side: dv.getUint16(o + 2, true),
            firstEdge: dv.getInt32(o + 4, true),
            numEdges: dv.getUint16(o + 8, true),
            texInfo: dv.getUint16(o + 10, true),
            styles: [dv.getUint8(o + 12), dv.getUint8(o + 13), dv.getUint8(o + 14), dv.getUint8(o + 15)],
            lightOfs: dv.getInt32(o + 16, true),
        });
    }
    return faces;
}

function parseTexInfo(buf: ArrayBuffer, lump: Lump): BspTexInfo[] {
    const SIZE = 40;
    const count = (lump.len / SIZE) | 0;
    const dv = new DataView(buf, lump.ofs, count * SIZE);
    const out: BspTexInfo[] = [];
    for (let i = 0; i < count; i++) {
        const o = i * SIZE;
        const vecs = new Float32Array(8);
        for (let j = 0; j < 8; j++) vecs[j] = dv.getFloat32(o + j * 4, true);
        out.push({ vecs, miptex: dv.getInt32(o + 32, true), flags: dv.getInt32(o + 36, true) });
    }
    return out;
}

function parseModels(buf: ArrayBuffer, lump: Lump): BspModel[] {
    const SIZE = 64;
    const count = (lump.len / SIZE) | 0;
    const dv = new DataView(buf, lump.ofs, count * SIZE);
    const out: BspModel[] = [];
    for (let i = 0; i < count; i++) {
        const o = i * SIZE;
        out.push({
            mins: [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)],
            maxs: [dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true)],
            origin: [dv.getFloat32(o + 24, true), dv.getFloat32(o + 28, true), dv.getFloat32(o + 32, true)],
            // headnode[4] at o+36..o+51, visleafs at o+52
            headNode: [dv.getInt32(o + 36, true), dv.getInt32(o + 40, true), dv.getInt32(o + 44, true), dv.getInt32(o + 48, true)],
            firstFace: dv.getInt32(o + 56, true),
            numFaces: dv.getInt32(o + 60, true),
        });
    }
    return out;
}

function parsePlanes(buf: ArrayBuffer, lump: Lump): BspPlane[] {
    const SIZE = 20;
    const count = (lump.len / SIZE) | 0;
    const dv = new DataView(buf, lump.ofs, count * SIZE);
    const out: BspPlane[] = [];
    for (let i = 0; i < count; i++) {
        const o = i * SIZE;
        out.push({
            normal: [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)],
            planeDist: dv.getFloat32(o + 12, true),
            type: dv.getInt32(o + 16, true),
        });
    }
    return out;
}

function parseClipNodes(buf: ArrayBuffer, lump: Lump): BspClipNodes {
    const SIZE = 8;
    const count = (lump.len / SIZE) | 0;
    const dv = new DataView(buf, lump.ofs, count * SIZE);
    const planeNum = new Int32Array(count);
    const child0 = new Int16Array(count);
    const child1 = new Int16Array(count);
    for (let i = 0; i < count; i++) {
        const o = i * SIZE;
        planeNum[i] = dv.getInt32(o, true);
        child0[i] = dv.getInt16(o + 4, true);
        child1[i] = dv.getInt16(o + 6, true);
    }
    return { planeNum, child0, child1 };
}

/**
 * Parse the rendering BSP nodes (hull 0) plus leaf CONTENTS. Node children are
 * 16-bit: >= 0 index another node; < 0 reference leaf `-(child) - 1`. We widen
 * them to leaf-encoded Int32 children (>= 0 node, < 0 leaf-encoded) so the
 * point-trace recursion can branch uniformly.
 */
function parseNodes(buf: ArrayBuffer, nodeLump: Lump, leafLump: Lump): BspNodes {
    const NODE_SIZE = 24;
    const LEAF_SIZE = 28;
    const nodeCount = (nodeLump.len / NODE_SIZE) | 0;
    const ndv = new DataView(buf, nodeLump.ofs, nodeCount * NODE_SIZE);
    const planeNum = new Int32Array(nodeCount);
    const child0 = new Int32Array(nodeCount);
    const child1 = new Int32Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
        const o = i * NODE_SIZE;
        planeNum[i] = ndv.getInt32(o, true);
        child0[i] = ndv.getInt16(o + 4, true);
        child1[i] = ndv.getInt16(o + 6, true);
    }
    const leafCount = (leafLump.len / LEAF_SIZE) | 0;
    const ldv = new DataView(buf, leafLump.ofs, leafCount * LEAF_SIZE);
    const leafContents = new Int32Array(leafCount);
    for (let i = 0; i < leafCount; i++) leafContents[i] = ldv.getInt32(i * LEAF_SIZE, true);
    return { planeNum, child0, child1, leafContents };
}

function parseTextures(buf: ArrayBuffer, lump: Lump): BspMipTex[] {
    if (lump.len < 4) return [];
    const base = lump.ofs;
    const header = new DataView(buf, base, lump.len);
    const numMip = header.getInt32(0, true);
    const out: BspMipTex[] = [];
    for (let i = 0; i < numMip; i++) {
        const dataOfs = header.getInt32(4 + i * 4, true);
        if (dataOfs < 0) {
            out.push({ name: "", width: 0, height: 0, indices: null });
            continue;
        }
        const mo = base + dataOfs;
        const mip = new DataView(buf, mo, Math.min(40, lump.len - dataOfs));
        let name = "";
        for (let c = 0; c < 16; c++) {
            const ch = mip.getUint8(c);
            if (ch === 0) break;
            name += String.fromCharCode(ch);
        }
        const width = mip.getUint32(16, true);
        const height = mip.getUint32(20, true);
        const pixOfs = mip.getUint32(24, true); // offsets[0] = full-res, relative to miptex start
        let indices: Uint8Array | null = null;
        if (pixOfs > 0 && width > 0 && height > 0) {
            const start = mo + pixOfs;
            if (start + width * height <= buf.byteLength) {
                indices = new Uint8Array(buf, start, width * height).slice();
            }
        }
        out.push({ name, width, height, indices });
    }
    return out;
}

function parseEntities(buf: ArrayBuffer, lump: Lump): string {
    const bytes = new Uint8Array(buf, lump.ofs, lump.len);
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i]!;
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

/** Parse a Quake BSP v29 file into typed structures. */
export function parseBsp(buffer: ArrayBuffer): BspData {
    const view = new DataView(buffer);
    const version = view.getInt32(0, true);
    if (version !== BSP_VERSION) {
        throw new Error(`Unsupported BSP version ${version} (expected ${BSP_VERSION})`);
    }
    const lumps = readLumps(view);
    const lightingLump = lumps[LUMP_LIGHTING]!;
    const lighting = new Uint8Array(buffer, lightingLump.ofs, lightingLump.len).slice();
    return {
        vertices: parseVertices(buffer, lumps[LUMP_VERTEXES]!),
        edges: parseEdges(buffer, lumps[LUMP_EDGES]!),
        surfEdges: parseSurfEdges(buffer, lumps[LUMP_SURFEDGES]!),
        faces: parseFaces(buffer, lumps[LUMP_FACES]!),
        texInfos: parseTexInfo(buffer, lumps[LUMP_TEXINFO]!),
        mipTextures: parseTextures(buffer, lumps[LUMP_TEXTURES]!),
        lighting,
        models: parseModels(buffer, lumps[LUMP_MODELS]!),
        planes: parsePlanes(buffer, lumps[LUMP_PLANES]!),
        clipNodes: parseClipNodes(buffer, lumps[LUMP_CLIPNODES]!),
        nodes: parseNodes(buffer, lumps[LUMP_NODES]!, lumps[LUMP_LEAFS]!),
        entities: parseEntities(buffer, lumps[LUMP_ENTITIES]!),
    };
}
