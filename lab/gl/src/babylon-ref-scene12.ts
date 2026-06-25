import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";

/**
 * Babylon.js reference for GL Scene 12 — Scissor Rectangles.
 *
 * Reproduces lab/gl/src/scene12.ts (which uses @babylonjs/lite-gl/scissor's
 * `setScissor` / `disableScissor` + `clearEngine`) with Babylon's ThinEngine
 * driven through its raw WebGL2 context (`engine._gl`). lite-gl's `setScissor` is
 * a thin cache over `gl.enable(SCISSOR_TEST)` + `gl.scissor`, and `clearEngine`
 * is a cache over `gl.clearColor` + `gl.clear` — so issuing those exact raw GL
 * calls per cell is the ground truth the lite scene reproduces.
 *
 * Why this matches lite-gl exactly:
 *  - Context / size / hwScaling: identical to the other GL references
 *    (ThinEngine, opaque buffer, hwScaling=1, 1280×720).
 *  - The SAME `Math.round((i * size) / n)` integer grid boundaries and the SAME
 *    cosine-palette per-cell colors as scene12, so every cell rectangle and clear
 *    color is bit-identical.
 *  - GL scissor has a BOTTOM-LEFT origin in both engines, so identical integer
 *    rects land on identical pixels; the boundaries are pixel-exact (whole
 *    columns/rows), so there is no seam regardless of MSAA.
 *
 * Determinism: ?seekTime=<seconds> renders exactly ONE frame (the content is
 * static) then stamps dataset.animationFrozen="true" and stops the loop.
 */

/** Grid dimensions — a 3×3 tiling of solid scissor-clipped regions. */
const COLS = 3;
const ROWS = 3;

/** Integer boundary of grid line `i` (0..n) across `size` pixels — identical to
 *  lab/gl/src/scene12.ts so the tiling is bit-for-bit the same. */
function gridBound(i: number, n: number, size: number): number {
    return Math.round((i * size) / n);
}

/** Deterministic per-cell color — identical expression to scene12.ts. */
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

(function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = new ThinEngine(canvas, false, { alpha: false, premultipliedAlpha: false, stencil: false }, false);
    const gl = engine._gl as WebGL2RenderingContext;
    // Disable DITHER (on by default) so the float→unorm8 clear conversion is a
    // deterministic round-to-nearest in both engines — see lab/gl/src/scene12.ts.
    gl.disable(gl.DITHER);

    const seekTime = parseSeekTime();
    let firstFrameDrawn = false;

    engine.runRenderLoop(() => {
        // Defer until the canvas has a real laid-out size (matches scene12.ts).
        if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
            return;
        }
        engine.resize();
        const width = canvas.width;
        const height = canvas.height;

        // Tile the canvas: one scissor-clipped clear per grid cell (bottom-left
        // origin — row 0 is the bottom row). Raw GL mirrors lite-gl's
        // setScissor + clearEngine exactly.
        const cellCount = ROWS * COLS;
        gl.enable(gl.SCISSOR_TEST);
        for (let row = 0; row < ROWS; row++) {
            const y0 = gridBound(row, ROWS, height);
            const y1 = gridBound(row + 1, ROWS, height);
            for (let col = 0; col < COLS; col++) {
                const x0 = gridBound(col, COLS, width);
                const x1 = gridBound(col + 1, COLS, width);
                const color = cellColor(row * COLS + col, cellCount);
                gl.scissor(x0, y0, x1 - x0, y1 - y0);
                gl.clearColor(color.r, color.g, color.b, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
            }
        }
        gl.disable(gl.SCISSOR_TEST); // restore full-canvas state

        if (!firstFrameDrawn) {
            firstFrameDrawn = true;
            canvas.dataset.drawCalls = String(cellCount);
            canvas.dataset.initMs = String(performance.now() - initStart);
            canvas.dataset.ready = "true";
            if (seekTime !== null) {
                canvas.dataset.animationFrozen = "true";
                engine.stopRenderLoop();
            }
        }
    });

    window.addEventListener("resize", () => engine.resize());
})();
