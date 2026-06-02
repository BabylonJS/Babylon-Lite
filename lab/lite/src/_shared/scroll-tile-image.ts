/**
 * Deterministic 64×64 tileable pattern used by scene 96 (sprite uvOffset parallax).
 *
 * The Lite side loads this single tile as a 1-cell atlas with **repeat** wrap and
 * **nearest** sampling, then draws full-texture sprites whose per-sprite `uvOffset`
 * scrolls the sampled UV. The BJS oracle cannot offset UVs per sprite, so it bakes
 * the exact same effect into a small atlas: one cell per distinct offset, each cell
 * being the base tile **rolled** (texel-shifted, wrapping) by that offset.
 *
 * Why this matches pixel-for-pixel: with nearest sampling and a 1-texel-per-pixel
 * sprite (sizePx === tile size), sampling `base` at `uv + offset` under repeat wrap
 * selects texel `(px + offset*size) mod size` — identical to sampling a pre-rolled
 * cell at `[0,1]`. Offsets are chosen as integer-texel shifts so the two agree exactly.
 *
 * Both engines call the same `drawBaseTile`, so the base pixels never drift; the BJS
 * rolled atlas is derived from the base `ImageData` (not a redraw), keeping the roll exact.
 */

/** Tile edge length in pixels/texels. */
export const SCROLL_TILE_SIZE = 64;

/** Grid layout shared by the Lite scene and BJS oracle. */
export const SCENE96_COLS = 20;
export const SCENE96_ROWS = 9;

/**
 * Per-band UV scroll offsets (normalised). Each is an integer-texel shift
 * (`offset * SCROLL_TILE_SIZE` is a whole number) so nearest sampling stays exact.
 * Band 0 = unscrolled, band 1 = half-tile horizontal, band 2 = half-tile vertical.
 */
export const SCENE96_BAND_OFFSETS: readonly (readonly [number, number])[] = [
    [0, 0],
    [0.5, 0],
    [0, 0.5],
];

/** Which band (and thus which offset) a grid row belongs to. 9 rows → 3 bands of 3. */
export function scene96BandForRow(row: number): number {
    return Math.floor(row / 3);
}

let _baseCanvas: HTMLCanvasElement | null = null;
let _baseUrl: string | null = null;
let _rolledUrl: string | null = null;

function drawBaseTile(ctx: CanvasRenderingContext2D): void {
    const s = SCROLL_TILE_SIZE;
    ctx.imageSmoothingEnabled = false;

    // Horizontal hue gradient — makes horizontal scrolling unmistakable.
    const grad = ctx.createLinearGradient(0, 0, s, 0);
    grad.addColorStop(0.0, "#1b2a6b");
    grad.addColorStop(0.25, "#2f8f6b");
    grad.addColorStop(0.5, "#c9b03a");
    grad.addColorStop(0.75, "#b5522e");
    grad.addColorStop(1.0, "#1b2a6b");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);

    // Vertical light band — makes vertical scrolling unmistakable.
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(0, s / 2 - 6, s, 12);

    // Asymmetric corner marker — disambiguates direction of the roll.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(4, 4, 10, 10);
    ctx.fillStyle = "#000000";
    ctx.fillRect(6, 6, 6, 6);

    // Diagonal stripe for extra texture.
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, s);
    ctx.lineTo(s, 0);
    ctx.stroke();
}

function getBaseCanvas(): HTMLCanvasElement {
    if (_baseCanvas) {
        return _baseCanvas;
    }
    const canvas = document.createElement("canvas");
    canvas.width = SCROLL_TILE_SIZE;
    canvas.height = SCROLL_TILE_SIZE;
    const ctx = canvas.getContext("2d", { alpha: true })!;
    drawBaseTile(ctx);
    _baseCanvas = canvas;
    return canvas;
}

/** Base 64×64 tile as a data URL. Used by the Lite uvScroll sprite layer. */
export function getScrollTileDataUrl(): string {
    if (_baseUrl) {
        return _baseUrl;
    }
    _baseUrl = getBaseCanvas().toDataURL("image/png");
    return _baseUrl;
}

/**
 * Horizontal strip atlas (one 64×64 cell per `SCENE96_BAND_OFFSETS` entry), each cell
 * being the base tile rolled by that offset. Used by the BJS oracle's `SpriteRenderer`.
 */
export function getRolledTileAtlasDataUrl(): string {
    if (_rolledUrl) {
        return _rolledUrl;
    }
    const s = SCROLL_TILE_SIZE;
    const n = SCENE96_BAND_OFFSETS.length;

    const baseCtx = getBaseCanvas().getContext("2d", { alpha: true })!;
    const base = baseCtx.getImageData(0, 0, s, s);

    const out = document.createElement("canvas");
    out.width = s * n;
    out.height = s;
    const outCtx = out.getContext("2d", { alpha: true })!;

    for (let cell = 0; cell < n; cell++) {
        const offset = SCENE96_BAND_OFFSETS[cell]!;
        const offX = Math.round(offset[0] * s);
        const offY = Math.round(offset[1] * s);
        const rolled = outCtx.createImageData(s, s);
        for (let y = 0; y < s; y++) {
            const srcY = (y + offY) % s;
            for (let x = 0; x < s; x++) {
                const srcX = (x + offX) % s;
                const srcIdx = (srcY * s + srcX) * 4;
                const dstIdx = (y * s + x) * 4;
                rolled.data[dstIdx] = base.data[srcIdx]!;
                rolled.data[dstIdx + 1] = base.data[srcIdx + 1]!;
                rolled.data[dstIdx + 2] = base.data[srcIdx + 2]!;
                rolled.data[dstIdx + 3] = base.data[srcIdx + 3]!;
            }
        }
        outCtx.putImageData(rolled, cell * s, 0);
    }

    _rolledUrl = out.toDataURL("image/png");
    return _rolledUrl;
}
