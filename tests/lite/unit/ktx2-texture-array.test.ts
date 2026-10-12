import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runInNewContext } from "node:vm";
import {
    loadKtx2Texture2DArray,
    loadKtx2Texture2DArrayFromUrls,
    uploadKtx2Texture2DArray,
    uploadKtx2Texture2DArrayFromBuffers,
} from "../../../packages/babylon-lite/src/texture/texture-array";
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
    destroys?: number;
    errorScopes?: GPUErrorFilter[];
    gpuErrors?: (GPUError | null)[];
    deviceLost?: Promise<GPUDeviceLostInfo>;
    popErrorScope?: () => Promise<GPUError | null>;
}

function makeEngine(cap: Captured, features: string[] = [], failWrite = false, limits: { maxTextureDimension2D?: number; maxTextureArrayLayers?: number } = {}): EngineContext {
    const device = {
        features: { has: (f: string) => features.includes(f) },
        limits: {
            maxTextureDimension2D: limits.maxTextureDimension2D ?? 8192,
            maxTextureArrayLayers: limits.maxTextureArrayLayers ?? 256,
        },
        lost: cap.deviceLost ?? new Promise<GPUDeviceLostInfo>(() => undefined),
        createTexture: (desc: GPUTextureDescriptor) => {
            cap.createDesc = desc;
            return {
                mipLevelCount: desc.mipLevelCount ?? 1,
                createView: (v?: GPUTextureViewDescriptor) => ((cap.viewDesc = v), { _kind: "view" }),
                destroy: () => {
                    cap.destroys = (cap.destroys ?? 0) + 1;
                },
            } as unknown as GPUTexture;
        },
        createSampler: () => ({ _kind: "sampler" }) as unknown as GPUSampler,
        pushErrorScope: (filter: GPUErrorFilter) => (cap.errorScopes ??= []).push(filter),
        popErrorScope: () => cap.popErrorScope?.() ?? Promise.resolve(cap.gpuErrors?.shift() ?? null),
        queue: {
            writeTexture: (dst: GPUTexelCopyTextureInfo, data: ArrayBufferView, layout: GPUTexelCopyBufferLayout, size: GPUExtent3DStrict) => {
                if (failWrite) {
                    throw new Error("write failed");
                }
                cap.writes.push({ dst, data, layout, size });
            },
        },
    };
    return { _device: device as unknown as GPUDevice } as unknown as EngineContext;
}

const GL_RGBA8 = 0x8058;
const GL_BC7 = 0x8e8c;
const GL_ASTC_4X4 = 0x93b0;

interface FakeMip {
    width: number;
    height: number;
    data: Uint8Array;
    layerIndex?: number;
}

/** Builds a decoder result: `levels` mip levels, each holding `layers` entries tagged with their layer index. */
function fakeDecoded(options: {
    width: number;
    height?: number;
    reportedWidth?: number;
    reportedHeight?: number;
    layers: number;
    levels: number;
    format: number;
    bytesPerPixel?: number;
    layerCount?: number | undefined;
    blockBytes?: number;
}) {
    const mipmaps: FakeMip[] = [];
    for (let level = 0; level < options.levels; level++) {
        const width = Math.max(options.width >> level, 1);
        const height = Math.max((options.height ?? options.width) >> level, 1);
        for (let layer = 0; layer < options.layers; layer++) {
            const byteLength = options.blockBytes ? Math.ceil(width / 4) * Math.ceil(height / 4) * options.blockBytes : width * height * (options.bytesPerPixel ?? 4);
            mipmaps.push({ width, height, data: new Uint8Array(byteLength).fill(level * 16 + layer + 1), layerIndex: layer });
        }
    }
    return {
        width: options.reportedWidth ?? options.width,
        height: options.reportedHeight ?? options.height ?? options.width,
        transcodedFormat: options.format,
        isInGammaSpace: false,
        hasAlpha: true,
        transcoderName: "fake",
        layerCount: "layerCount" in options ? options.layerCount : options.layers,
        mipmaps,
    };
}

