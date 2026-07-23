import { loadTexture2D } from "../../../texture/texture-2d.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/**
 * `ParticleTextureSourceBlock` — loads the particle texture from its `url` and binds it onto the
 * system for the billboard renderer. The load is registered as a build promise so the set is only ready
 * once it settles. Relative URLs use the build's texture base URL, and the serialized invert-Y flag is
 * converted to the texture loader's upload convention.
 */
export const particleTextureSourceBlock: NpeBlockEvaluator = {
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
                        // Texture failures do not prevent CPU simulation; billboard creation still requires a texture.
                    }
                })()
            );
        }
    },
};
