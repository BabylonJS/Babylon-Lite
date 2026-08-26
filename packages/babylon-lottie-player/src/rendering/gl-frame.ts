// Per-frame render lifecycle. The WebGL2 default framebuffer is natively multisampled when the
// context is created with `antialias: true` and carries stencil when created with `stencil: true`.
// Stencil-then-cover therefore renders directly to the canvas with no offscreen resolve; this module
// owns viewport setup, clear, and the composition-bounds scissor.

import { type GLEngineContext, clearEngine, disableScissor, setScissor, setStencilState, setViewport } from "@babylonjs/lite-gl";

/** A clip rectangle in WebGL (lower-left origin) drawing-buffer pixels. */
export interface GLScissorRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Begin a frame: reset the viewport to the full drawing buffer, clear color (to transparent)
 * and stencil (to 0) across the whole canvas, then clip subsequent draws to the comp bounds.
 *
 * The clear must reset stencil, so the stencil write mask is forced to 0xff first (a clear
 * respects the current write masks). Scissor is disabled during the clear so the letterbox
 * margins are cleared too, then enabled for the comp-bounds draws.
 */
export function beginGLFrame(engine: GLEngineContext, scissor: GLScissorRect): void {
    setViewport(engine);
    disableScissor(engine);
    // A clear respects the stencil write mask; force it open so stencil actually resets to 0.
    setStencilState(engine, { test: true, mask: 0xff });
    clearEngine(engine, { color: { r: 0, g: 0, b: 0, a: 0 }, stencil: true });
    setScissor(engine, scissor.x, scissor.y, scissor.width, scissor.height);
}

/** End a frame: drop the comp-bounds clip so the next frame's full-canvas clear is not clipped. */
export function endGLFrame(engine: GLEngineContext): void {
    disableScissor(engine);
}
