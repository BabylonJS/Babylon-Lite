import type { NpeTextureContent, NpeTextureValue } from "./npe-value.js";

/** Decode and cache the CPU RGBA content of a texture-valued NPE source. */
export function loadNpeTextureContent(source: NpeTextureValue): Promise<NpeTextureContent | null> {
    if (!source._content) {
        source._content = source.url ? decodeTexture(source) : Promise.resolve(null);
    }
    return source._content;
}

async function decodeTexture(source: NpeTextureValue): Promise<NpeTextureContent> {
    const response = await fetch(source.url);
    if (!response.ok) {
        throw new Error(`NodeParticle: failed to load texture "${source.url}"`);
    }
    const bitmap = await createImageBitmap(await response.blob(), {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
    });

    try {
        let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (typeof OffscreenCanvas !== "undefined") {
            context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d", { willReadFrequently: true });
        } else {
            const canvas = document.createElement("canvas");
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            context = canvas.getContext("2d", { willReadFrequently: true });
        }
        if (!context) {
            throw new Error("NodeParticle: unable to decode texture content");
        }

        if (source.invertY) {
            context.setTransform(1, 0, 0, -1, 0, bitmap.height);
        }
        context.drawImage(bitmap, 0, 0);
        const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        return { width: bitmap.width, height: bitmap.height, data };
    } finally {
        bitmap.close();
    }
}
