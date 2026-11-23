import type { GLEngineContext } from "./context.js";

/**
 * Enable or disable synchronous framebuffer completeness checks for debugging.
 * Disabled by default to avoid GPU-process round trips, matching ThinEngine's
 * render-target creation path. Affects subsequent target creation, stencil
 * attachment, resize and restore, not existing targets or per-frame draws.
 *
 * When enabled, incomplete attachments retain their existing errors and rollback
 * behavior. The setting survives cache wipes and context restoration. No-op on
 * a lost/disposed engine. Importing only render-target APIs retains no validator.
 *
 * @param engine - The engine whose future framebuffer builds are validated.
 * @param enabled - Whether to validate framebuffer completeness.
 */
export function setFramebufferValidation(engine: GLEngineContext, enabled: boolean): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    engine._validateFramebuffer = enabled ? validateFramebuffer : undefined;
}

/** Validate the currently bound framebuffer before its allocation is committed. */
function validateFramebuffer(gl: WebGL2RenderingContext, stencil: boolean): void {
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`lite-gl: render target framebuffer incomplete${stencil ? " after stencil attach" : ""} (status 0x${status.toString(16)})`);
    }
}
