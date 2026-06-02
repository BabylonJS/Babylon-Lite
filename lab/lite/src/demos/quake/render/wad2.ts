// Minimal clean-room WAD2 reader for Quake's `gfx.wad`.
//
// WAD2 layout (little-endian):
//   header: char magic[4] = "WAD2", int32 numLumps, int32 dirOffset
//   directory: numLumps entries of 32 bytes each:
//     int32 filepos, int32 disksize, int32 size,
//     uint8 type, uint8 compression, uint8 pad[2], char name[16]
//
// HUD graphics are TYP_QPIC (type 66): int32 width, int32 height, then
// width*height palette indices (1 byte each).

export const TYP_QPIC = 66;

export interface Wad2Lump {
    type: number;
    data: Uint8Array;
}

export type Wad2 = Map<string, Wad2Lump>;

export interface Qpic {
    width: number;
    height: number;
    indices: Uint8Array;
}

export function parseWad2(buffer: ArrayBuffer | Uint8Array): Wad2 {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const magic = String.fromCharCode(u8[0]!, u8[1]!, u8[2]!, u8[3]!);
    if (magic !== "WAD2") throw new Error(`not a WAD2 archive: "${magic}"`);

    const numLumps = view.getInt32(4, true);
    const dirOffset = view.getInt32(8, true);
    const map: Wad2 = new Map();

    for (let i = 0; i < numLumps; i++) {
        const o = dirOffset + i * 32;
        const filepos = view.getInt32(o, true);
        const disksize = view.getInt32(o + 4, true);
        const type = u8[o + 12]!;
        let name = "";
        for (let j = 0; j < 16; j++) {
            const c = u8[o + 16 + j];
            if (!c) break;
            name += String.fromCharCode(c);
        }
        map.set(name.toUpperCase(), { type, data: u8.subarray(filepos, filepos + disksize) });
    }

    return map;
}

/** Read a TYP_QPIC lump (width/height header + indexed pixels). */
export function readQpic(lump: Wad2Lump): Qpic {
    const d = lump.data;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const width = dv.getInt32(0, true);
    const height = dv.getInt32(4, true);
    return { width, height, indices: d.subarray(8, 8 + width * height) };
}
