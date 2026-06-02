// Clean-room graphics decoding (patches, flats, composite textures) for the DOOM demo.
//
// Implemented from public Doom file-format documentation; no GPL source is used.
//
// Patch ("picture") format — used by wall patches, sprites and UI graphics:
//   header: int16 width, height, leftOffset, topOffset
//   then `width` int32 column offsets (from start of lump)
//   each column is a list of posts terminated by topdelta == 0xFF:
//     byte topdelta, byte length, byte (unused), length × index byte, byte (unused)
//   Texels not covered by any post are transparent.
//
// Flat: raw 64×64 palette indices (4096 bytes), fully opaque.
//
// Composite wall texture: PNAMES (patch-name table) + TEXTURE1/TEXTURE2 lumps
// describe textures assembled by pasting patches at offsets.

import type { Wad } from "./wad-file.js";
import { findLumpIndex, getLump, tryGetLump } from "./wad-file.js";

/** A palette-indexed image. `opaque[i]` is 1 for covered texels, 0 for transparent. */
export interface IndexedImage {
    readonly width: number;
    readonly height: number;
    /** width*height palette indices. */
    readonly indices: Uint8Array;
    /** width*height coverage mask (1 = opaque, 0 = transparent). */
    readonly opaque: Uint8Array;
    readonly leftOffset: number;
    readonly topOffset: number;
}

const FLAT_SIZE = 64;

export function decodeFlat(data: Uint8Array): IndexedImage {
    if (data.length < FLAT_SIZE * FLAT_SIZE) {
        throw new Error(`Flat too small: ${data.length} bytes`);
    }
    const indices = data.slice(0, FLAT_SIZE * FLAT_SIZE);
    const opaque = new Uint8Array(FLAT_SIZE * FLAT_SIZE).fill(1);
    return { width: FLAT_SIZE, height: FLAT_SIZE, indices, opaque, leftOffset: 0, topOffset: 0 };
}

export function decodePatch(data: Uint8Array): IndexedImage {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const width = view.getInt16(0, true);
    const height = view.getInt16(2, true);
    const leftOffset = view.getInt16(4, true);
    const topOffset = view.getInt16(6, true);
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
        throw new Error(`Bad patch dimensions ${width}x${height}`);
    }

    const indices = new Uint8Array(width * height);
    const opaque = new Uint8Array(width * height);

    for (let x = 0; x < width; x++) {
        let colOffset = view.getUint32(8 + x * 4, true);
        // Each column: posts until topdelta byte == 0xFF.
        for (;;) {
            const topDelta = data[colOffset++]!;
            if (topDelta === 0xff) break;
            const length = data[colOffset++]!;
            colOffset++; // unused padding byte before the run
            for (let row = 0; row < length; row++) {
                const y = topDelta + row;
                if (y >= 0 && y < height) {
                    const di = y * width + x;
                    indices[di] = data[colOffset]!;
                    opaque[di] = 1;
                }
                colOffset++;
            }
            colOffset++; // unused padding byte after the run
        }
    }

    return { width, height, indices, opaque, leftOffset, topOffset };
}

/** Reads the PNAMES patch-name table → array of upper-case lump names. */
export function parsePnames(wad: Wad): string[] {
    const data = getLump(wad, "PNAMES");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getInt32(0, true);
    const names: string[] = new Array(count);
    let p = 4;
    for (let i = 0; i < count; i++) {
        let end = p;
        const limit = p + 8;
        while (end < limit && data[end] !== 0) end++;
        let s = "";
        for (let j = p; j < end; j++) s += String.fromCharCode(data[j]!);
        names[i] = s.toUpperCase();
        p += 8;
    }
    return names;
}

export interface TextureDef {
    readonly name: string;
    readonly width: number;
    readonly height: number;
    readonly patches: { originX: number; originY: number; patch: number }[];
}

/** Parses TEXTURE1/TEXTURE2 into texture definitions referencing PNAMES indices. */
export function parseTextureLump(wad: Wad, lumpName: string): TextureDef[] {
    const data = tryGetLump(wad, lumpName);
    if (!data) return [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const numTextures = view.getInt32(0, true);
    const defs: TextureDef[] = [];
    for (let t = 0; t < numTextures; t++) {
        const off = view.getInt32(4 + t * 4, true);
        let p = off;
        let name = "";
        for (let j = 0; j < 8 && data[p + j] !== 0; j++) name += String.fromCharCode(data[p + j]!);
        name = name.toUpperCase();
        p += 8;
        p += 4; // masked (unused)
        const width = view.getInt16(p, true);
        const height = view.getInt16(p + 2, true);
        p += 4;
        p += 4; // columndirectory (obsolete/unused)
        const patchCount = view.getInt16(p, true);
        p += 2;
        const patches: { originX: number; originY: number; patch: number }[] = [];
        for (let i = 0; i < patchCount; i++) {
            const originX = view.getInt16(p, true);
            const originY = view.getInt16(p + 2, true);
            const patch = view.getInt16(p + 4, true);
            p += 10; // originx, originy, patch, stepdir, colormap (int16 each)
            patches.push({ originX, originY, patch });
        }
        defs.push({ name, width, height, patches });
    }
    return defs;
}

/** Composites a wall texture by pasting its patches onto a blank indexed canvas. */
export function buildCompositeTexture(wad: Wad, def: TextureDef, pnames: string[]): IndexedImage {
    const { width, height } = def;
    const indices = new Uint8Array(width * height);
    const opaque = new Uint8Array(width * height);

    for (const part of def.patches) {
        const patchName = pnames[part.patch];
        if (!patchName) continue;
        const lumpData = tryGetLump(wad, patchName);
        if (!lumpData) continue;
        const patch = decodePatch(lumpData);
        blit(patch, indices, opaque, width, height, part.originX, part.originY);
    }

    return { width, height, indices, opaque, leftOffset: 0, topOffset: 0 };
}

function blit(src: IndexedImage, dstIndices: Uint8Array, dstOpaque: Uint8Array, dstW: number, dstH: number, ox: number, oy: number): void {
    for (let y = 0; y < src.height; y++) {
        const dy = oy + y;
        if (dy < 0 || dy >= dstH) continue;
        for (let x = 0; x < src.width; x++) {
            const si = y * src.width + x;
            if (!src.opaque[si]) continue;
            const dx = ox + x;
            if (dx < 0 || dx >= dstW) continue;
            const di = dy * dstW + dx;
            dstIndices[di] = src.indices[si]!;
            dstOpaque[di] = 1;
        }
    }
}

/**
 * Packs an indexed image into RGBA bytes for the indexed+colormap shader path:
 * R = palette index, A = 255 (opaque) / 0 (transparent). G/B are unused.
 * The fragment shader reads R as the palette index and samples the colormap LUT.
 */
export function indexedToIndexRgba(img: IndexedImage): Uint8Array {
    const n = img.width * img.height;
    const rgba = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        rgba[i * 4] = img.indices[i]!;
        rgba[i * 4 + 3] = img.opaque[i]! ? 255 : 0;
    }
    return rgba;
}

/** True if a lump exists in the WAD (helper for resolving flats by name). */
export function lumpExists(wad: Wad, name: string): boolean {
    return findLumpIndex(wad, name) >= 0;
}
