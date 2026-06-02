/**
 * Generates a deterministic 256×128 sprite atlas via canvas2D.
 *
 * Layout: 8 columns × 4 rows of 32×32 cells (32 frames).
 *  - Frames 0..7  : "spinner" — a single white wedge rotated to 8 angles on a black bg.
 *  - Frames 8..23 : icon set — coloured circle on a coloured square background (HUD-style indicators).
 *  - Frames 24..31: number digits 0..7 — drawn as tally marks (font-free for cross-browser parity).
 *
 * Returned as a data URL so both Lite and BJS scene code can use the same pixels.
 */

const ATLAS_WIDTH = 256;
const ATLAS_HEIGHT = 128;
const CELL = 32;

let _cached: string | null = null;

export function getSpriteAtlasDataUrl(): string {
    if (_cached) {
        return _cached;
    }
    const canvas = document.createElement("canvas");
    canvas.width = ATLAS_WIDTH;
    canvas.height = ATLAS_HEIGHT;
    const ctx = canvas.getContext("2d", { alpha: true })!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);

    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 8; c++) {
            const idx = r * 8 + c;
            drawCell(ctx, c * CELL, r * CELL, idx);
        }
    }

    _cached = canvas.toDataURL("image/png");
    return _cached;
}

function drawCell(ctx: CanvasRenderingContext2D, x: number, y: number, idx: number): void {
    if (idx < 8) {
        // Spinner wedge — 8 angles 0..315°, white on black.
        ctx.fillStyle = "#000000";
        ctx.fillRect(x, y, CELL, CELL);
        const cx = x + CELL / 2;
        const cy = y + CELL / 2;
        const angle = (idx * Math.PI) / 4;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(14, -4);
        ctx.lineTo(14, 4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        return;
    }
    if (idx < 24) {
        // Icon — coloured circle on a coloured square.
        const i = idx - 8;
        const bgHue = (i * 360) / 16;
        const fgHue = (bgHue + 180) % 360;
        ctx.fillStyle = `hsl(${bgHue}, 60%, 30%)`;
        ctx.fillRect(x, y, CELL, CELL);
        ctx.fillStyle = `hsl(${fgHue}, 80%, 65%)`;
        ctx.beginPath();
        ctx.arc(x + CELL / 2, y + CELL / 2, 11, 0, Math.PI * 2);
        ctx.fill();
        return;
    }
    // Tally marks — green bg, draw `digit` vertical bars.
    const digit = idx - 24;
    ctx.fillStyle = "#0a4020";
    ctx.fillRect(x, y, CELL, CELL);
    ctx.fillStyle = "#cfe8d5";
    for (let i = 0; i < digit; i++) {
        const bx = x + 4 + i * 3;
        ctx.fillRect(bx, y + 6, 2, 20);
    }
}

export const SPRITE_ATLAS_INFO = {
    widthPx: ATLAS_WIDTH,
    heightPx: ATLAS_HEIGHT,
    cellWidthPx: CELL,
    cellHeightPx: CELL,
    columns: 8,
    rows: 4,
} as const;