let decodeResult: unknown = null;
let decodeInputs: number[][] = [];

beforeEach(() => {
    decodeInputs = [];
    // Stand in for the CDN decoder script that loadKtx2Decoder() injects.
    (globalThis as unknown as { KTX2DECODER?: unknown }).KTX2DECODER = {
        MSCTranscoder: { UseFromWorkerThread: true },
        WASMMemoryManager: { LoadBinariesFromCurrentThread: false },
        KTX2Decoder: class {
            public async decode(data: Uint8Array) {
                decodeInputs.push(Array.from(data));
                const result = Array.isArray(decodeResult) ? decodeResult.shift() : decodeResult;
                return typeof result === "function" ? result() : result;
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
        expect(cap.createDesc).toBeUndefined();
    });

    it("rejects a compressed layer whose payload does not match its block dimensions before GPU allocation", async () => {
        const decoded = fakeDecoded({ width: 8, layers: 2, levels: 1, format: GL_BC7, blockBytes: 16 });
        decoded.mipmaps[1]!.data = new Uint8Array(16);
        decodeResult = decoded;
        const cap: Captured = { writes: [] };

        await expect(uploadKtx2Texture2DArray(makeEngine(cap, ["texture-compression-bc"]), new ArrayBuffer(8))).rejects.toThrow(
            /compressed mip 0 layer 1 has 16 bytes, expected 64/
        );
        expect(cap.createDesc).toBeUndefined();
        expect(cap.writes).toEqual([]);
    });

    it("rejects an uncompressed layer whose size does not match its dimensions", async () => {
        const decoded = fakeDecoded({ width: 2, layers: 2, levels: 1, format: GL_RGBA8 });
        decoded.mipmaps[1]!.data = new Uint8Array(4);
        decodeResult = decoded;
        const cap: Captured = { writes: [] };

        await expect(uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8))).rejects.toThrow(/layer 1 has 4 bytes, expected 16/);
        expect(cap.createDesc).toBeUndefined();
        expect(cap.writes).toEqual([]);
    });

    it("destroys the GPU texture when an upload throws", async () => {
        decodeResult = fakeDecoded({ width: 2, layers: 2, levels: 1, format: GL_RGBA8 });
        const cap: Captured = { writes: [] };

        await expect(uploadKtx2Texture2DArray(makeEngine(cap, [], true), new ArrayBuffer(8))).rejects.toThrow(/write failed/);
        expect(cap.destroys).toBe(1);
    });

    it.each([
        ["validation", [null, { message: "invalid upload" } as GPUError], /GPU texture-array upload failed: invalid upload/],
        ["out-of-memory", [{ message: "allocation exhausted" } as GPUError, null], /GPU texture-array upload failed: allocation exhausted/],
    ] as const)("rejects and destroys the GPU texture after an asynchronous %s error", async (_kind, gpuErrors, message) => {
        decodeResult = fakeDecoded({ width: 2, layers: 2, levels: 1, format: GL_RGBA8 });
        const cap: Captured = { writes: [], gpuErrors: [...gpuErrors] };

        await expect(uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8))).rejects.toThrow(message);

        expect(cap.errorScopes).toEqual(["validation", "out-of-memory"]);
        expect(cap.gpuErrors).toEqual([]);
        expect(cap.destroys).toBe(1);
    });

    it("rejects and destroys resources when the device is lost while error scopes settle", async () => {
        decodeResult = fakeDecoded({ width: 4, layers: 2, levels: 1, format: GL_RGBA8 });
        const cap: Captured = {
            writes: [],
            deviceLost: Promise.resolve({ reason: "destroyed", message: "test loss" } as GPUDeviceLostInfo),
        };

        await expect(uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8))).rejects.toThrow("GPU device was lost or replaced during texture-array upload: test loss");

        expect(cap.destroys).toBe(1);
    });

    it("rejects and destroys resources when recovery replaces the device while error scopes settle", async () => {
        decodeResult = fakeDecoded({ width: 4, layers: 2, levels: 1, format: GL_RGBA8 });
        let releaseScopes!: () => void;
        const scopesBlocked = new Promise<void>((resolve) => {
            releaseScopes = resolve;
        });
        let enterScopes!: () => void;
        const scopesEntered = new Promise<void>((resolve) => {
            enterScopes = resolve;
        });
        let popCount = 0;
        const cap: Captured = {
            writes: [],
            popErrorScope: async () => {
                if (popCount++ === 0) {
                    enterScopes();
                }
                await scopesBlocked;
                return null;
            },
        };
        const engine = makeEngine(cap);

        const upload = uploadKtx2Texture2DArray(engine, new ArrayBuffer(8));
        await scopesEntered;
        engine._device = makeEngine({ writes: [] })._device;
        releaseScopes();

        await expect(upload).rejects.toThrow("GPU device was lost or replaced during texture-array upload");
        expect(cap.destroys).toBe(1);
    });

    it("surfaces decoder errors", async () => {
        decodeResult = { ...fakeDecoded({ width: 2, layers: 1, levels: 1, format: GL_RGBA8 }), errors: "boom" };
        const cap: Captured = { writes: [] };

        await expect(uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8))).rejects.toThrow(/boom/);
    });

    it("rejects an unsupported transcoded format before GPU allocation", async () => {
        decodeResult = fakeDecoded({ width: 2, layers: 1, levels: 1, format: 0xdead });
        const cap: Captured = { writes: [] };

        await expect(uploadKtx2Texture2DArray(makeEngine(cap), new ArrayBuffer(8))).rejects.toThrow(/unsupported transcoded format 0xdead/);
        expect(cap.createDesc).toBeUndefined();
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

describe("uploadKtx2Texture2DArrayFromBuffers", () => {
    it("preserves an ArrayBuffer created in another realm", async () => {
        decodeResult = fakeDecoded({ width: 2, layers: 1, levels: 1, format: GL_RGBA8, layerCount: undefined });
        const foreignBuffer = runInNewContext("Uint8Array.from([1, 2, 3, 4]).buffer") as ArrayBuffer;
        const cap: Captured = { writes: [] };

        await uploadKtx2Texture2DArrayFromBuffers(makeEngine(cap), [foreignBuffer]);

        expect(decodeInputs).toEqual([[1, 2, 3, 4]]);
    });

    it("preserves source order as array-layer order across the authored mip chain", async () => {
        decodeResult = [
            fakeDecoded({ width: 4, layers: 1, levels: 3, format: GL_RGBA8, layerCount: undefined }),
            fakeDecoded({ width: 4, layers: 1, levels: 3, format: GL_RGBA8, layerCount: undefined }),
        ];
        (decodeResult as ReturnType<typeof fakeDecoded>[])[1]!.mipmaps.forEach((mip) => mip.data.fill(9));
        const cap: Captured = { writes: [] };

        const tex = await uploadKtx2Texture2DArrayFromBuffers(makeEngine(cap), [new ArrayBuffer(8), new Uint8Array(new ArrayBuffer(16), 4, 8)]);

        expect(tex.layers).toBe(2);
        expect(cap.createDesc?.mipLevelCount).toBe(3);
        expect(cap.writes.map((write) => [write.dst.mipLevel, (write.dst.origin as { z: number }).z])).toEqual([
            [0, 0],
            [0, 1],
            [1, 0],
            [1, 1],
            [2, 0],
            [2, 1],
        ]);
        expect((cap.writes[0]!.data as Uint8Array)[0]).toBe(1);
        expect((cap.writes[1]!.data as Uint8Array)[0]).toBe(9);
    });

    it("keeps compatible separate layers GPU-compressed", async () => {
        decodeResult = [
            fakeDecoded({ width: 8, layers: 1, levels: 2, format: GL_BC7, blockBytes: 16 }),
            fakeDecoded({ width: 8, layers: 1, levels: 2, format: GL_BC7, blockBytes: 16 }),
        ];
        const cap: Captured = { writes: [] };

        await uploadKtx2Texture2DArrayFromBuffers(makeEngine(cap, ["texture-compression-bc"]), [new ArrayBuffer(8), new ArrayBuffer(8)]);

        expect(cap.createDesc?.format).toBe("bc7-rgba-unorm");
        expect(cap.createDesc?.size).toEqual({ width: 8, height: 8, depthOrArrayLayers: 2 });
        expect(cap.writes).toHaveLength(4);
    });

    it("rejects block-unaligned compressed dimensions before GPU allocation", async () => {
        decodeResult = [
            fakeDecoded({ width: 5, height: 7, reportedWidth: 8, reportedHeight: 8, layers: 1, levels: 1, format: GL_ASTC_4X4, blockBytes: 16 }),
            fakeDecoded({ width: 5, height: 7, reportedWidth: 8, reportedHeight: 8, layers: 1, levels: 1, format: GL_ASTC_4X4, blockBytes: 16 }),
        ];
        const cap: Captured = { writes: [] };

        await expect(uploadKtx2Texture2DArrayFromBuffers(makeEngine(cap, ["texture-compression-astc"]), [new ArrayBuffer(8), new ArrayBuffer(8)])).rejects.toThrow(
            /5x7.*4x4.*texture-compression-unaligned/
        );
        expect(cap.createDesc).toBeUndefined();
        expect(cap.writes).toEqual([]);
    });

    it("uploads block-unaligned compressed dimensions when the device enables that feature", async () => {
        decodeResult = [
            fakeDecoded({ width: 5, height: 7, reportedWidth: 8, reportedHeight: 8, layers: 1, levels: 1, format: GL_ASTC_4X4, blockBytes: 16 }),
            fakeDecoded({ width: 5, height: 7, reportedWidth: 8, reportedHeight: 8, layers: 1, levels: 1, format: GL_ASTC_4X4, blockBytes: 16 }),
        ];
        const cap: Captured = { writes: [] };

        await uploadKtx2Texture2DArrayFromBuffers(makeEngine(cap, ["texture-compression-astc", "texture-compression-unaligned"]), [new ArrayBuffer(8), new ArrayBuffer(8)]);

        expect(cap.createDesc?.size).toEqual({ width: 5, height: 7, depthOrArrayLayers: 2 });
        expect(cap.writes).toHaveLength(2);
        expect(cap.writes[0]!.data.byteLength).toBe(64);
        expect(cap.writes[0]!.size).toEqual({ width: 8, height: 8, depthOrArrayLayers: 1 });
    });

    it("rejects invalid WebGPU descriptor limits before GPU allocation", async () => {
        for (const [decoded, limits, message] of [
            [fakeDecoded({ width: 9, height: 1, layers: 1, levels: 1, format: GL_RGBA8 }), { maxTextureDimension2D: 8 }, /dimensions 9x1 exceed/],
            [fakeDecoded({ width: 2, layers: 3, levels: 1, format: GL_RGBA8 }), { maxTextureArrayLayers: 2 }, /3 layers.*maxTextureArrayLayers 2/],
            [fakeDecoded({ width: 1, layers: 1, levels: 2, format: GL_RGBA8 }), {}, /1x1 has 2 mip levels.*maximum 1/],
        ] as const) {
            decodeResult = decoded;
            const cap: Captured = { writes: [] };

            await expect(uploadKtx2Texture2DArray(makeEngine(cap, [], false, limits), new ArrayBuffer(8))).rejects.toThrow(message);
            expect(cap.createDesc).toBeUndefined();
            expect(cap.writes).toEqual([]);
        }
    });

    it("rejects incompatible sources before creating a GPU texture", async () => {
        const differentFormat = [
            fakeDecoded({ width: 4, layers: 1, levels: 2, format: GL_RGBA8 }),
            fakeDecoded({ width: 4, layers: 1, levels: 2, format: GL_BC7, blockBytes: 16 }),
        ];
        const differentSize = [fakeDecoded({ width: 4, layers: 1, levels: 2, format: GL_RGBA8 }), fakeDecoded({ width: 8, layers: 1, levels: 2, format: GL_RGBA8 })];
        const differentMipCount = [fakeDecoded({ width: 4, layers: 1, levels: 2, format: GL_RGBA8 }), fakeDecoded({ width: 4, layers: 1, levels: 1, format: GL_RGBA8 })];
        const multiLayer = [fakeDecoded({ width: 4, layers: 1, levels: 2, format: GL_RGBA8 }), fakeDecoded({ width: 4, layers: 2, levels: 2, format: GL_RGBA8 })];

        for (const [results, message] of [
            [differentFormat, /different transcoded format/],
            [differentSize, /has size 8x8/],
            [differentMipCount, /has 1 mip levels/],
            [multiLayer, /reports layerCount 2/],
        ] as const) {
            decodeResult = [...results];
            const cap: Captured = { writes: [] };
            await expect(uploadKtx2Texture2DArrayFromBuffers(makeEngine(cap), [new ArrayBuffer(8), new ArrayBuffer(8)])).rejects.toThrow(message);
            expect(cap.createDesc).toBeUndefined();
        }
    });

    it("rejects an empty source list without invoking the decoder", async () => {
        decodeResult = null;
        const cap: Captured = { writes: [] };

        await expect(
            uploadKtx2Texture2DArrayFromBuffers(makeEngine(cap), [] as unknown as readonly [ArrayBuffer | ArrayBufferView, ...(ArrayBuffer | ArrayBufferView)[]])
        ).rejects.toThrow(/at least one/);
        expect(cap.createDesc).toBeUndefined();
    });

    it("normalizes every source before starting any asynchronous decode", async () => {
        const backing = new ArrayBuffer(8);
        const detachedView = new Uint8Array(backing);
        structuredClone(backing, { transfer: [backing] });
        decodeResult = () => Promise.reject(new Error("decode must not start"));
        const cap: Captured = { writes: [] };
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);

        try {
            await expect(uploadKtx2Texture2DArrayFromBuffers(makeEngine(cap), [new ArrayBuffer(8), detachedView])).rejects.toThrow();
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(decodeInputs).toEqual([]);
            expect(unhandled).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});

describe("loadKtx2Texture2DArrayFromUrls", () => {
    it("fetches separate files in order and delegates to the shared array upload", async () => {
        decodeResult = [fakeDecoded({ width: 2, layers: 1, levels: 1, format: GL_RGBA8 }), fakeDecoded({ width: 2, layers: 1, levels: 1, format: GL_RGBA8 })];
        const fetchMock = vi.fn(async (_url: string) => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }));
        vi.stubGlobal("fetch", fetchMock);
        const cap: Captured = { writes: [] };

        const tex = await loadKtx2Texture2DArrayFromUrls(makeEngine(cap), ["a.ktx2", "b.ktx2"]);

        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["a.ktx2", "b.ktx2"]);
        expect(tex.layers).toBe(2);
    });

    it("surfaces a failed fetch before GPU allocation", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => ({
                ok: url !== "missing.ktx2",
                status: url === "missing.ktx2" ? 404 : 200,
                arrayBuffer: async () => new ArrayBuffer(8),
            }))
        );
        const cap: Captured = { writes: [] };

        await expect(loadKtx2Texture2DArrayFromUrls(makeEngine(cap), ["ok.ktx2", "missing.ktx2"])).rejects.toThrow(/KTX2 fetch failed: 404 for missing\.ktx2/);
        expect(cap.createDesc).toBeUndefined();
    });
});
