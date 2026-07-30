import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { loadKtx2Texture2DArray, uploadKtx2Texture2DArray } from "../../../packages/babylon-lite/src/texture/texture-array";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

interface WriteCall {
    dst: GPUTexelCopyTextureInfo;
    data: ArrayBufferView;
    layout: GPUTexelCopyBufferLayout;
    size: GPUExtent3DStrict;
}

interface Captured {
    createDesc?: GPUTextureDescriptor;
    viewDesc?: GPUTextureViewDescriptor;
    writes: WriteCall[];
}

function makeEngine(cap: Captured, features: string[] = []): EngineContext {
    const device = {
        features: { has: (f: string) => features.includes(f) },
        createTexture: (desc: GPUTextureDescriptor) => {
            cap.createDesc = desc;
            return {
                mipLevelCount: desc.mipLevelCount ?? 1,
                createView: (v?: GPUTextureViewDescriptor) => ((cap.viewDesc = v), { _kind: "view" }),
                destroy: () => undefined,
            } as unknown as GPUTexture;
        },
        createSampler: () => ({ _kind: "sampler" }) as unknown as GPUSampler,
        queue: {
            writeTexture: (dst: GPUTexelCopyTextureInfo, data: ArrayBufferView, layout: GPUTexelCopyBufferLayout, size: GPUExtent3DStrict) => {
                cap.writes.push({ dst, data, layout, size });
            },
        },
    };
    return { _device: device as unknown as GPUDevice } as unknown as EngineContext;
}

const GL_RGBA8 = 0x8058;
const GL_BC7 = 0x8e8c;

interface FakeMip {
    width: number;
    height: number;
    data: Uint8Array;
    layerIndex?: number;
}

/** Builds a decoder result: `levels` mip levels, each holding `layers` entries tagged with their layer index. */
function fakeDecoded(options: { width: number; layers: number; levels: number; format: number; bytesPerPixel?: number; layerCount?: number | undefined; blockBytes?: number }) {
    const mipmaps: FakeMip[] = [];
    for (let level = 0; level < options.levels; level++) {
        const size = Math.max(options.width >> level, 1);
        for (let layer = 0; layer < options.layers; layer++) {
            const byteLength = options.blockBytes ? Math.ceil(size / 4) * Math.ceil(size / 4) * options.blockBytes : size * size * (options.bytesPerPixel ?? 4);
            mipmaps.push({ width: size, height: size, data: new Uint8Array(byteLength).fill(level * 16 + layer + 1), layerIndex: layer });
        }
    }
    return {
        width: options.width,
        height: options.width,
        transcodedFormat: options.format,
        isInGammaSpace: false,
        hasAlpha: true,
        transcoderName: "fake",
        layerCount: "layerCount" in options ? options.layerCount : options.layers,
        mipmaps,
    };
}

let decodeResult: unknown = null;

beforeEach(() => {
    // Stand in for the CDN decoder script that loadKtx2Decoder() injects.
    (globalThis as unknown as { KTX2DECODER?: unknown }).KTX2DECODER = {
        MSCTranscoder: { UseFromWorkerThread: true },
        WASMMemoryManager: { LoadBinariesFromCurrentThread: false },
        KTX2Decoder: class {
            public async decode() {
                return decodeResult;
            }
        },
    };
});

afterEach(() => {
    delete (globalThis as unknown as { KTX2DECODER?: unknown }).KTX2DECODER;
    vi.unstubAllGlobals();
});

