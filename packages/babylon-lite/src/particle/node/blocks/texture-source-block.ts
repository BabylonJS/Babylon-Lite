import type { NpeBlockEvaluator } from "../npe-build.js";

/**
 * `ParticleTextureSourceBlock` — publishes a static texture descriptor on its `texture` output. Consumers own
 * the loading: `SystemBlock` uploads it for rendering and CPU texture updates decode its pixels. As in Babylon.js
 * deserialization, an embedded data URL wins over the serialized URL and an omitted `invertY` is false (the class
 * default of true applies only to editor-created blocks). Relative URLs use the build's texture base URL.
 */
export const npeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const { url: serializedUrl, textureDataUrl, invertY } = block.serialized;
        const rawUrl = (typeof textureDataUrl === "string" && textureDataUrl) || (typeof serializedUrl === "string" && serializedUrl) || "";
        const base = ctx.state.textureBaseUrl;
        const url = rawUrl && base && !/^(https?:)?\/\//.test(rawUrl) && !rawUrl.startsWith("/") ? new URL(rawUrl, base).href : rawUrl;
        ctx.setTexture(block.id, "texture", { url, invertY: !!invertY });
    },
};
