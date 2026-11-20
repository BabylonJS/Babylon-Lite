import type { NpeBlockEvaluator } from "../npe-build.js";
import type { NpeGetter, NpeTextureValue } from "../npe-value.js";

/**
 * `ParticleTextureSourceBlock` — publishes a static texture descriptor on its `texture` output. Consumers own
 * the loading: `SystemBlock` uploads it for rendering and CPU texture updates decode its pixels. As in Babylon.js
 * deserialization, an embedded data URL wins over the serialized URL. Relative URLs use the build's texture base URL.
 */
export const npeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const { url: serializedUrl, textureDataUrl, invertY } = block.serialized;
        const rawUrl = (typeof textureDataUrl === "string" && textureDataUrl) || (typeof serializedUrl === "string" && serializedUrl) || "";
        const base = ctx.state.textureBaseUrl;
        const url = rawUrl && base && !/^(https?:)?\/\//.test(rawUrl) && !rawUrl.startsWith("/") ? new URL(rawUrl, base).href : rawUrl;
        const value: NpeTextureValue = { url, invertY: invertY !== false };
        ctx.setOutput(block.id, "texture", (() => value) as unknown as NpeGetter);
    },
};
