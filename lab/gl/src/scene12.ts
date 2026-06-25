import { createGLEngine, resizeGLEngine, runRenderLoop, stopRenderLoop } from "babylon-lite-gl";
import { disableScissor, setScissor } from "babylon-lite-gl/scissor";
import { clearEngine } from "babylon-lite-gl/depth-stencil";

/**
 * Scene 12 — Scissor Rectangles.
 *
 * Exercises the @babylonjs/lite-gl/scissor sub-entry (`setScissor` /
 * `disableScissor`) together with `clearEngine` from
 * @babylonjs/lite-gl/depth-stencil. The canvas is tiled into a `COLS × ROWS`
 * grid: for each cell we set the scissor box to that cell's integer rectangle
 * and clear the (default) framebuffer to a solid color, so every region is
 * painted by an independent scissor-clipped clear. `disableScissor` restores the
 * full-canvas state at the end.
 *
 * Determinism: the cell rectangles come from `Math.round((i * size) / n)` on the
 * drawing-buffer size (1280×720, hwScaling 1) so they tile EXACTLY — no gaps, no
 * overlap — and each cell's color is a fixed cosine-palette function of its
 * linear index. GL scissor uses a BOTTOM-LEFT origin in both lite-gl and
 * Babylon's ThinEngine, so the identical integer rects + colors land on the
 * identical pixels (see lab/gl/src/babylon-ref-scene12.ts). The content is fully
 * static; `?seekTime=<seconds>` still renders exactly one frame, stamps
 * `dataset.animationFrozen` and halts so a screenshot is stable.
 */

/** Grid dimensions — a 3×3 tiling of solid scissor-clipped regions. */
const COLS = 3;
const ROWS = 3;

/** Integer boundary of grid line `i` (0..n) across `size` pixels. Using the
 *  same rounded formula for both sides of every cell guarantees the tiling
 *  covers each pixel exactly once. */
function gridBound(i: number, n: number, size: number): number {
    return Math.round((i * size) / n);
}

/** Deterministic per-cell color: a cosine palette over the linear cell index. */
function cellColor(index: number, count: number): { r: number; g: number; b: number } {
    const t = index / count;
    return {
        r: 0.5 + 0.5 * Math.cos(2 * Math.PI * t + 0),
        g: 0.5 + 0.5 * Math.cos(2 * Math.PI * t + (2 * Math.PI) / 3),
        b: 0.5 + 0.5 * Math.cos(2 * Math.PI * t + (4 * Math.PI) / 3),
    };
}

/** Parse the parity harness's `?seekTime=<seconds>` query param (null when absent). */
function parseSeekTime(): number | null {
    const raw = new URLSearchParams(window.location.search).get("seekTime");
    if (raw === null) {
        return null;
    }
    const seconds = Number.parseFloat(raw);
    return Number.isFinite(seconds) ? seconds : null;
}

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
// Match the ThinEngine reference's opaque backbuffer: premultipliedAlpha:false so
// bright clears are not put through a premultiply round-trip.
const engine = createGLEngine(canvas, { alpha: false, premultipliedAlpha: false });
// DITHER is enabled by default and makes the float→unorm8 clear conversion
// implementation-defined, so two contexts can round the same flat clear color
// differently (±1). It is NOT part of lite-gl's cached GL state, so disabling it
// directly on the raw context is safe (no cache desync) and makes the per-cell
// clears deterministic — bit-identical to the reference.
engine.gl.disable(engine.gl.DITHER);

const seekTime = parseSeekTime();
const initStart = performance.now();
let firstFrameDrawn = false;

runRenderLoop(engine, () => {
    // Defer until the canvas has a real laid-out size so the tiling is computed
    // against the final 1280×720 drawing buffer (not the 300×150 default).
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
        return;
    }
    resizeGLEngine(engine);
    const width = canvas.width;
    const height = canvas.height;

    // Tile the canvas: one scissor-clipped clear per grid cell (bottom-left
    // origin — row 0 is the bottom row).
    const cellCount = ROWS * COLS;
    for (let row = 0; row < ROWS; row++) {
        const y0 = gridBound(row, ROWS, height);
        const y1 = gridBound(row + 1, ROWS, height);
        for (let col = 0; col < COLS; col++) {
            const x0 = gridBound(col, COLS, width);
            const x1 = gridBound(col + 1, COLS, width);
            setScissor(engine, x0, y0, x1 - x0, y1 - y0);
            clearEngine(engine, { color: cellColor(row * COLS + col, cellCount) });
        }
    }
    disableScissor(engine); // restore full-canvas state

    if (!firstFrameDrawn) {
        firstFrameDrawn = true;
        canvas.dataset.drawCalls = String(cellCount); // one clear per cell
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
        if (seekTime !== null) {
            canvas.dataset.animationFrozen = "true";
            stopRenderLoop(engine);
        }
    }
});
