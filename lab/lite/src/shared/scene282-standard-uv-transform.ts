export const TEXTURE_SIZE = 8;
export const UV_SCALE = [1.65, 1.15] as const;
export const UV_OFFSET = [0.17, 0.11] as const;
export const UV_ROTATION = 0.42;

export function buildTexturePixels(): Uint8Array {
    const pixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
    const colors = [
        [245, 78, 66],
        [64, 180, 255],
        [255, 210, 72],
        [104, 222, 126],
    ] as const;
    for (let y = 0; y < TEXTURE_SIZE; y++) {
        for (let x = 0; x < TEXTURE_SIZE; x++) {
            const quadrant = (x >= TEXTURE_SIZE / 2 ? 1 : 0) + (y >= TEXTURE_SIZE / 2 ? 2 : 0);
            const checker = (x + y) % 2 === 0 ? 1 : 0.55;
            const color = colors[quadrant]!;
            const offset = (y * TEXTURE_SIZE + x) * 4;
            pixels[offset] = Math.round(color[0] * checker);
            pixels[offset + 1] = Math.round(color[1] * checker);
            pixels[offset + 2] = Math.round(color[2] * checker);
            pixels[offset + 3] = 255;
        }
    }
    return pixels;
}
