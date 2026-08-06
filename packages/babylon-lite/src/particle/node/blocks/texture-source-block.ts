import { loadTexture2D } from "../../../texture/texture-2d.js";
import type { NpeBlockEvaluator } from "../npe-build.js";
import type { NpeTextureValue } from "../npe-value.js";

/**
 * `ParticleTextureSourceBlock` — exposes a texture value and loads the source connected to the system's
 * texture input for billboard rendering. Other sources remain CPU-only until consumed by a texture update.
 */
export const particleTextureSourceBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const textureDataUrl = typeof block.serialized.textureDataUrl === "string" ? block.serialized.textureDataUrl : "";
        const rawUrl = textureDataUrl || (typeof block.serialized.url === "string" ? block.serialized.url : "");
        const base = ctx.state.textureBaseUrl;
        const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(rawUrl) || rawUrl.startsWith("//") || rawUrl.startsWith("/");
        const url = rawUrl && base && !isAbsolute ? new URL(rawUrl, base).href : rawUrl;
        // Babylon.js's ParticleTextureSourceBlock.invertY defaults to true; the billboard renderer samples V
        // opposite to the BJS particle shader, so upload with the opposite flip to land on the same pixels.
        const blockInvertY = block.serialized.invertY !== false;
        const value: NpeTextureValue = { url, invertY: blockInvertY };
        ctx.setOutput(block.id, "texture", () => value);

        if (url && block.id === ctx.state.billboardTextureBlockId) {
            ctx.addBuildPromise(
                (async () => {
                    try {
                        ctx.state.system!.texture = await loadTexture2D(ctx.engine, url, { invertY: !blockInvertY });
                    } catch {
                        // Texture failures do not prevent CPU simulation; billboard creation still requires a texture.
                    }
                })()
            );
        }
    },
};
