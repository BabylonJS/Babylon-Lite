// Clean-room DOOM map-lump parsing for the demo.
//
// Implemented from public Doom map-format documentation (Doom Wiki / Unofficial
// Doom Specs). No GPL Doom source is used or copied.
//
// A map is a marker lump (e.g. "E1M1") followed by a fixed sequence of data
// lumps: THINGS, LINEDEFS, SIDEDEFS, VERTEXES, SEGS, SSECTORS, NODES, SECTORS,
// REJECT, BLOCKMAP. We parse the subset needed to build geometry and spawn.

import type { Wad } from "./wad-file.js";
import { findLumpIndex, getLump, tryGetLump } from "./wad-file.js";

export interface Vertex {
    x: number;
    y: number;
}

export interface Linedef {
    start: number;
    end: number;
    flags: number;
    special: number;
    tag: number;
    /** Sidedef indices, or -1 when absent. */
    front: number;
    back: number;
}

export interface Sidedef {
    xOffset: number;
    yOffset: number;
    upper: string;
    lower: string;
    middle: string;
    sector: number;
}

export interface Sector {
    floorHeight: number;
    ceilHeight: number;
    floorTex: string;
    ceilTex: string;
    light: number;
    special: number;
    tag: number;
}

export interface Seg {
    start: number;
    end: number;
    angle: number;
    linedef: number;
    /** 0 = along linedef front side, 1 = back side. */
    side: number;
    offset: number;
}

export interface Subsector {
    segCount: number;
    firstSeg: number;
}

export interface Node {
    x: number;
    y: number;
    dx: number;
    dy: number;
    /** Right/left child bounding boxes [top, bottom, left, right]. */
    rightBox: [number, number, number, number];
    leftBox: [number, number, number, number];
    /** Child references; high bit (0x8000) set means subsector index. */
    rightChild: number;
    leftChild: number;
}

export interface Thing {
    x: number;
    y: number;
    angle: number;
    type: number;
    flags: number;
}

export interface DoomMap {
    name: string;
    vertices: Vertex[];
    linedefs: Linedef[];
    sidedefs: Sidedef[];
    sectors: Sector[];
    segs: Seg[];
    subsectors: Subsector[];
    nodes: Node[];
    things: Thing[];
}

/** Child reference flag marking a subsector (vs another node). */
export const NF_SUBSECTOR = 0x8000;

function name8(data: Uint8Array, offset: number): string {
    let s = "";
    for (let i = 0; i < 8 && data[offset + i] !== 0; i++) {
        s += String.fromCharCode(data[offset + i]!);
    }
    return s.toUpperCase();
}

function eachRecord(data: Uint8Array, recordSize: number): DataView[] {
    const count = Math.floor(data.length / recordSize);
    const out: DataView[] = new Array(count);
    for (let i = 0; i < count; i++) {
        out[i] = new DataView(data.buffer, data.byteOffset + i * recordSize, recordSize);
    }
    return out;
}

export function isMapMarker(wad: Wad, name: string): boolean {
    const idx = findLumpIndex(wad, name);
    if (idx < 0) return false;
    // A map marker is a zero-length lump followed by THINGS.
    const next = wad.lumps[idx + 1];
    return !!next && next.name === "THINGS";
}

export function parseMap(wad: Wad, mapName: string): DoomMap {
    const markerIdx = findLumpIndex(wad, mapName);
    if (markerIdx < 0) throw new Error(`Map ${mapName} not found`);

    // Map sub-lumps follow the marker in a known order; find each by name after it.
    const sub = (lumpName: string): Uint8Array => {
        for (let i = markerIdx + 1; i < wad.lumps.length && i <= markerIdx + 11; i++) {
            if (wad.lumps[i]!.name === lumpName) return getLump(wad, i);
        }
        const fallback = tryGetLump(wad, lumpName);
        if (fallback) return fallback;
        throw new Error(`Map ${mapName}: missing ${lumpName}`);
    };

    const vertices: Vertex[] = eachRecord(sub("VERTEXES"), 4).map((v) => ({
        x: v.getInt16(0, true),
        y: v.getInt16(2, true),
    }));

    const linedefs: Linedef[] = eachRecord(sub("LINEDEFS"), 14).map((v) => ({
        start: v.getUint16(0, true),
        end: v.getUint16(2, true),
        flags: v.getUint16(4, true),
        special: v.getUint16(6, true),
        tag: v.getUint16(8, true),
        front: toSideRef(v.getUint16(10, true)),
        back: toSideRef(v.getUint16(12, true)),
    }));

    const sideData = sub("SIDEDEFS");
    const sidedefs: Sidedef[] = eachRecord(sideData, 30).map((v, i) => {
        const base = i * 30;
        return {
            xOffset: v.getInt16(0, true),
            yOffset: v.getInt16(2, true),
            upper: name8(sideData, base + 4),
            lower: name8(sideData, base + 12),
            middle: name8(sideData, base + 20),
            sector: v.getUint16(28, true),
        };
    });

    const sectorData = sub("SECTORS");
    const sectors: Sector[] = eachRecord(sectorData, 26).map((v, i) => {
        const base = i * 26;
        return {
            floorHeight: v.getInt16(0, true),
            ceilHeight: v.getInt16(2, true),
            floorTex: name8(sectorData, base + 4),
            ceilTex: name8(sectorData, base + 12),
            light: v.getInt16(20, true),
            special: v.getInt16(22, true),
            tag: v.getInt16(24, true),
        };
    });

    const segs: Seg[] = eachRecord(sub("SEGS"), 12).map((v) => ({
        start: v.getUint16(0, true),
        end: v.getUint16(2, true),
        angle: v.getInt16(4, true),
        linedef: v.getUint16(6, true),
        side: v.getUint16(8, true),
        offset: v.getInt16(10, true),
    }));

    const subsectors: Subsector[] = eachRecord(sub("SSECTORS"), 4).map((v) => ({
        segCount: v.getUint16(0, true),
        firstSeg: v.getUint16(2, true),
    }));

    const nodes: Node[] = eachRecord(sub("NODES"), 28).map((v) => ({
        x: v.getInt16(0, true),
        y: v.getInt16(2, true),
        dx: v.getInt16(4, true),
        dy: v.getInt16(6, true),
        rightBox: [v.getInt16(8, true), v.getInt16(10, true), v.getInt16(12, true), v.getInt16(14, true)],
        leftBox: [v.getInt16(16, true), v.getInt16(18, true), v.getInt16(20, true), v.getInt16(22, true)],
        rightChild: v.getUint16(24, true),
        leftChild: v.getUint16(26, true),
    }));

    const things: Thing[] = eachRecord(sub("THINGS"), 10).map((v) => ({
        x: v.getInt16(0, true),
        y: v.getInt16(2, true),
        angle: v.getInt16(4, true),
        type: v.getUint16(6, true),
        flags: v.getUint16(8, true),
    }));

    return { name: mapName, vertices, linedefs, sidedefs, sectors, segs, subsectors, nodes, things };
}

function toSideRef(raw: number): number {
    // 0xFFFF marks "no sidedef".
    return raw === 0xffff ? -1 : raw;
}
