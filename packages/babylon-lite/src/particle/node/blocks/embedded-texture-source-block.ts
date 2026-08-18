import { loadTexture2D } from "../../../texture/texture-2d.js";
import type { NpeBlockEvaluator } from "../npe-build.js";

/**
 * Load an ordinary particle texture from its serialized URL or embedded data URL.
 * This intentionally mirrors the base evaluator without importing it so specialized runtimes do not pull in or fetch that evaluator.
 */
export const embeddedParticleTextureSourceBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const serializedUrl = typeof block.serialized.url === "string" ? block.serialized.url : "";
        const embeddedUrl = typeof block.serialized.textureDataUrl === "string" ? block.serialized.textureDataUrl : "";
        const rawUrl = serializedUrl || embeddedUrl;
        const base = ctx.state.textureBaseUrl;
        const isAbsolute = /^(https?:)?\/\//.test(rawUrl) || rawUrl.startsWith("/");
        const url = rawUrl && base && !isAbsolute ? new URL(rawUrl, base).href : rawUrl;
        const blockInvertY = block.serialized.invertY !== false;
        const state = ctx.state;

        if (url) {
            ctx.addBuildPromise(
                (async () => {
                    try {
                        state.system!.texture = await loadTexture2D(ctx.engine, url, { invertY: !blockInvertY });
                    } catch {
                        // Texture failures do not prevent CPU simulation; billboard creation still requires a texture.
                    }
                })()
            );
        }
    },
};
