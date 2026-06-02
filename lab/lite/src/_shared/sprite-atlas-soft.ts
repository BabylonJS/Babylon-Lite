/**
 * Generates a deterministic 256×128 soft-edge sprite atlas via canvas2D.
 *
 * Same 8×4 grid layout as `sprite-atlas-image.ts`, but every cell is a
 * radial gradient that fades from opaque centre to fully transparent at
 * the cell border. The anti-aliased edges put real semi-transparent
 * pixels into the texture so any storage / blend mismatch produces a
 * visibly bright halo instead of being invisible.
 *
 * Two variants:
 *   - `getSoftSpriteAtlasDataUrl()` — straight RGBA, the bytes a regular
 *     PNG decoder would produce.
 *   - `getSoftSpriteAtlasPremultipliedDataUrl()` — the same image with
 *     RGB pre-multiplied by alpha. Use this when feeding the atlas to a
 *     renderer that assumes premultiplied storage (e.g. BJS's
 *     `SpriteRenderer` with `blendMode = ALPHA_PREMULTIPLIED`).
 *
 * Both data URLs are returned as PNG, so the bits round-trip through the
 * usual `Texture` / `loadSpriteAtlas` paths without further conversion.
 */

const ATLAS_WIDTH = 256;
const ATLAS_HEIGHT = 128;
const CELL = 32;

let _cachedStraight: string | null = null;
let _cachedPremul: string | null = null;

export const SOFT_SPRITE_ATLAS_INFO = {
    widthPx: ATLAS_WIDTH,
    heightPx: ATLAS_HEIGHT,
    cellWidthPx: CELL,
    cellHeightPx: CELL,
    columns: 8,
    rows: 4,
} as const;

function buildAtlasCanvas(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = ATLAS_WIDTH;
    canvas.height = ATLAS_HEIGHT;
    const ctx = canvas.getContext("2d", { alpha: true })!;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);

    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 8; c++) {
            const idx = r * 8 + c;
            drawSoftCell(ctx, c * CELL, r * CELL, idx);
        }
    }
    return canvas;
}

function drawSoftCell(ctx: CanvasRenderingContext2D, x: number, y: number, idx: number): void {
    // 32 cells of radial gradients, each in a different hue. The opaque
    // centre fades to 0-alpha at radius 14 (cell is 32×32 with 1-pixel
    // safe gutter on each side after the gradient).
    const cx = x + CELL / 2;
    const cy = y + CELL / 2;
    const hue = (idx * 360) / 32;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 14);
    grad.addColorStop(0, `hsla(${hue}, 80%, 55%, 1)`);
    grad.addColorStop(0.6, `hsla(${hue}, 80%, 55%, 0.8)`);
    grad.addColorStop(1, `hsla(${hue}, 80%, 55%, 0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, CELL, CELL);
}

export function getSoftSpriteAtlasDataUrl(): string {
    if (_cachedStraight) {
        return _cachedStraight;
    }
    _cachedStraight = buildAtlasCanvas().toDataURL("image/png");
    return _cachedStraight;
}

export function getSoftSpriteAtlasPremultipliedDataUrl(): string {
    if (_cachedPremul) {
        return _cachedPremul;
    }
    const canvas = buildAtlasCanvas();
    const ctx = canvas.getContext("2d", { alpha: true })!;
    const img = ctx.getImageData(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3]! / 255;
        data[i] = Math.round(data[i]! * a);
        data[i + 1] = Math.round(data[i + 1]! * a);
        data[i + 2] = Math.round(data[i + 2]! * a);
    }
    ctx.putImageData(img, 0, 0);
    _cachedPremul = canvas.toDataURL("image/png");
    return _cachedPremul;
}
