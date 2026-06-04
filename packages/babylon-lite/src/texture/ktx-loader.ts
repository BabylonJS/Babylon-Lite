/**
 * KTX1 compressed texture loader.
 *
 * Loads a KTX1 file, parses the header, uploads compressed mip data to the GPU.
 * Falls back to loadTexture2D (uncompressed) if the device doesn't support the
 * format or the fetch fails.
 *
 * Fully tree-shakable: only bundled when explicitly imported.
 */

import { acquireTexture, getOrCreateSampler } from "../resource/gpu-pool.js";
import type { EngineContext } from "../engine/engine.js";
import { loadTexture2D } from "./texture-2d.js";
import type { Texture2D, Texture2DOptions } from "./texture-2d.js";
import { getCompressedFormat, suffixToFeature } from "./compressed-formats.js";
import type { CompressedFormatInfo } from "./compressed-formats.js";

// ── KTX1 magic number ───────────────────────────────────────────────

const KTX_MAGIC = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── Internal types ──────────────────────────────────────────────────

interface KtxMipLevel {
    data: Uint8Array;
    width: number;
    height: number;
}

interface KtxParseResult {
    format: CompressedFormatInfo;
    width: number;
    height: number;
    mips: KtxMipLevel[];
}

// ── KTX1 parser ─────────────────────────────────────────────────────

function parseKtx1(buffer: ArrayBuffer): KtxParseResult {
    const bytes = new Uint8Array(buffer);
    if (buffer.byteLength < 64) {
        throw new Error("KTX: file too small");
    }

    // Validate magic
    for (let i = 0; i < 12; i++) {
        if (bytes[i] !== KTX_MAGIC[i]) {
            throw new Error("KTX: invalid magic");
        }
    }

    const view = new DataView(buffer);

    // Endianness check
    if (view.getUint32(12, true) !== 0x04030201) {
        throw new Error("KTX: unsupported endianness");
    }

    // Must be compressed (glType === 0 && glFormat === 0)
    if (view.getUint32(16, true) !== 0) {
        throw new Error("KTX: not a compressed texture (glType != 0)");
    }
    if (view.getUint32(24, true) !== 0) {
        throw new Error("KTX: not a compressed texture (glFormat != 0)");
    }

    const glInternalFormat = view.getUint32(28, true);
    const format = getCompressedFormat(glInternalFormat);
    if (!format) {
        throw new Error(`KTX: unknown glInternalFormat 0x${glInternalFormat.toString(16)}`);
    }

    const width = view.getUint32(36, true);
    const height = view.getUint32(40, true);
    const pixelDepth = view.getUint32(44, true);
    const numberOfArrayElements = view.getUint32(48, true);
    const numberOfFaces = view.getUint32(52, true);
    const numberOfMipmapLevels = Math.max(view.getUint32(56, true), 1);
    const bytesOfKeyValueData = view.getUint32(60, true);

    if (pixelDepth > 0) {
        throw new Error("KTX: 3D textures not supported");
    }
    if (numberOfArrayElements > 0) {
        throw new Error("KTX: texture arrays not supported");
    }
    if (numberOfFaces !== 1) {
        throw new Error("KTX: cubemaps not supported (use loadCubeTexture)");
    }

    // Skip header + key/value metadata
    let offset = 64 + bytesOfKeyValueData;
    if (offset > buffer.byteLength) {
        throw new Error("KTX: key/value data overflows buffer");
    }

    // Extract per-mip data (zero-copy views into the original ArrayBuffer)
    const mips: KtxMipLevel[] = [];
    let mipW = width;
    let mipH = height;

    for (let i = 0; i < numberOfMipmapLevels; i++) {
        if (offset + 4 > buffer.byteLength) {
            throw new Error(`KTX: truncated at mip ${i} size field`);
        }
        const imageSize = view.getUint32(offset, true);
        offset += 4;

        if (offset + imageSize > buffer.byteLength) {
            throw new Error(`KTX: mip ${i} data overflows buffer`);
        }

        mips.push({ data: new Uint8Array(buffer as ArrayBuffer, offset, imageSize), width: mipW, height: mipH });
        offset += imageSize;
        // Align to 4 bytes
        offset = (offset + 3) & ~3;

        mipW = Math.max(1, mipW >> 1);
        mipH = Math.max(1, mipH >> 1);
    }

    if (mips.length === 0) {
        throw new Error("KTX: no mip levels found");
    }

    return { format, width, height, mips };
}

// ── GPU upload ──────────────────────────────────────────────────────

