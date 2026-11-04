/** Scene 348 has one layout: direct visibility rows, normalized glTF-style rows, and policy samples. */
export const OPACITY_COLUMNS = [
    { x: -4.5, opacity: 1 },
    { x: -1.5, opacity: 0.5 },
    { x: 1.5, opacity: 0 },
    { x: 4.5, opacity: 1 },
] as const;

export const OPACITY_ROWS = [
    { name: "direct-standard", family: "standard", y: 4, color: [0.85, 0.24, 0.12] },
    { name: "direct-pbr", family: "pbr", y: 2.1, color: [0.12, 0.42, 0.85] },
    { name: "normalized-opaque", family: "pbr", y: 0.2, color: [0.85, 0.6, 0.12] },
    { name: "normalized-mask", family: "pbr", y: -1.7, color: [0.12, 0.85, 0.3] },
] as const;

export const SHADOW_SAMPLES = [
    { name: "policy-standard-half", family: "standard", x: -4.5, opacity: 0.5 },
    { name: "policy-standard-zero", family: "standard", x: -1.5, opacity: 0 },
    { name: "policy-pbr-half", family: "pbr", x: 1.5, opacity: 0.5 },
    { name: "policy-pbr-zero", family: "pbr", x: 4.5, opacity: 0 },
] as const;

export const MASK_WIDTH = 64;
export const MASK_HEIGHT = 16;
export const MASK_ALPHAS = [0, 64, 127, 128, 160, 192, 224, 255] as const;

/** Vertical bands avoid a texture-origin ambiguity; 128..255 survive cutoff before the 0.5 fade. */
export function createOpacityMaskPixels(): Uint8Array {
    const pixels = new Uint8Array(MASK_WIDTH * MASK_HEIGHT * 4);
    for (let y = 0; y < MASK_HEIGHT; y++) {
        for (let x = 0; x < MASK_WIDTH; x++) {
            const offset = (y * MASK_WIDTH + x) * 4;
            pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 255;
            pixels[offset + 3] = MASK_ALPHAS[Math.floor(x / 8)]!;
        }
    }
    return pixels;
}

export async function waitOpacityFrames(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
}
