import { loadTexture2D } from "../../../texture/texture-2d.js";
import type { SoaBlockEvaluator } from "../npe-build.js";

/**
 * `ParticleTextureSourceBlock` (SoA) — loads the particle texture from its `url` and binds it onto the
 * system for the billboard renderer. The load is registered as a build promise so the set is only ready
 * once it settles. Mirrors the object version's URL resolution and invert-Y handling.
 */
export const particleTextureSourceBlock: SoaBlockEvaluator = {
    build(block, ctx) {
        const rawUrl = typeof block.serialized.url === "string" ? block.serialized.url : "";
        const base = ctx.state.textureBaseUrl;
        const isAbsolute = /^(https?:)?\/\//.test(rawUrl) || rawUrl.startsWith("/");
        const url = rawUrl && base && !isAbsolute ? new URL(rawUrl, base).href : rawUrl;
        // Babylon.js's ParticleTextureSourceBlock.invertY defaults to true; the billboard renderer samples V
        // opposite to the BJS particle shader, so upload with the opposite flip to land on the same pixels.
        const blockInvertY = block.serialized.invertY !== false;
        const state = ctx.state;

        if (url) {
            ctx.addBuildPromise(
                (async () => {
                    try {
                        const texture = await loadTexture2D(ctx.engine, url, { invertY: !blockInvertY });
                        state.system!.texture = texture;
                    } catch {
                        // A failed texture load must not break the simulation; the particle renders untextured
                        // (and headless/CPU-only builds have no device at all).
                    }
                })()
            );
        }
    },
};
