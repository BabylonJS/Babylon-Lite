/**
 * Basis Universal texture loader.
 *
 * Loads a .basis file, transcodes it on the main thread via the Binomial LLC
 * Basis Universal transcoder (fetched lazily from the Babylon.js CDN), selects
 * the best GPU-supported compressed format, and uploads the transcoded mip
 * chain as a WebGPU texture.
 *
 * Format priority (by WebGPU device features):
 *   BC7 → ASTC 4×4 → ETC2 → BC3 → RGBA32 (uncompressed fallback)
 *
 * Fully tree-shakable: only bundled when explicitly imported. The transcoder
 * JS+WASM are fetched at runtime on the first call, so the bundle cost is just
 * this wrapper (no transcoder bytes are shipped).
 */

import { acquireTexture, getOrCreateSampler } from "../resource/gpu-pool.js";
import type { EngineContext, EngineContextInternal } from "../engine/engine.js";
import type { Texture2D, Texture2DOptions } from "./texture-2d.js";

// ── Basis transcoder format IDs (match BinomialLLC basis_transcoder.js) ─────
// Names from basis_transcoder.js `BASIS_FORMAT`.
const cTFETC1 = 0;
const cTFETC2 = 1;
const cTFBC1 = 2;
const cTFBC3 = 3;
const cTFBC7 = 6;
const cTFASTC_4x4 = 10;
const cTFRGBA32 = 13;

interface BasisModule {
    initializeBasis(): void;
    BasisFile: new (data: Uint8Array) => BasisFileHandle;
}

interface BasisFileHandle {
    close(): void;
    delete(): void;
    getHasAlpha(): number;
    getNumImages(): number;
    getNumLevels(imageIndex: number): number;
    getImageWidth(imageIndex: number, level: number): number;
    getImageHeight(imageIndex: number, level: number): number;
    getImageTranscodedSizeInBytes(imageIndex: number, level: number, format: number): number;
    startTranscoding(): number;
    transcodeImage(dst: Uint8Array, imageIndex: number, level: number, format: number, unused: number, getAlphaForOpaqueFormats: number): number;
}

// ── Lazy transcoder loader ──────────────────────────────────────────────────

const CDN_BASE = "https://cdn.babylonjs.com/basisTranscoder/1";

let _modulePromise: Promise<BasisModule> | null = null;

function loadBasisModule(): Promise<BasisModule> {
    if (_modulePromise) {
        return _modulePromise;
    }
    _modulePromise = new Promise<BasisModule>((resolve, reject) => {
        const w = globalThis as unknown as { BASIS?: (opts: { locateFile: (p: string) => string }) => Promise<BasisModule> };
        const init = (): void => {
            const BASIS = w.BASIS;
            if (!BASIS) {
                reject(new Error("Basis: transcoder global BASIS not found after script load"));
                return;
            }
            BASIS({ locateFile: (p: string) => `${CDN_BASE}/${p}` })
                .then((mod) => {
                    mod.initializeBasis();
                    resolve(mod);
                })
                .catch(reject);
        };
        if (w.BASIS) {
            init();
            return;
        }
        const script = document.createElement("script");
        script.src = `${CDN_BASE}/basis_transcoder.js`;
        script.async = true;
        script.onload = init;
        script.onerror = (): void => reject(new Error(`Basis: failed to load ${script.src}`));
        document.head.appendChild(script);
    });
    _modulePromise.catch(() => {
        _modulePromise = null;
    });
    return _modulePromise;
}

// ── GPU format selection ────────────────────────────────────────────────────

interface BasisTargetFormat {
    /** basis_transcoder format id (BASIS_FORMAT.*). */
    basisFormat: number;
    /** Corresponding WebGPU format (unorm variant). */
    gpuFormat: GPUTextureFormat;
    /** sRGB counterpart (undefined if none). */
    gpuFormatSrgb?: GPUTextureFormat;
    /** Device feature required (undefined = always available, e.g. rgba8). */
    feature?: GPUFeatureName;
    /** Block width in texels (1 for uncompressed). */
    blockW: number;
    /** Block height in texels. */
    blockH: number;
    /** Bytes per compressed block (or per-texel for uncompressed rgba8 = 4). */
    blockBytes: number;
    /** True if this format encodes alpha. */
    hasAlpha: boolean;
}

