import type { GLEngineContext } from "../../context.js";
import { createRawTexture, disposeTexture, updateRawTexture } from "../../texture.js";
import type { GLTexture } from "../../texture.js";
import { GLYPH_METADATA_FLOATS, TEX_WIDTH } from "../glyph-storage.js";
import type { SharedAtlas, SharedAtlasGpu } from "../glyph-storage.js";

/** @internal Lookup textures replace the WebGPU metadata/style storage buffers. */
export const TABLE_WIDTH = 256;

/** @internal Pad a lookup table to complete rows, retaining its existing allocation. */
export function packTable(source: Float32Array, floatCount: number, previous?: Float32Array): Float32Array {
    const length = Math.max(1, Math.ceil(floatCount / (TABLE_WIDTH * 4))) * TABLE_WIDTH * 4;
    const pixels = previous && previous.length >= length ? previous : new Float32Array(length);
    pixels.set(source.subarray(0, floatCount));
    return pixels;
}

function checkSize(engine: GLEngineContext, width: number, height: number): void {
    if (width > engine.caps.maxTextureSize || height > engine.caps.maxTextureSize) {
        throw new Error(`lite-gl: text texture ${width}x${height} exceeds MAX_TEXTURE_SIZE ${engine.caps.maxTextureSize}.`);
    }
}

/** @internal Numeric tables use nearest-only RG uint or RGBA float texels. */
export function createTextTexture(engine: GLEngineContext, pixels: Float32Array | Uint32Array, width: number, height: number): GLTexture {
    checkSize(engine, width, height);
    const gl = engine.gl;
    const integer = pixels instanceof Uint32Array;
    return createRawTexture(engine, pixels, width, height, integer ? gl.RG_INTEGER : gl.RGBA, integer ? gl.UNSIGNED_INT : gl.FLOAT, {
        internalFormat: integer ? gl.RG32UI : gl.RGBA32F,
        minFilter: gl.NEAREST,
        magFilter: gl.NEAREST,
    });
}

/** @internal Preserve the texture object and its context-restore upload source. */
export function uploadTextTexture(engine: GLEngineContext, texture: GLTexture, pixels: Float32Array | Uint32Array, width: number, height: number): void {
    checkSize(engine, width, height);
    updateRawTexture(engine, texture, pixels, { width, height });
}

/** @internal Atlas resources are shared by every block using the same curve set. */
export function ensureSharedAtlasGpu(engine: GLEngineContext, atlas: SharedAtlas): SharedAtlasGpu {
    let gpu = atlas._gpu;
    if (gpu) {
        if (gpu._engine !== engine) {
            throw new Error("lite-gl: a glyph storage cannot be drawn on multiple engines. Create a separate storage for each engine.");
        }
        if (gpu._uploadedVersion === atlas._version) {
            return gpu;
        }
    }
    const curveRows = Math.max(1, Math.ceil(atlas._curveTexelsUsed / TEX_WIDTH));
    const bandRows = Math.max(1, Math.ceil(atlas._bandTexelsUsed / TEX_WIDTH));
    checkSize(engine, TEX_WIDTH, Math.max(curveRows, bandRows));
    const metaPixels = packTable(atlas._metaData, atlas._slotCount * GLYPH_METADATA_FLOATS, gpu?._metaPixels);
    const metaRows = metaPixels.length / (TABLE_WIDTH * 4);
    checkSize(engine, TABLE_WIDTH, metaRows);

    if (!gpu) {
        const textures: GLTexture[] = [];
        try {
            textures.push(createTextTexture(engine, atlas._curveTexData, TEX_WIDTH, curveRows));
            textures.push(createTextTexture(engine, atlas._bandTexData, TEX_WIDTH, bandRows));
            textures.push(createTextTexture(engine, metaPixels, TABLE_WIDTH, metaRows));
            gpu = {
                _engine: engine,
                _curveTex: textures[0]!,
                _bandTex: textures[1]!,
                _metaTex: textures[2]!,
                _metaPixels: metaPixels,
                _uploadedVersion: atlas._version,
            };
            atlas._gpu = gpu;
        } catch (error) {
            for (const texture of textures) {
                disposeTexture(engine, texture);
            }
            throw error;
        }
    } else {
        uploadTextTexture(engine, gpu._curveTex, atlas._curveTexData, TEX_WIDTH, curveRows);
        uploadTextTexture(engine, gpu._bandTex, atlas._bandTexData, TEX_WIDTH, bandRows);
        uploadTextTexture(engine, gpu._metaTex, metaPixels, TABLE_WIDTH, metaRows);
        gpu._metaPixels = metaPixels;
        gpu._uploadedVersion = atlas._version;
    }
    return gpu;
}
