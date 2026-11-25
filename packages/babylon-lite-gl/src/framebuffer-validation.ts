import type { GLEngineContext } from "./context.js";

/**
 * Enable or disable synchronous framebuffer completeness checks. Enabled by
 * default, so render-target creation, stencil attachment, resize and restore
 * fail fast (and roll back) on an incomplete framebuffer — e.g. a size above
 * `MAX_TEXTURE_SIZE` that WebGL rejects without throwing. Each check is a
 * `checkFramebufferStatus` GPU-process round trip; pass `false` to skip them
 * (matching ThinEngine's render-target creation path) when the host already
 * guarantees valid attachments. Affects subsequent framebuffer builds, not
 * existing targets or per-frame draws.
 *
 * The setting survives cache wipes and context restoration. No-op on a
 * lost/disposed engine.
 *
 * @param engine - The engine whose future framebuffer builds are validated.
 * @param enabled - Whether to validate framebuffer completeness.
 */
export function setFramebufferValidation(engine: GLEngineContext, enabled: boolean): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    engine._skipFramebufferValidation = !enabled;
}

/** Throw if the currently bound framebuffer is incomplete, unless the engine
 *  opted out via {@link setFramebufferValidation}. @internal */
export function validateFramebuffer(engine: GLEngineContext, stencil: boolean): void {
    if (engine._skipFramebufferValidation) {
        return;
    }
    const gl = engine.gl;
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`lite-gl: render target framebuffer incomplete${stencil ? " after stencil attach" : ""} (status 0x${status.toString(16)})`);
    }
}