// Priority-ordered target formats. Alpha-capable formats are preferred when the
// source has alpha; opaque-only formats are skipped in that case (BC1).
const BASIS_TARGETS: BasisTargetFormat[] = [
    {
        basisFormat: cTFBC7,
        gpuFormat: "bc7-rgba-unorm",
        gpuFormatSrgb: "bc7-rgba-unorm-srgb",
        feature: "texture-compression-bc",
        blockW: 4,
        blockH: 4,
        blockBytes: 16,
        hasAlpha: true,
    },
    {
        basisFormat: cTFASTC_4x4,
        gpuFormat: "astc-4x4-unorm",
        gpuFormatSrgb: "astc-4x4-unorm-srgb",
        feature: "texture-compression-astc",
        blockW: 4,
        blockH: 4,
        blockBytes: 16,
        hasAlpha: true,
    },
    {
        basisFormat: cTFETC2,
        gpuFormat: "etc2-rgba8unorm",
        gpuFormatSrgb: "etc2-rgba8unorm-srgb",
        feature: "texture-compression-etc2",
        blockW: 4,
        blockH: 4,
        blockBytes: 16,
        hasAlpha: true,
    },
    {
        basisFormat: cTFBC3,
        gpuFormat: "bc3-rgba-unorm",
        gpuFormatSrgb: "bc3-rgba-unorm-srgb",
        feature: "texture-compression-bc",
        blockW: 4,
        blockH: 4,
        blockBytes: 16,
        hasAlpha: true,
    },
    {
        basisFormat: cTFBC1,
        gpuFormat: "bc1-rgba-unorm",
        gpuFormatSrgb: "bc1-rgba-unorm-srgb",
        feature: "texture-compression-bc",
        blockW: 4,
        blockH: 4,
        blockBytes: 8,
        hasAlpha: false,
    },
    // Uncompressed fallback — always supported, no device feature needed.
    { basisFormat: cTFRGBA32, gpuFormat: "rgba8unorm", gpuFormatSrgb: "rgba8unorm-srgb", blockW: 1, blockH: 1, blockBytes: 4, hasAlpha: true },
    // ETC1 fallback kept last (rare on WebGPU; mapped via ETC2 feature on GPUs that expose it).
    {
        basisFormat: cTFETC1,
        gpuFormat: "etc2-rgb8unorm",
        gpuFormatSrgb: "etc2-rgb8unorm-srgb",
        feature: "texture-compression-etc2",
        blockW: 4,
        blockH: 4,
        blockBytes: 8,
        hasAlpha: false,
    },
];

function pickTarget(device: GPUDevice, sourceHasAlpha: boolean): BasisTargetFormat {
    for (const t of BASIS_TARGETS) {
        if (!t.hasAlpha && sourceHasAlpha) {
            continue;
        }
        if (t.feature && !device.features.has(t.feature)) {
            continue;
        }
        return t;
    }
    // rgba8unorm entry has no feature gate, so we always reach it.
    return BASIS_TARGETS[BASIS_TARGETS.length - 2]!;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a Basis Universal (.basis) texture, transcode it to the best GPU-supported
 * compressed format, and upload to a WebGPU texture.
 *
 * @param engine - The engine context.
 * @param url    - URL of the .basis file.
 * @param opts   - Sampler/address/filter options. `mipMaps` is ignored — basis
 *                 mips are used as-is. `invertY` is ignored — basis data is
 *                 already oriented for sampling.
 * @returns A Texture2D.
 */
export async function loadBasisTexture2D(engine: EngineContext, url: string, opts: Texture2DOptions = {}): Promise<Texture2D> {
    const device = (engine as EngineContextInternal).device;

    const [mod, buffer] = await Promise.all([loadBasisModule(), fetch(url).then((r) => r.arrayBuffer())]);

    const bytes = new Uint8Array(buffer);
    const file = new mod.BasisFile(bytes);
    try {
        if (file.getNumImages() === 0) {
            throw new Error("Basis: no images in file");
        }
        if (file.startTranscoding() === 0) {
            throw new Error("Basis: startTranscoding failed");
        }

        const hasAlpha = file.getHasAlpha() !== 0;
        const target = pickTarget(device, hasAlpha);
        const width = file.getImageWidth(0, 0);
        const height = file.getImageHeight(0, 0);
        const levels = file.getNumLevels(0);

        const srgb = opts.srgb ?? false;
        const gpuFormat: GPUTextureFormat = srgb && target.gpuFormatSrgb ? target.gpuFormatSrgb : target.gpuFormat;

        // Transcode all mip levels.
        const mips: { data: Uint8Array; width: number; height: number }[] = [];
        for (let level = 0; level < levels; level++) {
            const mipW = file.getImageWidth(0, level);
            const mipH = file.getImageHeight(0, level);
            const size = file.getImageTranscodedSizeInBytes(0, level, target.basisFormat);
            if (size === 0) {
                throw new Error(`Basis: transcoded size is 0 for mip ${level}`);
            }
            const dst = new Uint8Array(size);
            const ok = file.transcodeImage(dst, 0, level, target.basisFormat, 0, hasAlpha ? 1 : 0);
            if (ok === 0) {
                throw new Error(`Basis: transcodeImage failed for mip ${level}`);
            }
            mips.push({ data: dst, width: mipW, height: mipH });
        }

        // Create and populate the GPU texture.
        const texture = device.createTexture({
            size: { width, height },
            format: gpuFormat,
            mipLevelCount: mips.length,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

        for (let level = 0; level < mips.length; level++) {
            const mip = mips[level]!;
            const blocksPerRow = Math.ceil(mip.width / target.blockW);
            const rowBytes = target.blockW === 1 ? mip.width * target.blockBytes : blocksPerRow * target.blockBytes;
            device.queue.writeTexture({ texture, mipLevel: level }, mip.data as Uint8Array<ArrayBuffer>, { bytesPerRow: rowBytes }, { width: mip.width, height: mip.height });
        }

        const minF = opts.minFilter ?? "linear";
        const magF = opts.magFilter ?? "linear";
        const mipF: GPUMipmapFilterMode = mips.length > 1 ? "linear" : "nearest";
        const allLinear = minF === "linear" && magF === "linear" && mipF === "linear";
        const sampler = getOrCreateSampler(engine as EngineContextInternal, {
            addressModeU: opts.addressModeU ?? "repeat",
            addressModeV: opts.addressModeV ?? "repeat",
            minFilter: minF,
            magFilter: magF,
            mipmapFilter: mipF,
            maxAnisotropy: allLinear ? 4 : 1,
        });

        const tex2d: Texture2D = { texture, view: texture.createView(), sampler, width, height, invertY: true };
        acquireTexture(tex2d);
        return tex2d;
    } finally {
        file.close();
        file.delete();
    }
}
