/**
 * Deterministic hard-alpha atlas for cutout billboard parity.
 *
 * Layout: 4 columns x 2 rows of 32x32 cells. Every visible pixel is fully
 * opaque and every hole/background pixel is fully transparent so alpha-test
 * parity is stable under nearest sampling.
 */

const ATLAS_WIDTH = 128;
const ATLAS_HEIGHT = 64;
const CELL = 32;

let _cached: string | null = null;

export const CUTOUT_SPRITE_ATLAS_INFO = {
    widthPx: ATLAS_WIDTH,
    heightPx: ATLAS_HEIGHT,
    cellWidthPx: CELL,
    cellHeightPx: CELL,
    columns: 4,
    rows: 2,
} as const;

export function getCutoutSpriteAtlasDataUrl(): string {
    if (_cached) {
        return _cached;
    }
    const canvas = document.createElement("canvas");
    canvas.width = ATLAS_WIDTH;
    canvas.height = ATLAS_HEIGHT;
    const ctx = canvas.getContext("2d", { alpha: true })!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);

    for (let row = 0; row < CUTOUT_SPRITE_ATLAS_INFO.rows; row++) {
        for (let col = 0; col < CUTOUT_SPRITE_ATLAS_INFO.columns; col++) {
            drawCell(ctx, col * CELL, row * CELL, row * CUTOUT_SPRITE_ATLAS_INFO.columns + col);
        }
    }

    _cached = canvas.toDataURL("image/png");
    return _cached;
}

function drawCell(ctx: CanvasRenderingContext2D, x: number, y: number, index: number): void {
    switch (index) {
        case 0:
            ctx.fillStyle = "#3ca044";
            ctx.fillRect(x + 13, y + 2, 6, 28);
            ctx.fillRect(x + 5, y + 7, 22, 8);
            ctx.fillRect(x + 8, y + 18, 16, 8);
            ctx.clearRect(x + 14, y + 8, 4, 18);
            ctx.clearRect(x + 7, y + 13, 18, 3);
            break;
        case 1:
            ctx.fillStyle = "#e1b23d";
            ctx.fillRect(x + 4, y + 4, 24, 24);
            ctx.clearRect(x + 12, y + 12, 8, 8);
            ctx.clearRect(x + 6, y + 6, 5, 5);
            ctx.clearRect(x + 21, y + 21, 5, 5);
            break;
        case 2:
            ctx.fillStyle = "#4cc9d8";
            ctx.fillRect(x + 4, y + 4, 24, 4);
            ctx.fillRect(x + 4, y + 24, 24, 4);
            ctx.fillRect(x + 4, y + 4, 4, 24);
            ctx.fillRect(x + 24, y + 4, 4, 24);
            ctx.fillRect(x + 14, y + 4, 4, 24);
            ctx.fillRect(x + 4, y + 14, 24, 4);
            break;
        case 3:
            ctx.fillStyle = "#d75fb5";
            ctx.fillRect(x + 3, y + 3, 26, 26);
            ctx.clearRect(x + 9, y + 9, 14, 14);
            ctx.clearRect(x + 3, y + 13, 8, 6);
            ctx.clearRect(x + 21, y + 13, 8, 6);
            break;
        default:
            ctx.fillStyle = "#ef6f4e";
            ctx.fillRect(x + 8, y + 4, 16, 24);
            ctx.fillRect(x + 4, y + 10, 24, 12);
            ctx.clearRect(x + 12, y + 12, 8, 8);
            break;
    }
}