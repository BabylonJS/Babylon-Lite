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
        const { url: serializedUrl, textureDataUrl, invertY } = block.serialized;
        const rawUrl = (typeof serializedUrl === "string" && serializedUrl) || (typeof textureDataUrl === "string" && textureDataUrl) || "";
        const state = ctx.state;
        const base = state.textureBaseUrl;
        const url = rawUrl && base && !/^(https?:)?\/\//.test(rawUrl) && !rawUrl.startsWith("/") ? new URL(rawUrl, base).href : rawUrl;
        // Babylon.js's ParticleTextureSourceBlock.invertY defaults to true; the billboard renderer samples V
        // opposite to the BJS particle shader, so upload with the opposite flip to land on the same pixels.

        if (url) {
            ctx.addBuildPromise(
                (async () => {
                    try {
                        state.system!.texture = await loadTexture2D(ctx.engine, url, { invertY: invertY === false });
                    } catch {
                        // Texture failures do not prevent CPU simulation; billboard creation still requires a texture.
                    }
                })()
            );
        }
    },
};
