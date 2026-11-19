import {
    bindRenderTarget,
    clearEngine,
    createGLEngine,
    createRenderTarget,
    disableScissor,
    presentRenderTarget,
    restoreDefaultFramebuffer,
    setScissor,
    wipeGLStateCache,
} from "babylon-lite-gl";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const result = document.getElementById("result") as HTMLParagraphElement;
const engine = createGLEngine(canvas, { alpha: false });
const gl = engine.gl;
const target = createRenderTarget(engine, canvas.width, canvas.height);
const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const SCISSOR = [8, 8, 16, 16] as const;
const actual = new Uint8Array(4);

function checkPixel(label: string, x: number, y: number, expected: readonly number[]): void {
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, actual);
    for (let channel = 0; channel < 4; channel++) {
        if (Math.abs(actual[channel]! - expected[channel]!) > 2) {
            throw new Error(`${label} pixel (${x}, ${y}): expected ${expected.join(",")}, got ${Array.from(actual).join(",")}`);
        }
    }
}

/** Fills the target green and the canvas red, leaving the scissor rectangle active and the target bound. */
function prepare(): void {
    disableScissor(engine);
    restoreDefaultFramebuffer(engine);
    clearEngine(engine, { color: { r: 1, g: 0, b: 0 } });
    checkPixel("canvas before presentation", 40, 40, RED);
    bindRenderTarget(target);
    clearEngine(engine, { color: { r: 0, g: 1, b: 0 } });
    setScissor(engine, ...SCISSOR);
}

/** Presents the target, then clears blue; the presentation covers the canvas while the clear stays inside the scissor rectangle. */
function presentAndCheck(label: string): void {
    presentRenderTarget(target);
    checkPixel(`${label} presentation inside the scissor rectangle`, 12, 12, GREEN);
    checkPixel(`${label} presentation outside the scissor rectangle`, 40, 40, GREEN);
    checkPixel(`${label} presentation at the canvas corner`, 63, 63, GREEN);
    clearEngine(engine, { color: { r: 0, g: 0, b: 1 } });
    checkPixel(`${label} clear inside the scissor rectangle`, 12, 12, BLUE);
    checkPixel(`${label} clear outside the scissor rectangle`, 40, 40, GREEN);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
        throw new Error(`${label}: WebGL error ${error}`);
    }
}

function rendererName(): string {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
}

try {
    canvas.dataset.renderer = rendererName();
    canvas.dataset.samples = String(gl.getParameter(gl.SAMPLES));
    prepare();
    presentAndCheck("cached state");
    prepare();
    wipeGLStateCache(engine);
    presentAndCheck("wiped state");
    canvas.dataset.result = "passed";
    result.textContent = "PASS: presentation covers the canvas and the scissor rectangle survives, with cached and wiped state.";
} catch (error) {
    canvas.dataset.result = "failed";
    result.textContent = `FAIL: ${String(error)}`;
    throw error;
}
