import type { ShadowGenerator } from "./shadow-generator.js";

/**
 * Whether the generator's shadow pass is prepared for the caster set last supplied through
 * `setShadowTaskCasterMeshes()` at runtime.
 *
 * The material views of new caster families are imported asynchronously. Until they land the shadow
 * map is not rendered, so receivers sample a stale or empty map. An on-demand renderer can skip
 * frames while this is `false`. It stays `false` after a failed preparation; use
 * {@link whenShadowGeneratorReady} to observe the failure.
 *
 * Does not replace awaiting `registerSceneWithShadowSupport()`: casters supplied before registration
 * are prepared by it, and are reported ready before then.
 */
export function isShadowGeneratorReady(shadowGenerator: ShadowGenerator): boolean {
    return !shadowGenerator._preloadPending;
}

/**
 * Resolves once {@link isShadowGeneratorReady} is `true`. A caster set supplied while waiting
 * supersedes the awaited one, and the promise then follows the newer set. Rejects with the import
 * error when the preparation of the latest set fails; the generator then stays skipped.
 *
 * Does not replace awaiting `registerSceneWithShadowSupport()` (see {@link isShadowGeneratorReady}).
 */
export async function whenShadowGeneratorReady(shadowGenerator: ShadowGenerator): Promise<void> {
    while (shadowGenerator._preloadPending) {
        const ready = shadowGenerator._preloadReady;
        const change = nextPreloadChange(shadowGenerator);
        try {
            await (ready ? Promise.race([ready, change]) : change);
        } catch (error) {
            // Only the active preparation's failure is reported; a superseded one's is not.
            if (shadowGenerator._preloadReady === ready && shadowGenerator._preloadPending) {
                throw error;
            }
        }
    }
}

/** Settles when the scheduler starts a new preparation, shared by every waiter of the generator. */
function nextPreloadChange(shadowGenerator: ShadowGenerator): Promise<void> {
    return (shadowGenerator._preloadChange ??= new Promise<void>((resolve) => {
        shadowGenerator._onPreloadChange = (): void => {
            shadowGenerator._preloadChange = shadowGenerator._onPreloadChange = undefined;
            resolve();
        };
    }));
}
