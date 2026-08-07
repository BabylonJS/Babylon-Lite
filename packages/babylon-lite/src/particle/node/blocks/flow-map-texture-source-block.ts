import type { NpeBlockEvaluator } from "../npe-build.js";
import type { NpeTextureValue } from "../npe-value.js";

/** Publish a CPU-readable texture value only when a texture source feeds a flow-map update. */
export const flowMapTextureSourceBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const textureDataUrl = typeof block.serialized.textureDataUrl === "string" ? block.serialized.textureDataUrl : "";
        const rawUrl = textureDataUrl || (typeof block.serialized.url === "string" ? block.serialized.url : "");
        const base = ctx.state.textureBaseUrl;
        const isAbsolute = /^(https?:)?\/\//.test(rawUrl) || rawUrl.startsWith("/");
        const url = /^(?!https?:|data:|blob:)[a-z][a-z\d+.-]*:/i.test(rawUrl) ? "" : rawUrl && base && !isAbsolute ? new URL(rawUrl, base).href : rawUrl;
        const value: NpeTextureValue = { url, invertY: block.serialized.invertY !== false };
        ctx.setOutput(block.id, "texture", () => value);
    },
};
