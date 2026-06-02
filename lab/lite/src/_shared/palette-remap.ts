/**
 * Deterministic 256-entry colormap palette + atlas baking helper shared by the
 * custom-shader palette-remap parity scenes (93, 95).
 *
 * The palette maps a single source channel (the atlas sample's red byte) to an
 * RGB output colour. Lite uploads this exact byte buffer as a 256×1 nearest
 * lookup texture and indexes it in WGSL by `texel.r`; the BJS oracle bakes the
 * same lookup into the atlas pixels on a canvas and renders stock sprites. Both
 * paths therefore evaluate `palette[R]` for the identical source byte, which is
 * bit-exact under nearest filtering:
 *
 *   - GPU nearest sampling of a 256-wide texture at `u = R / 255` selects texel
 *     index `R` for every `R` in `[0, 255]`, so the WGSL lookup equals
 *     `palette[R]`.
 *   - A 2D-canvas `getImageData` round-trip is lossless for fully-opaque and
 *     fully-transparent pixels (no premultiplied-alpha rounding), so the baked
 *     atlas must be built from a hard-alpha source (the cutout atlas).
 */

/** Width of the colormap lookup (one RGBA entry per possible red byte). */
export const PALETTE_WIDTH = 256;

let _cachedPalette: Uint8Array | null = null;

/**
 * Build the 256×1 RGBA colormap. Entry `i` is the remap colour for source red
 * byte `i`. Alpha is always 255 (the remap preserves the source alpha, not the
 * palette's). The ramp is a smooth phase-shifted sinusoid rainbow so adjacent
 * source colours map to visibly distinct hues.
 */
export function buildColormapPalette(): Uint8Array {
    if (_cachedPalette) {
        return _cachedPalette;
    }
    const data = new Uint8Array(PALETTE_WIDTH * 4);
    const twoPi = Math.PI * 2;
    for (let i = 0; i < PALETTE_WIDTH; i++) {
        const t = i / (PALETTE_WIDTH - 1);
        const r = 0.5 + 0.5 * Math.sin(twoPi * (t + 0.0));
        const g = 0.5 + 0.5 * Math.sin(twoPi * (t + 1 / 3));
        const b = 0.5 + 0.5 * Math.sin(twoPi * (t + 2 / 3));
        const o = i * 4;
        data[o] = Math.round(r * 255);
        data[o + 1] = Math.round(g * 255);
        data[o + 2] = Math.round(b * 255);
        data[o + 3] = 255;
    }
    _cachedPalette = data;
    return data;
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("palette-remap: failed to decode atlas image"));
        img.src = src;
    });
}

/**
 * Produce a new atlas data URL whose every pixel's RGB is replaced by
 * `palette[redByte]`, preserving the original alpha. Must be fed a hard-alpha
 * source (the cutout atlas) so the canvas round-trip is lossless.
 */
export async function bakeRemappedAtlasDataUrl(srcDataUrl: string, palette: Uint8Array): Promise<string> {
    const img = await loadImage(srcDataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { alpha: true })!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!;
        const o = r * 4;
        data[i] = palette[o]!;
        data[i + 1] = palette[o + 1]!;
        data[i + 2] = palette[o + 2]!;
        // Alpha (data[i + 3]) is left untouched.
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
}
