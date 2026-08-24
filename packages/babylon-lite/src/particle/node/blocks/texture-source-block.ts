import { loadTexture2D } from "../../../texture/texture-2d.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/**
 * `ParticleTextureSourceBlock` — loads the particle texture from its serialized URL or embedded data URL
 * and binds it onto the system for the billboard renderer. The load is registered as a build promise so the
 * set is only ready once it settles. Relative URLs use the build's texture base URL.
 */
export const particleTextureSourceBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const { url: serializedUrl, textureDataUrl, invertY } = block.serialized;
        const rawUrl = (typeof serializedUrl === "string" && serializedUrl) || (typeof textureDataUrl === "string" && textureDataUrl) || "";
        const state = ctx.state;
        const base = state.textureBaseUrl;
        const url = rawUrl && base && !/^(https?:)?\/\//.test(rawUrl) && !rawUrl.startsWith("/") ? new URL(rawUrl, base).href : rawUrl;

        if (url) {
            ctx.addBuildPromise(
                (async () => {
                    try {
                        // Block invertY defaults to true; Lite's opposite billboard V convention maps false to an upload flip.
                        state.system!.texture = await loadTexture2D(ctx.engine, url, { invertY: invertY === false });
                    } catch {
                        // Texture failures do not prevent CPU simulation; billboard creation still requires a texture.
                    }
                })()
            );
        }
    },
};
