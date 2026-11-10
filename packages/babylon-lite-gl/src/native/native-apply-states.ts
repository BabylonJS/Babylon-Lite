/**
 * Native deferred render-state flush dispatcher — the native-backend twin of
 * `apply-states.ts`. Native blend/depth/stencil/color-mask setters record only
 * the DESIRED state and install their per-category reconciler onto a
 * `_state._flush*` slot; this dispatches through whichever slots are populated,
 * right before each native draw / clear, so redundant state emits no commands.
 */
import type { GLEngineContext } from "./native-context.js";

/**
 * Flush the deferred blend / depth+cull / stencil / color-mask state by invoking
 * each installed reconciler in the fixed order. No-op on a lost/disposed context
 * or when nothing has been marked dirty since the last flush.
 * @internal
 */
export function applyNativeStates(engine: GLEngineContext): void {
    const s = engine._state;
    if (engine._isLost || engine._disposed || !s.statesDirty) {
        return;
    }
    if (s._flushBlend !== undefined) {
        s._flushBlend(engine);
    }
    if (s._flushDepthCull !== undefined) {
        s._flushDepthCull(engine);
    }
    if (s._flushStencil !== undefined) {
        s._flushStencil(engine);
    }
    if (s._flushColorMask !== undefined) {
        s._flushColorMask(engine);
    }
    s.statesDirty = false;
}
