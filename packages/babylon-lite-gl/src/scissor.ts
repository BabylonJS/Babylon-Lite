/**
 * Scissor-test state — the lite-gl counterpart of Babylon's
 * `engine.enableScissor` / `disableScissor` (and the raw `gl.scissor` Babylon
 * issues for clip rects). Cached in `GLState`.
 *
 * Coordinates are raw WebGL (lower-left origin). A consumer using a top-left
 * coordinate convention (like ShapeBuilder) flips Y itself
 * (`viewportHeight - rect.bottom`) before calling, exactly as it did against
 * Babylon's `ThinEngine`.
 */
import type { GLEngineContext } from "./context.js";

/** GL `gl.SCISSOR_TEST`. */
const SCISSOR_TEST = 0x0c11;

/**
 * Enable the scissor test and set the clip rectangle (lower-left origin),
 * cached. Re-issues `gl.scissor` only when the rectangle changes, and
 * `gl.enable(SCISSOR_TEST)` only on the disabled→enabled transition.
 *
 * @param engine - The engine.
 * @param x - Lower-left X of the scissor rectangle, in pixels.
 * @param y - Lower-left Y of the scissor rectangle, in pixels.
 * @param width - Rectangle width in pixels.
 * @param height - Rectangle height in pixels.
 */
export function setScissor(engine: GLEngineContext, x: number, y: number, width: number, height: number): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const gl = engine.gl;
    const s = engine._state;
    if (s.scissorEnabled !== 1) {
        s.scissorEnabled = 1;
        gl.enable(SCISSOR_TEST);
    }
    if (s.scissorX !== x || s.scissorY !== y || s.scissorW !== width || s.scissorH !== height) {
        s.scissorX = x;
        s.scissorY = y;
        s.scissorW = width;
        s.scissorH = height;
        gl.scissor(x, y, width, height);
    }
}

/**
 * Disable the scissor test (`gl.disable(SCISSOR_TEST)`), cached. Repeated calls
 * after the first are elided.
 *
 * @param engine - The engine.
 */
export function disableScissor(engine: GLEngineContext): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const s = engine._state;
    if (s.scissorEnabled === 0) {
        return;
    }
    s.scissorEnabled = 0;
    engine.gl.disable(SCISSOR_TEST);
}
