/**
 * XR feature mechanism — a tree-shakable alternative to Babylon.js's
 * `WebXRFeaturesManager`.
 *
 * Babylon.js registers every feature in a global string-keyed registry
 * (`WebXRFeaturesManager.AddWebXRFeature`), which forces bundlers to keep all
 * feature classes even when a scene uses none. Babylon Lite instead models a
 * feature as a plain-data **spec** the app imports explicitly and passes to
 * {@link enterXr}. Only the features you reference are pulled into the bundle;
 * unused ones are dead-code-eliminated (pillar 4b, GUIDANCE tree-shaking).
 *
 * A spec has two parts:
 *  - `sessionFeatures` — native WebXR feature descriptors the feature needs (e.g.
 *    `"hit-test"`, `"hand-tracking"`). `enterXr` folds these into the session's
 *    `optionalFeatures` *before* `requestSession`, because native features cannot
 *    be added once the session exists (the same constraint that made `local-floor`
 *    silently downgrade). Missing device support degrades to a graceful no-op.
 *  - `create` — instantiates the feature *after* the session + reference space +
 *    input manager exist, returning a live {@link XrFeatureHandle} the session
 *    drives each frame and disposes on exit.
 *
 * Nothing auto-enables: a feature runs only when the app passes its spec (or calls
 * {@link attachXrFeature}). This keeps non-XR — and feature-less XR — scenes at
 * zero cost.
 */

import type { XrSessionContext } from "./xr-session.js";

/**
 * A live feature instance bound to an active session. Returned by
 * {@link XrFeatureSpec.create}; the session owns its lifecycle.
 */
export interface XrFeatureHandle {
    /** Called once per `XRFrame`, after input poses are refreshed and the session's
     *  `onFrame` callback, before the eyes are rendered. Optional for passive features. */
    update?(frame: XRFrame, time: DOMHighResTimeStamp): void;
    /** Release any scene/GPU resources. Called when the session ends. */
    dispose?(): void;
}

/**
 * An opt-in XR feature. Implementations are free functions returning this spec
 * (e.g. `pointerSelection(options)`), so importing one never drags in the others.
 */
export interface XrFeatureSpec {
    /** Native WebXR session feature descriptors this feature requires, requested as
     *  *optional* features so a session still starts when the device lacks them. */
    readonly sessionFeatures?: readonly string[];
    /** Instantiate the feature against a fully-initialised session context. */
    create(ctx: XrSessionContext): XrFeatureHandle;
}

/**
 * Enable a feature on an already-running session at runtime (mirrors Babylon.js
 * `enableFeature`). The handle is driven and disposed by the session like any
 * feature passed to {@link enterXr}.
 *
 * Note: a session's native `requiredFeatures`/`optionalFeatures` are fixed at
 * `requestSession` time, so `spec.sessionFeatures` is **not** applied here — only
 * use `attachXrFeature` for features whose native descriptors were already granted
 * (or that need none, like pointer selection).
 *
 * @param ctx - The active session to attach to.
 * @param spec - The feature spec to instantiate.
 * @returns The live feature handle.
 */
export function attachXrFeature(ctx: XrSessionContext, spec: XrFeatureSpec): XrFeatureHandle {
    const handle = spec.create(ctx);
    ctx._features.push(handle);
    return handle;
}
