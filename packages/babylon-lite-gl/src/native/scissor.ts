/**
 * Native scissor module — the native-backend twin of `scissor.ts`. Same cached
 * behaviour; the device call is `COMMAND_SETSCISSOR` (all-zero disables the test,
 * matching ThinNativeEngine.disableScissor) instead of `gl.scissor`/`gl.enable`.
 *
 * Coordinates are lower-left origin, exactly like the WebGL module.
 */
import type { GLEngineContext } from "./native-context.js";
import { dSetScissor } from "./native-device.js";

/**
 * Enable the scissor test and set the clip rectangle (lower-left origin), cached.
 * Re-issues `COMMAND_SETSCISSOR` only when the rectangle changes. Mirrors the
 * WebGL `setScissor`.
 */
export function setScissor(engine: GLEngineContext, x: number, y: number, width: number, height: number): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const s = engine._state;
    if (s.scissorEnabled === 1 && s.scissorX === x && s.scissorY === y && s.scissorW === width && s.scissorH === height) {
        return;
    }
    s.scissorEnabled = 1;
    s.scissorX = x;
    s.scissorY = y;
    s.scissorW = width;
    s.scissorH = height;
    dSetScissor(engine, x, y, width, height);
}

/**
 * Disable the scissor test (emits an all-zero `COMMAND_SETSCISSOR`), cached.
 * Repeated calls after the first are elided. Mirrors the WebGL `disableScissor`.
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
    dSetScissor(engine, 0, 0, 0, 0);
}
