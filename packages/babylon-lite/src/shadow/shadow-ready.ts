import type { ShadowGenerator } from "./shadow-generator.js";

/**
 * Whether the generator's shadow pass is prepared for the caster set last supplied through
 * `setShadowTaskCasterMeshes()` (or at scene registration).
 *
 * The material views of new caster families are imported asynchronously. Until they land the shadow
 * map is not rendered, so receivers sample a stale or empty map. An on-demand renderer can skip
 * frames while this is `false`. It stays `false` after a failed preparation; use
 * {@link whenShadowGeneratorReady} to observe the failure.
 */
export function isShadowGeneratorReady(shadowGenerator: ShadowGenerator): boolean {
    return !shadowGenerator._preloadPending;
}

/**
 * Resolves once {@link isShadowGeneratorReady} is `true`. A caster set supplied while waiting
 * supersedes the awaited one, and the promise then waits for the newer set. Rejects with the import
 * error when the preparation of the latest set fails; the generator then stays skipped.
 */
export async function whenShadowGeneratorReady(shadowGenerator: ShadowGenerator): Promise<void> {
    let pending = shadowGenerator._preloadPending;
    while (pending) {
        try {
            await shadowGenerator._preloadReady;
        } catch (error) {
            if (shadowGenerator._preloadPending === pending) {
                throw error;
            }
        }
        // A successful preparation lifts the park, unless a newer set replaced it meanwhile.
        pending = shadowGenerator._preloadPending;
    }
}
