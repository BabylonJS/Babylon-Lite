/**
 * Deferred render-state flush dispatcher — the lite-gl counterpart of Babylon's
 * `Engine.applyStates()` (`_depthCullingState.apply` / `_alphaState.apply` /
 * `_stencilState.apply`).
 *
 * blend.ts and depth-stencil.ts setters record only the DESIRED state (the
 * `rs[RS_X + RS_DESIRED]` slots of {@link GLState.rs}), raise `statesDirty`, and
 * INSTALL their per-category reconciler onto a `_state._flush*` slot the first
 * time they run. {@link applyGLStates} then simply dispatches through whichever
 * slots are populated — it owns NO reconciliation code itself.
 *
 * Why a dispatcher (not a monolith): the reconcilers (`flushBlend` in blend.ts;
 * `flushDepthCull` / `flushStencil` / `flushColorMask` in depth-stencil.ts) are
 * reachable ONLY through the engine-state slots their setters populate, so a
 * category whose setter is absent from a scene tree-shakes its reconciler — and
 * its GL code — out of the bundle. A clear-only scene (e.g. `gl-scissor`) that
 * never touches blend/depth/stencil/color-mask therefore ships none of them;
 * `applyGLStates` collapses to four cheap "is it installed?" checks. The fixed
 * dispatch order (blend → depth+cull → stencil → color-mask) reproduces the
 * former monolith's GL call order exactly.
 *
 * Each reconciler still issues only the `gl.*` calls that actually change and
 * updates the actual slots in lock-step, so intra-frame churn collapses and
 * cross-frame elision is preserved, matching Babylon exactly.
 *
 * Flush sites (call `applyGLStates` immediately before the GPU op):
 *  - effect-renderer.ts `drawEffect`
 *  - sprites.ts `renderSprites`
 *  - mesh.ts `drawIndexed`
 *  - depth-stencil.ts `clearEngine` (clear respects the depth/stencil/color
 *    write masks, so they must be current first — Babylon parity)
 *
 * Kept dependency-light (type-only import of {@link GLEngineContext}) so it never
 * introduces an import cycle.
 */
import type { GLEngineContext } from "./context.js";

/**
 * Flush the deferred blend / depth+cull / stencil / color-mask state to GL by
 * invoking each installed per-category reconciler in order. No-op on a
 * lost/disposed context or when nothing has been marked dirty since the last
 * flush. Reconcilers are installed lazily by their setters, so an uninstalled
 * category is skipped at zero cost.
 *
 * @param engine - The engine whose deferred state is flushed.
 * @internal
 */
export function applyGLStates(engine: GLEngineContext): void {
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
