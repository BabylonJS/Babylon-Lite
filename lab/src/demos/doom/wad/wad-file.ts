// Clean-room WAD reader for the DOOM demo.
//
// Implemented from publicly documented file-format facts (Doom Wiki / the
// "Unofficial Doom Specs"). No GPL Doom engine source is used or copied.
//
// A WAD is a 12-byte header followed by lump data and a directory:
//   header:  char id[4] ("IWAD" | "PWAD"), int32 numLumps, int32 dirOffset
//   dir:     numLumps × 16-byte entries { int32 filePos, int32 size, char name[8] }
// Lump names are ASCII, NUL-padded to 8 bytes, conventionally upper-case.

export type WadType = "IWAD" | "PWAD";

export interface WadLump {
    readonly name: string;
    readonly offset: number;
    readonly size: number;
    /** Directory index, useful for ordered/namespace lookups. */
    readonly index: number;
}

export interface Wad {
    readonly type: WadType;
    readonly lumps: readonly WadLump[];
    /** Name → last directory index with that name (later lumps win, as in vanilla). */
    readonly byName: ReadonlyMap<string, number>;
    readonly bytes: Uint8Array;
    readonly view: DataView;
}

function readName(bytes: Uint8Array, offset: number): string {
    let end = offset;
    const limit = offset + 8;
    while (end < limit && bytes[end] !== 0) end++;
    let s = "";
    for (let i = offset; i < end; i++) s += String.fromCharCode(bytes[i]!);
    return s.toUpperCase();
}

export function parseWad(buffer: ArrayBuffer | Uint8Array): Wad {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const id = readName(bytes, 0).slice(0, 4);
    if (id !== "IWAD" && id !== "PWAD") {
        throw new Error(`Not a WAD file (magic="${id}")`);
    }
    const numLumps = view.getInt32(4, true);
    const dirOffset = view.getInt32(8, true);
    if (numLumps < 0 || dirOffset < 0 || dirOffset + numLumps * 16 > bytes.length) {
        throw new Error("WAD directory out of bounds");
    }

    const lumps: WadLump[] = new Array(numLumps);
    const byName = new Map<string, number>();
    let p = dirOffset;
    for (let i = 0; i < numLumps; i++) {
        const filePos = view.getInt32(p, true);
        const size = view.getInt32(p + 4, true);
        const name = readName(bytes, p + 8);
        lumps[i] = { name, offset: filePos, size, index: i };
        byName.set(name, i);
        p += 16;
    }

    return { type: id, lumps, byName, bytes, view };
}

/** Returns the directory index of `name`, or -1. Search starts at `from` (inclusive). */
export function findLumpIndex(wad: Wad, name: string, from = 0): number {
    const upper = name.toUpperCase();
    if (from === 0) {
        const idx = wad.byName.get(upper);
        return idx === undefined ? -1 : idx;
    }
    for (let i = from; i < wad.lumps.length; i++) {
        if (wad.lumps[i]!.name === upper) return i;
    }
    return -1;
}

export function hasLump(wad: Wad, name: string): boolean {
    return wad.byName.has(name.toUpperCase());
}

/** Returns a view (no copy) over a lump's bytes by index or name. Throws if missing. */
export function getLump(wad: Wad, ref: string | number): Uint8Array {
    const index = typeof ref === "number" ? ref : findLumpIndex(wad, ref);
    if (index < 0 || index >= wad.lumps.length) {
        throw new Error(`Lump not found: ${ref}`);
    }
    const { offset, size } = wad.lumps[index]!;
    return wad.bytes.subarray(offset, offset + size);
}

export function tryGetLump(wad: Wad, ref: string | number): Uint8Array | undefined {
    const index = typeof ref === "number" ? ref : findLumpIndex(wad, ref);
    if (index < 0 || index >= wad.lumps.length) return undefined;
    const { offset, size } = wad.lumps[index]!;
    return wad.bytes.subarray(offset, offset + size);
}
