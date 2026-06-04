// Clean-room PLAYPAL / COLORMAP decoding for the DOOM demo.
//
// PLAYPAL: 14 palettes, each 256 RGB triples (768 bytes) → 10752 bytes total.
//   Palette 0 is the normal in-game palette; the rest are damage/pickup tints.
// COLORMAP: 34 maps of 256 bytes. Maps 0..31 are light levels (0 = brightest),
//   32 = invulnerability, 33 = pure black. Each entry remaps a palette index to
//   another palette index under that lighting.
//
// Format facts are from public Doom file-format documentation; no GPL source used.

import type { Wad } from "./wad-file.js";
import { getLump } from "./wad-file.js";

export const PALETTE_COUNT = 14;
export const PALETTE_SIZE = 256;
export const COLORMAP_COUNT = 34;

/** All 14 palettes, each a 256×3 (RGB) byte run. */
export function parsePlaypal(wad: Wad): Uint8Array {
    const data = getLump(wad, "PLAYPAL");
    if (data.length < PALETTE_COUNT * PALETTE_SIZE * 3) {
        throw new Error(`PLAYPAL too small: ${data.length} bytes`);
    }
    return data.slice(0, PALETTE_COUNT * PALETTE_SIZE * 3);
}

/** 34 colormaps, each 256 bytes (palette-index → palette-index). */
export function parseColormap(wad: Wad): Uint8Array {
    const data = getLump(wad, "COLORMAP");
    if (data.length < COLORMAP_COUNT * PALETTE_SIZE) {
        throw new Error(`COLORMAP too small: ${data.length} bytes`);
    }
    return data.slice(0, COLORMAP_COUNT * PALETTE_SIZE);
}

/**
 * Builds a 256 (width) × 34 (height) RGBA lookup texture that pre-applies the
 * colormap to a chosen base palette: texel (i, light) = palette[colormap[light][i]].
 *
 * The renderer samples this with the source pixel's palette index as U and the
 * computed light level as V, reproducing Doom's banded light diminishing exactly
 * (indexed lookup, not smooth RGB interpolation).
 */
export function buildColormapLut(playpal: Uint8Array, colormap: Uint8Array, paletteIndex = 0): Uint8Array {
    const palBase = paletteIndex * PALETTE_SIZE * 3;
    const rgba = new Uint8Array(PALETTE_SIZE * COLORMAP_COUNT * 4);
    let o = 0;
    for (let light = 0; light < COLORMAP_COUNT; light++) {
        const mapBase = light * PALETTE_SIZE;
        for (let i = 0; i < PALETTE_SIZE; i++) {
            const palIdx = colormap[mapBase + i]!;
            const p = palBase + palIdx * 3;
            rgba[o] = playpal[p]!;
            rgba[o + 1] = playpal[p + 1]!;
            rgba[o + 2] = playpal[p + 2]!;
            rgba[o + 3] = 255;
            o += 4;
        }
    }
    return rgba;
}

/** Expands a single palette (default palette 0) to a 256×1 RGBA byte run. */
export function buildPaletteRgba(playpal: Uint8Array, paletteIndex = 0): Uint8Array {
    const base = paletteIndex * PALETTE_SIZE * 3;
    const rgba = new Uint8Array(PALETTE_SIZE * 4);
    for (let i = 0; i < PALETTE_SIZE; i++) {
        const p = base + i * 3;
        rgba[i * 4] = playpal[p]!;
        rgba[i * 4 + 1] = playpal[p + 1]!;
        rgba[i * 4 + 2] = playpal[p + 2]!;
        rgba[i * 4 + 3] = 255;
    }
    return rgba;
}
