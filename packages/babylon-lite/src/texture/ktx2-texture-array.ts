/** Build a `Texture2DArray` from a single multi-layer KTX2 (Basis Universal) container.
 *
 *  Kept in its own file (imported only by the public barrel and the compat layer) so
 *  the array-decode glue is fully tree-shaken from scenes that never call it — the
 *  `.basis`/glTF `KHR_texture_basisu` paths pull in `ktx2-loader.ts` directly, not this
 *  module. The shared decoder handle and `setKtx2DecoderUrl` self-host state are reused
 *  from `ktx2-loader.ts` (never duplicated), so a single decoder configuration governs
 *  both the single-texture and array paths.
 */

import { U8 } from "../engine/typed-arrays.js";
import type { EngineContext } from "../engine/engine.js";
import { createTexture2DArrayFromPixels } from "./texture-array.js";
import type { Texture2DArray } from "./texture-array.js";
import { loadKtx2Decoder, RGBA_CAPS } from "./ktx2-loader.js";

/** Options for {@link createTexture2DArrayFromKtx2}. */
export interface Ktx2TextureArrayOptions {
    /** Generate a full mip chain for each layer on upload. Default true. */
    generateMipMaps?: boolean;
    /** Use sRGB sampling (rgba8unorm-srgb) for color/albedo layers. Default false. */
    srgb?: boolean;
    /** Mark the unflipped upload for V inversion at sampling time. Default false. */
    invertY?: boolean;
    /** Minification filter. Default linear. */
    minFilter?: GPUFilterMode;
    /** Magnification filter. Default linear. */
    magFilter?: GPUFilterMode;
    /** Mipmap filter. Defaults to linear when mipmaps are generated. */
    mipmapFilter?: GPUMipmapFilterMode;
}

/**
 * Decode a single KTX2 file that stores several array layers (`layerCount` \> 1) and
 * upload it as one `Texture2DArray`. The single-file counterpart to
 * {@link createTexture2DArrayFromUrls}: the whole array travels in one container.
 *
 * The data is transcoded to uncompressed RGBA8 (`forceRGBA`), so the GPU cost matches
 * a plain RGBA array texture. Only the base mip level from the file is uploaded; when
 * `generateMipMaps` is on, the remaining levels are regenerated on upload.
 *
 * The decoder orders mipmaps level-by-level and, within a level, layer-by-layer, so the
 * base level occupies the first `layerCount` entries in ascending layer order — matched
 * by slicing `mipmaps[0 .. layerCount)` and concatenating each layer back-to-back into
 * the single flat buffer `createTexture2DArrayFromPixels` expects.
 */
export async function createTexture2DArrayFromKtx2(engine: EngineContext, buffer: ArrayBuffer | ArrayBufferView, options: Ktx2TextureArrayOptions = {}): Promise<Texture2DArray> {
    const bytes = buffer instanceof ArrayBuffer ? new U8(buffer) : new U8(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const decoder = await loadKtx2Decoder();
    const decoded = await decoder.decode(bytes, RGBA_CAPS, { forceRGBA: true });
    if (decoded.errors) {
        throw new Error(`KTX2: ${decoded.errors}`);
    }
    if (!decoded.mipmaps.length) {
        throw new Error("KTX2: decoder produced no mipmaps");
    }

    const layerCount = Math.max(decoded.layerCount ?? 1, 1);
    const baseLevel = decoded.mipmaps.slice(0, layerCount);
    if (baseLevel.length !== layerCount) {
        throw new Error(`KTX2: expected ${layerCount} base-level layers but decoded ${baseLevel.length}`);
    }

    const { width, height } = baseLevel[0]!;
    const layerBytes = width * height * 4;
    const flat = new U8(layerBytes * layerCount);
    for (let i = 0; i < layerCount; i++) {
        const mip = baseLevel[i]!;
        if (!mip.data || mip.width !== width || mip.height !== height || mip.data.byteLength !== layerBytes) {
            throw new Error(`KTX2: base-level layer ${i} is malformed (expected ${width}x${height}, ${layerBytes} bytes)`);
        }
        flat.set(mip.data, i * layerBytes);
    }

    const texture = createTexture2DArrayFromPixels(engine, flat, width, height, layerCount, {
        mipMaps: options.generateMipMaps ?? true,
        srgb: options.srgb ?? false,
        minFilter: options.minFilter ?? "linear",
        magFilter: options.magFilter ?? "linear",
        mipmapFilter: options.mipmapFilter ?? ((options.generateMipMaps ?? true) ? "linear" : "nearest"),
    });
    texture.invertY = options.invertY ?? false;
    return texture;
}
