// Quake palette: gfx/palette.lmp is 256 RGB triplets (768 bytes), no header.
// Index 255 is the conventional transparency index for sky / fence textures.

export type Palette = Uint8Array; // 768 bytes

export function parsePalette(bytes: ArrayBuffer | Uint8Array): Palette {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.length < 768) throw new Error(`palette.lmp too short: ${u8.length} bytes (expected 768)`);
    return u8.slice(0, 768);
}

/**
 * Decode an array of palette indices into tightly-packed RGBA8 bytes.
 *
 * Quake textures whose names start with '{' use index 255 as transparent; for
 * regular world textures all indices are opaque. We treat index 255 as
 * transparent only when `fenceMask` is set.
 */
export function indicesToRgba(indices: Uint8Array, palette: Palette, fenceMask = false): Uint8Array {
    const out = new Uint8Array(indices.length * 4);
    for (let i = 0; i < indices.length; i++) {
        const idx = indices[i]!;
        const p = idx * 3;
        out[i * 4] = palette[p]!;
        out[i * 4 + 1] = palette[p + 1]!;
        out[i * 4 + 2] = palette[p + 2]!;
        out[i * 4 + 3] = fenceMask && idx === 255 ? 0 : 255;
    }
    return out;
}
