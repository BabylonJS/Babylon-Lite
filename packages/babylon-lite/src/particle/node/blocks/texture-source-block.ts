import { loadTexture2D } from "../../../texture/texture-2d.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { ParticleBlockEvaluator } from "../npe-types.js";

/**
 * `ParticleTextureSourceBlock` — loads the particle texture from its `url` and exposes it on the `texture`
 * output. The load is registered as a build promise so the set is only considered ready once it settles.
 */
export const textureSourceBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const rawUrl = typeof block.serialized.url === "string" ? block.serialized.url : "";
        const base = ctx.state.textureBaseUrl;
        // Resolve relative URLs (e.g. "textures/flare.png") against the configured base, mirroring how
        // Babylon.js resolves a particle texture path against the scene's texture base.
        const isAbsolute = /^(https?:)?\/\//.test(rawUrl) || rawUrl.startsWith("/");
        const url = rawUrl && base && !isAbsolute ? new URL(rawUrl, base).href : rawUrl;
        const holder: { texture: Texture2D | null } = { texture: null };

        if (url) {
            ctx.addBuildPromise(
                (async () => {
                    try {
                        holder.texture = await loadTexture2D(ctx.engine, url);
                    } catch {
                        // A failed texture load must not break the simulation; the particle simply
                        // renders untextured (and headless/CPU-only builds have no device at all).
                        holder.texture = null;
                    }
                })()
            );
        }

        ctx.setOutput(block.id, "texture", () => holder.texture);
    },
};
