// Decodes Quake BSP embedded MIPTEX textures (8-bit palettized) into GPU
// textures, lazily and cached by miptex index. Texture pixels are converted to
// straight RGBA8 using the level palette.

import { createTexture2DFromPixels, type EngineContext, type Texture2D } from "babylon-lite";
import type { BspMipTex } from "../bsp/parse-bsp.js";
import { indicesToRgba, type Palette } from "../palette.js";

export interface QuakeTexture {
    texture: Texture2D;
    width: number;
    height: number;
}

export class QuakeTextureCache {
    private readonly cache = new Map<number, QuakeTexture | null>();
    private fallback: QuakeTexture | null = null;

    constructor(
        private readonly engine: EngineContext,
        private readonly mipTextures: BspMipTex[],
        private readonly palette: Palette
    ) {}

    /** Returns the decoded texture for a miptex index, or a magenta fallback. */
    get(miptex: number): QuakeTexture {
        const cached = this.cache.get(miptex);
        if (cached !== undefined) return cached ?? this.getFallback();

        const mt = this.mipTextures[miptex];
        let result: QuakeTexture | null = null;
        if (mt && mt.indices && mt.width > 0 && mt.height > 0) {
            const fence = mt.name.startsWith("{");
            const rgba = indicesToRgba(mt.indices, this.palette, fence);
            const texture = createTexture2DFromPixels(this.engine, rgba, mt.width, mt.height, {
                addressModeU: "repeat",
                addressModeV: "repeat",
                minFilter: "linear",
                magFilter: "linear",
            });
            result = { texture, width: mt.width, height: mt.height };
        }
        this.cache.set(miptex, result);
        return result ?? this.getFallback();
    }

    private getFallback(): QuakeTexture {
        if (this.fallback) return this.fallback;
        // 2x2 magenta/black checker so missing textures are obvious but harmless.
        const px = new Uint8Array([255, 0, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 255, 255]);
        const texture = createTexture2DFromPixels(this.engine, px, 2, 2, { addressModeU: "repeat", addressModeV: "repeat" });
        this.fallback = { texture, width: 2, height: 2 };
        return this.fallback;
    }
}
