/** KTX2/Basis Universal decoder for glTF KHR_texture_basisu.
 *
 *  Kept separate from `basis-loader.ts` so existing `.basis` texture scenes do
 *  not pay for KTX2 decoder glue. The CDN decoder is still fetched lazily only
 *  after an asset declares KHR_texture_basisu.
 */

import { U8C, U8 } from "../engine/typed-arrays.js";
import { TU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { acquireTexture, getOrCreateSampler } from "../resource/gpu-pool.js";
import type { Texture2D } from "./texture-2d.js";
import { getCompressedFormat } from "./compressed-formats.js";
import type { CompressedFormatInfo } from "./compressed-formats.js";

interface Ktx2DecoderCaps {
    astc: boolean;
    bptc: boolean;
    s3tc: boolean;
    pvrtc: boolean;
    etc2: boolean;
    etc1: boolean;
}

interface Ktx2DecodedMip {
    width: number;
    height: number;
    data: Uint8Array;
}

interface Ktx2DecodedData {
    width: number;
    height: number;
    transcodedFormat: number;
    isInGammaSpace: boolean;
    hasAlpha: boolean;
    transcoderName: string;
    errors?: string;
    mipmaps: Ktx2DecodedMip[];
}

interface Ktx2Decoder {
    decode(data: Uint8Array, caps: Ktx2DecoderCaps, options?: { forceRGBA?: boolean }): Promise<Ktx2DecodedData>;
}

interface Ktx2DecoderModule {
    KTX2Decoder: new () => Ktx2Decoder;
    MSCTranscoder: { UseFromWorkerThread: boolean };
    WASMMemoryManager: { LoadBinariesFromCurrentThread: boolean };
}

// Public URL of the KTX2/Basis decoder script (default: the Babylon CDN). Override via
// `setKtx2DecoderUrl()` to self-host the decoder (e.g. to avoid the cross-origin CDN dependency).
let _ktx2DecoderUrl = "https://cdn.babylonjs.com/babylon.ktx2Decoder.js";
// Optional overrides for the WASM/JS modules the decoder pulls after it loads (keyed by the property
// name on the matching KTX2DECODER transcoder, e.g. MSCTranscoder→{JSModuleURL,WASMModuleURL},
// ZSTDDecoder→{WASMModuleURL}, LiteTranscoder_*→{WASMModuleURL}). Needed to FULLY self-host — the
// decoder otherwise fetches these from the CDN regardless of the script URL above.
let _ktx2WasmUrls: Record<string, Record<string, string>> | null = null;

/** Override the URL of the KTX2/Basis decoder script (and, optionally, the URLs of the WASM/JS transcoder
 *  modules it pulls). Call before the first KHR_texture_basisu texture loads. */
export function setKtx2DecoderUrl(url: string, wasmUrls?: Record<string, Record<string, string>>): void {
    _ktx2DecoderUrl = url;
    _ktx2WasmUrls = wasmUrls ?? null;
}
let _ktx2DecoderPromise: Promise<Ktx2Decoder> | null = null;

const GL_RGBA8 = 0x8058;
const GL_R8 = 0x8229;
const GL_RG8 = 0x822b;
const RGBA_CAPS: Ktx2DecoderCaps = { astc: false, bptc: false, s3tc: false, pvrtc: false, etc2: false, etc1: false };

/** Build the decoder's transcode-target caps from the device's enabled compressed-texture features, so the
 *  Basis transcoder emits a GPU-compressed format (BC7/BC3/ETC2/ASTC) instead of uncompressed RGBA8 — a few
 *  times less data to upload (writeTexture) and to keep resident in VRAM. Mirrors basis-loader.ts's format
 *  selection. Falls back to RGBA8 automatically on devices without any compression feature (all caps false).
 *  PVRTC is intentionally false (WebGPU does not expose it). */
function deviceKtx2Caps(engine: EngineContext): Ktx2DecoderCaps {
    const f = engine._device.features;
    const bc = f.has("texture-compression-bc"); // BC1–BC7 (S3TC/DXT + BPTC)
    const etc2 = f.has("texture-compression-etc2");
    return {
        astc: f.has("texture-compression-astc"),
        bptc: bc, // BC6H/BC7
        s3tc: bc, // BC1/BC2/BC3
        pvrtc: false, // unsupported on WebGPU
        etc2,
        etc1: etc2, // ETC1 content transcodes on ETC2-capable GPUs
    };
}

function loadKtx2Decoder(): Promise<Ktx2Decoder> {
    if (_ktx2DecoderPromise) {
        return _ktx2DecoderPromise;
    }
    _ktx2DecoderPromise = new Promise<Ktx2Decoder>((resolve, reject) => {
        const w = globalThis as unknown as { KTX2DECODER?: Ktx2DecoderModule };
        const init = (): void => {
            const mod = w.KTX2DECODER;
            if (!mod) {
                reject(new Error("KTX2: decoder global KTX2DECODER not found after script load"));
                return;
            }
            mod.MSCTranscoder.UseFromWorkerThread = false;
            mod.WASMMemoryManager.LoadBinariesFromCurrentThread = true;
            // Redirect the decoder's WASM/JS module fetches to self-hosted copies, if configured. Each key
            // names a transcoder on the module (MSCTranscoder, ZSTDDecoder, LiteTranscoder_*); set props
            // that exist (JSModuleURL/WASMModuleURL) and ignore the rest, so it survives decoder updates.
            if (_ktx2WasmUrls) {
                const m = mod as unknown as Record<string, Record<string, string> | undefined>;
                for (const tName of Object.keys(_ktx2WasmUrls)) {
                    const t = m[tName];
                    if (t) {
                        for (const prop of Object.keys(_ktx2WasmUrls[tName]!)) {
                            t[prop] = _ktx2WasmUrls[tName]![prop]!;
                        }
                    }
                }
            }
            resolve(new mod.KTX2Decoder());
        };
        if (w.KTX2DECODER) {
            init();
            return;
        }
        const script = document.createElement("script");
        script.src = _ktx2DecoderUrl;
        script.async = true;
        script.onload = init;
        script.onerror = (): void => reject(new Error(`KTX2: failed to load ${script.src}`));
        document.head.appendChild(script);
    });
    _ktx2DecoderPromise.catch(() => {
        _ktx2DecoderPromise = null;
    });
    return _ktx2DecoderPromise;
}

function srgbFormat(format: GPUTextureFormat): GPUTextureFormat {
    switch (format) {
        case "rgba8unorm":
            return "rgba8unorm-srgb";
        case "bc1-rgba-unorm":
            return "bc1-rgba-unorm-srgb";
        case "bc2-rgba-unorm":
            return "bc2-rgba-unorm-srgb";
        case "bc3-rgba-unorm":
            return "bc3-rgba-unorm-srgb";
        case "bc7-rgba-unorm":
            return "bc7-rgba-unorm-srgb";
        case "etc2-rgb8unorm":
            return "etc2-rgb8unorm-srgb";
        case "etc2-rgb8a1unorm":
            return "etc2-rgb8a1unorm-srgb";
        case "etc2-rgba8unorm":
            return "etc2-rgba8unorm-srgb";
        case "astc-4x4-unorm":
            return "astc-4x4-unorm-srgb";
        case "astc-5x4-unorm":
            return "astc-5x4-unorm-srgb";
        case "astc-5x5-unorm":
            return "astc-5x5-unorm-srgb";
        case "astc-6x5-unorm":
            return "astc-6x5-unorm-srgb";
        case "astc-6x6-unorm":
            return "astc-6x6-unorm-srgb";
        case "astc-8x5-unorm":
            return "astc-8x5-unorm-srgb";
        case "astc-8x6-unorm":
            return "astc-8x6-unorm-srgb";
        case "astc-8x8-unorm":
            return "astc-8x8-unorm-srgb";
        case "astc-10x5-unorm":
            return "astc-10x5-unorm-srgb";
        case "astc-10x6-unorm":
            return "astc-10x6-unorm-srgb";
        case "astc-10x8-unorm":
            return "astc-10x8-unorm-srgb";
        case "astc-10x10-unorm":
            return "astc-10x10-unorm-srgb";
        case "astc-12x10-unorm":
            return "astc-12x10-unorm-srgb";
        case "astc-12x12-unorm":
            return "astc-12x12-unorm-srgb";
        default:
            return format;
    }
}

function uncompressedInfo(glFormat: number): { format: GPUTextureFormat; bytesPerPixel: number } | null {
    switch (glFormat) {
        case GL_RGBA8:
            return { format: "rgba8unorm", bytesPerPixel: 4 };
        case GL_R8:
            return { format: "r8unorm", bytesPerPixel: 1 };
        case GL_RG8:
            return { format: "rg8unorm", bytesPerPixel: 2 };
        default:
            return null;
    }
}

function validateDecoded(decoded: Ktx2DecodedData): Ktx2DecodedMip[] {
    if (decoded.errors) {
        throw new Error(`KTX2: ${decoded.errors}`);
    }
    if (!decoded.mipmaps.length) {
        throw new Error("KTX2: decoder produced no mipmaps");
    }
    for (let i = 0; i < decoded.mipmaps.length; i++) {
        if (!decoded.mipmaps[i]?.data) {
            throw new Error(`KTX2: decoder produced an empty mip ${i}`);
        }
    }
    return decoded.mipmaps;
}

function makeSampler(engine: EngineContext, mipCount: number): GPUSampler {
    return getOrCreateSampler(engine, {
        addressModeU: "repeat",
        addressModeV: "repeat",
        minFilter: "linear",
        magFilter: "linear",
        mipmapFilter: mipCount > 1 ? "linear" : "nearest",
        maxAnisotropy: mipCount > 1 ? 4 : 1,
    });
}

function uploadCompressed(engine: EngineContext, mips: Ktx2DecodedMip[], format: CompressedFormatInfo, sRGB: boolean): Texture2D {
    if (!engine._device.features.has(format.feature as GPUFeatureName)) {
        throw new Error(`KTX2: device does not support ${format.feature}`);
    }
    const width = mips[0]!.width;
    const height = mips[0]!.height;
    const texture = engine._device.createTexture({
        size: { width, height },
        format: sRGB ? srgbFormat(format.gpuFormat) : format.gpuFormat,
        mipLevelCount: mips.length,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST,
    });
    for (let level = 0; level < mips.length; level++) {
        const mip = mips[level]!;
        const blocksPerRow = Math.ceil(mip.width / format.blockW);
        const rowBytes = blocksPerRow * format.blockBytes;
        // Copy extent must be block-padded (physical) size; tail mips smaller
        // than the block are copied as one full block (see ktx-loader.ts).
        const copyW = blocksPerRow * format.blockW;
        const copyH = Math.ceil(mip.height / format.blockH) * format.blockH;
        engine._device.queue.writeTexture({ texture, mipLevel: level }, mip.data as Uint8Array<ArrayBuffer>, { bytesPerRow: rowBytes }, { width: copyW, height: copyH });
    }
    const tex2d: Texture2D = { texture, view: texture.createView(), sampler: makeSampler(engine, mips.length), width, height, invertY: true };
    acquireTexture(tex2d);
    return tex2d;
}

function uploadUncompressed(engine: EngineContext, mips: Ktx2DecodedMip[], info: { format: GPUTextureFormat; bytesPerPixel: number }, sRGB: boolean): Texture2D {
    const width = mips[0]!.width;
    const height = mips[0]!.height;
    const texture = engine._device.createTexture({
        size: { width, height },
        format: sRGB ? srgbFormat(info.format) : info.format,
        mipLevelCount: mips.length,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST,
    });
    for (let level = 0; level < mips.length; level++) {
        const mip = mips[level]!;
        const expected = mip.width * mip.height * info.bytesPerPixel;
        if (mip.data.length !== expected) {
            throw new Error(`KTX2: uncompressed mip ${level} has ${mip.data.length} bytes, expected ${expected}`);
        }
        engine._device.queue.writeTexture(
            { texture, mipLevel: level },
            mip.data as Uint8Array<ArrayBuffer>,
            { bytesPerRow: mip.width * info.bytesPerPixel },
            { width: mip.width, height: mip.height }
        );
    }
    const tex2d: Texture2D = { texture, view: texture.createView(), sampler: makeSampler(engine, mips.length), width, height, invertY: true };
    acquireTexture(tex2d);
    return tex2d;
}

/** Decode a KTX2 texture with the current WebGPU compression caps and upload the
 *  decoder-provided full mip chain directly to a Texture2D. */
export async function uploadKtx2Texture2D(engine: EngineContext, buffer: ArrayBuffer, sRGB: boolean): Promise<Texture2D> {
    const decoder = await loadKtx2Decoder();
    // Transcode to the best GPU-supported compressed format (or RGBA8 on devices without one). The compressed
    // path below uploads a few times less data than uncompressed RGBA8 and keeps the texture compressed in VRAM.
    const decoded = await decoder.decode(new U8(buffer), deviceKtx2Caps(engine));
    const mips = validateDecoded(decoded);

    const compressed = getCompressedFormat(decoded.transcodedFormat);
    if (compressed) {
        return uploadCompressed(engine, mips, compressed, sRGB);
    }

    const uncompressed = uncompressedInfo(decoded.transcodedFormat);
    if (uncompressed) {
        return uploadUncompressed(engine, mips, uncompressed, sRGB);
    }

    throw new Error(`KTX2: unsupported transcoded format 0x${decoded.transcodedFormat.toString(16)}`);
}

/** Decode the first mip level of a KTX2 texture into an ImageBitmap so glTF
 *  material extensions can reuse the core image upload path. */
export async function decodeKtx2ImageBitmapFromBuffer(buffer: ArrayBuffer): Promise<ImageBitmap> {
    const decoder = await loadKtx2Decoder();
    const decoded = await decoder.decode(new U8(buffer), RGBA_CAPS, { forceRGBA: true });
    const mip0 = validateDecoded(decoded)[0]!;
    if (mip0.data.length !== mip0.width * mip0.height * 4) {
        throw new Error("KTX2: RGBA decode size does not match image dimensions");
    }
    const pixels = new U8C(mip0.data.length);
    pixels.set(mip0.data);
    return createImageBitmap(new ImageData(pixels, mip0.width, mip0.height));
}