describe("uploadKtx2Texture2DArray", () => {
    it("creates a layered texture with a 2d-array view and the container's mip chain", async () => {
        decodeResult = fakeDecoded({ width: 4, layers: 3, levels: 3, format: GL_RGBA8 });
        const cap: Captured = { writes: [] };

        const tex = await uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8));

        expect(cap.createDesc?.dimension).toBe("2d");
        expect(cap.createDesc?.size).toEqual({ width: 4, height: 4, depthOrArrayLayers: 3 });
        expect(cap.createDesc?.format).toBe("rgba8unorm");
        expect(cap.createDesc?.mipLevelCount).toBe(3);
        // The mip chain is authored, so no render-attachment/blit pass is needed.
        expect((cap.createDesc?.usage ?? 0) & GPUTextureUsage.RENDER_ATTACHMENT).toBe(0);
        expect(cap.viewDesc).toEqual({ dimension: "2d-array" });
        expect(tex.layers).toBe(3);
        expect(tex.width).toBe(4);
        // Codec-decoded data is uploaded unflipped, so the material must flip V (GUIDANCE §8 path 2).
        expect(tex.invertY).toBe(true);
    });

    it("writes each layer of each level to its own origin.z", async () => {
        decodeResult = fakeDecoded({ width: 2, layers: 2, levels: 2, format: GL_RGBA8 });
        const cap: Captured = { writes: [] };

        await uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8));

        expect(cap.writes).toHaveLength(4);
        expect(cap.writes.map((w) => [w.dst.mipLevel, (w.dst.origin as { z: number }).z])).toEqual([
            [0, 0],
            [0, 1],
            [1, 0],
            [1, 1],
        ]);
        expect(cap.writes[0]!.size).toEqual({ width: 2, height: 2, depthOrArrayLayers: 1 });
        expect(cap.writes[0]!.layout).toEqual({ bytesPerRow: 8 });
        expect(cap.writes[2]!.size).toEqual({ width: 1, height: 1, depthOrArrayLayers: 1 });
        // Each write must carry its own layer's bytes.
        expect((cap.writes[0]!.data as Uint8Array)[0]).toBe(1);
        expect((cap.writes[1]!.data as Uint8Array)[0]).toBe(2);
        expect((cap.writes[2]!.data as Uint8Array)[0]).toBe(17);
    });

    it("keeps a compressed array compressed and block-pads the copy extent", async () => {
        decodeResult = fakeDecoded({ width: 8, layers: 2, levels: 3, format: GL_BC7, blockBytes: 16 });
        const cap: Captured = { writes: [] };

        const tex = await uploadKtx2Texture2DArray(makeEngine(cap, ["texture-compression-bc"]), new ArrayBuffer(8));

        expect(cap.createDesc?.format).toBe("bc7-rgba-unorm");
        expect(tex.layers).toBe(2);
        expect(cap.writes).toHaveLength(6);
        // 8x8 -> 2x2 blocks of 16 bytes.
        expect(cap.writes[0]!.layout).toEqual({ bytesPerRow: 32 });
        expect(cap.writes[0]!.size).toEqual({ width: 8, height: 8, depthOrArrayLayers: 1 });
        // 2x2 tail mip is padded up to one full 4x4 block.
        expect(cap.writes[4]!.size).toEqual({ width: 4, height: 4, depthOrArrayLayers: 1 });
    });

    it("selects the sRGB format when requested", async () => {
        decodeResult = fakeDecoded({ width: 2, layers: 2, levels: 1, format: GL_RGBA8 });
        const cap: Captured = { writes: [] };

        await uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8), true);

        expect(cap.createDesc?.format).toBe("rgba8unorm-srgb");
    });

    it("handles a single-layer file", async () => {
        decodeResult = fakeDecoded({ width: 2, layers: 1, levels: 2, format: GL_RGBA8 });
        const cap: Captured = { writes: [] };

        const tex = await uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8));

        expect(tex.layers).toBe(1);
        expect(cap.writes).toHaveLength(2);
    });

    it("rejects a decoder that does not report layerCount", async () => {
        decodeResult = fakeDecoded({ width: 2, layers: 1, levels: 1, format: GL_RGBA8, layerCount: undefined });
        const cap: Captured = { writes: [] };

        await expect(uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8))).rejects.toThrow(/does not report layerCount/);
    });

    it("rejects when the decoder scrambles the layer order", async () => {
        const decoded = fakeDecoded({ width: 2, layers: 2, levels: 1, format: GL_RGBA8 });
        decoded.mipmaps[1]!.layerIndex = 0;
        decodeResult = decoded;
        const cap: Captured = { writes: [] };

        await expect(uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8))).rejects.toThrow(/expected layer 1 at mip index 1/);
    });

    it("rejects when the mip count is not a whole number of levels", async () => {
        const decoded = fakeDecoded({ width: 2, layers: 2, levels: 1, format: GL_RGBA8 });
        decoded.mipmaps.push({ width: 1, height: 1, data: new Uint8Array(4), layerIndex: 0 });
        decodeResult = decoded;
        const cap: Captured = { writes: [] };

        await expect(uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8))).rejects.toThrow(/whole number of 2-layer levels/);
    });

    it("rejects when the device lacks the compressed format feature", async () => {
        decodeResult = fakeDecoded({ width: 4, layers: 2, levels: 1, format: GL_BC7, blockBytes: 16 });
        const cap: Captured = { writes: [] };

        await expect(uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8))).rejects.toThrow(/does not support texture-compression-bc/);
    });

    it("rejects an uncompressed layer whose size does not match its dimensions", async () => {
        const decoded = fakeDecoded({ width: 2, layers: 2, levels: 1, format: GL_RGBA8 });
        decoded.mipmaps[1]!.data = new Uint8Array(4);
        decodeResult = decoded;
        const cap: Captured = { writes: [] };

        await expect(uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8))).rejects.toThrow(/layer 1 has 4 bytes, expected 16/);
    });

    it("surfaces decoder errors", async () => {
        decodeResult = { ...fakeDecoded({ width: 2, layers: 1, levels: 1, format: GL_RGBA8 }), errors: "boom" };
        const cap: Captured = { writes: [] };

        await expect(uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8))).rejects.toThrow(/boom/);
    });
});

describe("loadKtx2Texture2DArray", () => {
    it("fetches the url and uploads the result", async () => {
        decodeResult = fakeDecoded({ width: 2, layers: 2, levels: 1, format: GL_RGBA8 });
        const cap: Captured = { writes: [] };
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }))
        );

        const tex = await loadKtx2Texture2DArray(makeEngine(cap), "array.ktx2");

        expect(tex.layers).toBe(2);
        expect(cap.writes).toHaveLength(2);
    });

    it("rejects on a failed fetch", async () => {
        const cap: Captured = { writes: [] };
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: false, status: 404 }))
        );

        await expect(loadKtx2Texture2DArray(makeEngine(cap), "missing.ktx2")).rejects.toThrow(/KTX2 fetch failed: 404/);
    });
});