function uploadCompressed(engine: EngineContext, parsed: KtxParseResult, opts: Texture2DOptions): Texture2D {
    const device = engine._device;
    const fmt = parsed.format;
    const texture = device.createTexture({
        size: { width: parsed.width, height: parsed.height },
        format: fmt.gpuFormat,
        mipLevelCount: parsed.mips.length,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    for (let i = 0; i < parsed.mips.length; i++) {
        const mip = parsed.mips[i]!;
        const blocksPerRow = Math.ceil(mip.width / fmt.blockW);
        const rowBytes = blocksPerRow * fmt.blockBytes;
        // WebGPU requires the copy extent for compressed textures to be the
        // block-padded (physical) size, not the logical mip size. Tail mips
        // smaller than the block (e.g. 2×2, 1×1 for a 4×4 block) must be copied
        // as one full block, otherwise WebGPU rejects copySize as not a multiple
        // of the block width/height.
        const copyW = blocksPerRow * fmt.blockW;
        const copyH = Math.ceil(mip.height / fmt.blockH) * fmt.blockH;
        device.queue.writeTexture({ texture, mipLevel: i }, mip.data as Uint8Array<ArrayBuffer>, { bytesPerRow: rowBytes }, { width: copyW, height: copyH });
    }

    const minF = opts.minFilter ?? "linear";
    const magF = opts.magFilter ?? "linear";
    const mipF: GPUMipmapFilterMode = parsed.mips.length > 1 ? "linear" : "nearest";
    const allLinear = minF === "linear" && magF === "linear" && mipF === "linear";
    const sampler = getOrCreateSampler(engine, {
        addressModeU: opts.addressModeU ?? "repeat",
        addressModeV: opts.addressModeV ?? "repeat",
        minFilter: minF,
        magFilter: magF,
        mipmapFilter: mipF,
        maxAnisotropy: allLinear ? 4 : 1,
    });

    const tex2d: Texture2D = {
        texture,
        view: texture.createView(),
        sampler,
        width: parsed.width,
        height: parsed.height,
    };
    acquireTexture(tex2d);
    return tex2d;
}

// ── URL rewriting ───────────────────────────────────────────────────

function rewriteUrl(baseUrl: string, suffix: string): string {
    // "https://host/path/UVgrid.png" + "-dxt.ktx" → "https://host/path/UVgrid-dxt.ktx"
    const qIdx = baseUrl.indexOf("?");
    const base = qIdx >= 0 ? baseUrl.substring(0, qIdx) : baseUrl;
    const query = qIdx >= 0 ? baseUrl.substring(qIdx) : "";
    const dotIdx = base.lastIndexOf(".");
    if (dotIdx < 0) {
        return base + suffix + query;
    }
    return base.substring(0, dotIdx) + suffix + query;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Load a texture with KTX compressed format auto-selection and fallback.
 *
 * Tries each suffix in priority order, picks the first whose compressed format
 * the GPU supports, fetches and parses the KTX1 file, and uploads it as a
 * compressed GPU texture. Falls back to the base URL (loaded as a regular image)
 * if no suffix is supported or loading fails.
 *
 * @param engine   - The engine context (device must have compressed texture features enabled).
 * @param baseUrl  - The fallback image URL (e.g. "textures/grid.png").
 * @param suffixes - KTX suffixes to try in priority order (e.g. ["-astc.ktx", "-dxt.ktx", "-etc2.ktx"]).
 * @param opts     - Texture options (sampler, address mode, etc.). `mipMaps` is ignored — KTX mips are used as-is.
 * @returns A Texture2D (same interface whether compressed or fallback).
 */
export async function loadKtxTexture2D(engine: EngineContext, baseUrl: string, suffixes: string[], opts: Texture2DOptions = {}): Promise<Texture2D> {
    const device = engine._device;

    // Collect all suffixes whose feature the device supports
    const supported: string[] = [];
    for (const suffix of suffixes) {
        const feature = suffixToFeature(suffix);
        if (feature && device.features.has(feature as GPUFeatureName)) {
            supported.push(suffix);
        }
    }

    // Try each supported suffix; fall through on any failure
    for (const suffix of supported) {
        try {
            const ktxUrl = rewriteUrl(baseUrl, suffix);
            const resp = await fetch(ktxUrl);
            if (!resp.ok) {
                throw new Error(`KTX fetch failed: ${resp.status}`);
            }
            const parsed = parseKtx1(await resp.arrayBuffer());
            return uploadCompressed(engine, parsed, opts);
        } catch (e) {
            console.warn(`KTX load failed for suffix "${suffix}":`, e);
        }
    }

    // Fallback: load as regular image
    return loadTexture2D(engine, baseUrl, opts);
}
