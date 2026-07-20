import { describe, expect, it, vi } from "vitest";
import {
    createTexture2DArray,
    uploadImageToArrayLayer,
    loadImageToArrayLayer,
    createTexture2DArrayFromUrls,
    type Texture2DArray,
} from "../../../packages/babylon-lite/src/texture/texture-array";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

interface Captured {
    createDesc?: GPUTextureDescriptor;
    viewDesc?: GPUTextureViewDescriptor;
    samplerDesc?: GPUSamplerDescriptor;
    copyCalls: Array<{ src: GPUCopyExternalImageSourceInfo; dst: GPUCopyExternalImageDestInfo; size: GPUExtent3DStrict }>;
}

// A fake external-image source (an ImageBitmap stand-in) with a close() spy.
function fakeSource(width = 4, height = 4): ImageBitmap {
    return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

function makeEngine(cap: Captured): EngineContext {
    const device = {
        createTexture: (desc: GPUTextureDescriptor) => {
            cap.createDesc = desc;
            return {
                mipLevelCount: desc.mipLevelCount ?? 1,
                createView: (v?: GPUTextureViewDescriptor) => ((cap.viewDesc = v), { _kind: "view" }),
                destroy: () => undefined,
            } as unknown as GPUTexture;
        },
        createSampler: (desc: GPUSamplerDescriptor) => ((cap.samplerDesc = desc), { _kind: "sampler" } as unknown as GPUSampler),
        queue: {
            copyExternalImageToTexture: (src: GPUCopyExternalImageSourceInfo, dst: GPUCopyExternalImageDestInfo, size: GPUExtent3DStrict) => {
                cap.copyCalls.push({ src, dst, size });
            },
        },
    };
    return { _device: device as unknown as GPUDevice } as unknown as EngineContext;
}

describe("createTexture2DArray", () => {
    it("creates a layered 2d texture with a 2d-array view", () => {
        const cap: Captured = { copyCalls: [] };
        const tex = createTexture2DArray(makeEngine(cap), 4, 4, 3, { mipMaps: false });

        expect(cap.createDesc?.dimension).toBe("2d");
        expect(cap.createDesc?.size).toEqual({ width: 4, height: 4, depthOrArrayLayers: 3 });
        expect(cap.createDesc?.format).toBe("rgba8unorm");
        expect(cap.createDesc?.mipLevelCount).toBe(1);
        // copyExternalImageToTexture requires COPY_DST | RENDER_ATTACHMENT on the destination.
        const usage = cap.createDesc?.usage ?? 0;
        expect(usage & GPUTextureUsage.COPY_DST).toBeTruthy();
        expect(usage & GPUTextureUsage.RENDER_ATTACHMENT).toBeTruthy();
        expect(usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();
        expect(cap.viewDesc).toEqual({ dimension: "2d-array" });
        expect(tex.layers).toBe(3);
        expect(tex.width).toBe(4);
        expect(tex.height).toBe(4);
    });

    it("requests a full mip chain when mipMaps is on (default)", () => {
        const cap: Captured = { copyCalls: [] };
        createTexture2DArray(makeEngine(cap), 8, 8, 2);
        // log2(8)+1 = 4 levels
        expect(cap.createDesc?.mipLevelCount).toBe(4);
        expect(cap.samplerDesc?.mipmapFilter).toBe("linear");
    });

    it("defaults to a linear repeat sampler and honors overrides", () => {
        const cap: Captured = { copyCalls: [] };
        createTexture2DArray(makeEngine(cap), 4, 4, 1, { mipMaps: false });
        expect(cap.samplerDesc).toMatchObject({ addressModeU: "repeat", addressModeV: "repeat", minFilter: "linear", magFilter: "linear", mipmapFilter: "nearest" });

        const cap2: Captured = { copyCalls: [] };
        createTexture2DArray(makeEngine(cap2), 4, 4, 1, { mipMaps: false, srgb: true, addressModeU: "clamp-to-edge", minFilter: "nearest" });
        expect(cap2.createDesc?.format).toBe("rgba8unorm-srgb");
        expect(cap2.samplerDesc).toMatchObject({ addressModeU: "clamp-to-edge", minFilter: "nearest" });
    });

    it("throws on degenerate dimensions or layer count", () => {
        expect(() => createTexture2DArray(makeEngine({ copyCalls: [] }), 0, 4, 2)).toThrow(/>= 1/);
        expect(() => createTexture2DArray(makeEngine({ copyCalls: [] }), 4, 4, 0)).toThrow(/>= 1/);
    });
});

describe("uploadImageToArrayLayer", () => {
    it("copies a source into the requested layer via origin z", () => {
        const cap: Captured = { copyCalls: [] };
        const engine = makeEngine(cap);
        const tex = createTexture2DArray(engine, 4, 4, 3, { mipMaps: false });

        uploadImageToArrayLayer(engine, tex, 2, fakeSource());

        expect(cap.copyCalls).toHaveLength(1);
        const call = cap.copyCalls[0]!;
        expect(call.dst.origin as unknown as number[]).toEqual([0, 0, 2]);
        expect(call.size).toEqual([4, 4, 1]);
        expect((call.src as { flipY?: boolean }).flipY).toBe(true);
    });

    it("passes invertY / premultiplyAlpha overrides through", () => {
        const cap: Captured = { copyCalls: [] };
        const engine = makeEngine(cap);
        const tex = createTexture2DArray(engine, 4, 4, 1, { mipMaps: false });

        uploadImageToArrayLayer(engine, tex, 0, fakeSource(), { invertY: false, premultiplyAlpha: true });

        const call = cap.copyCalls[0]!;
        expect((call.src as { flipY?: boolean }).flipY).toBe(false);
        expect((call.dst as { premultipliedAlpha?: boolean }).premultipliedAlpha).toBe(true);
    });

    it("rejects out-of-range or non-integer layer indices", () => {
        const cap: Captured = { copyCalls: [] };
        const engine = makeEngine(cap);
        const tex = createTexture2DArray(engine, 4, 4, 2, { mipMaps: false });

        expect(() => uploadImageToArrayLayer(engine, tex, 2, fakeSource())).toThrow(/\[0, 2\)/);
        expect(() => uploadImageToArrayLayer(engine, tex, -1, fakeSource())).toThrow(/\[0, 2\)/);
        expect(() => uploadImageToArrayLayer(engine, tex, 1.5, fakeSource())).toThrow(/integer/);
        expect(cap.copyCalls).toHaveLength(0);
    });
});

describe("loadImageToArrayLayer", () => {
    it("fetches, decodes, uploads and closes the bitmap", async () => {
        const cap: Captured = { copyCalls: [] };
        const engine = makeEngine(cap);
        const tex = createTexture2DArray(engine, 4, 4, 2, { mipMaps: false });

        const bmp = fakeSource();
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve({} as Blob) });
        const bitmapMock = vi.fn().mockResolvedValue(bmp);
        vi.stubGlobal("fetch", fetchMock);
        vi.stubGlobal("createImageBitmap", bitmapMock);

        await loadImageToArrayLayer(engine, tex, 1, "layer.png");

        expect(fetchMock).toHaveBeenCalledWith("layer.png");
        expect(cap.copyCalls).toHaveLength(1);
        expect(cap.copyCalls[0]!.dst.origin as unknown as number[]).toEqual([0, 0, 1]);
        expect(bmp.close).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("throws on a failed fetch", async () => {
        const cap: Captured = { copyCalls: [] };
        const engine = makeEngine(cap);
        const tex = createTexture2DArray(engine, 4, 4, 1, { mipMaps: false });
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

        await expect(loadImageToArrayLayer(engine, tex, 0, "missing.png")).rejects.toThrow(/404/);
        vi.unstubAllGlobals();
    });
});

describe("createTexture2DArrayFromUrls", () => {
    it("builds an array sized to the images and uploads every layer in order", async () => {
        const cap: Captured = { copyCalls: [] };
        const engine = makeEngine(cap);
        const bmps = [fakeSource(8, 8), fakeSource(8, 8), fakeSource(8, 8)];
        let n = 0;
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve({} as Blob) }));
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn().mockImplementation(() => Promise.resolve(bmps[n++]))
        );

        const tex: Texture2DArray = await createTexture2DArrayFromUrls(engine, ["a.png", "b.png", "c.png"], { mipMaps: false });

        expect(tex.layers).toBe(3);
        expect(cap.createDesc?.size).toEqual({ width: 8, height: 8, depthOrArrayLayers: 3 });
        expect(cap.copyCalls.map((c) => (c.dst.origin as unknown as number[])[2])).toEqual([0, 1, 2]);
        for (const b of bmps) {
            expect(b.close).toHaveBeenCalled();
        }
        vi.unstubAllGlobals();
    });

    it("rejects mismatched layer sizes and closes decoded bitmaps", async () => {
        const cap: Captured = { copyCalls: [] };
        const engine = makeEngine(cap);
        const bmps = [fakeSource(8, 8), fakeSource(4, 4)];
        let n = 0;
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve({} as Blob) }));
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn().mockImplementation(() => Promise.resolve(bmps[n++]))
        );

        await expect(createTexture2DArrayFromUrls(engine, ["a.png", "b.png"])).rejects.toThrow(/same size|share one size/);
        for (const b of bmps) {
            expect(b.close).toHaveBeenCalled();
        }
        vi.unstubAllGlobals();
    });

    it("closes already-decoded layers when another layer fails to load", async () => {
        const cap: Captured = { copyCalls: [] };
        const engine = makeEngine(cap);
        const good = fakeSource(8, 8);
        let n = 0;
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve({} as Blob) }));
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn().mockImplementation(() => {
                const i = n++;
                return i === 0 ? Promise.resolve(good) : Promise.reject(new Error("decode failed"));
            })
        );

        await expect(createTexture2DArrayFromUrls(engine, ["a.png", "b.png"])).rejects.toThrow(/decode failed/);
        // The layer that decoded before the failure must not leak.
        expect(good.close).toHaveBeenCalled();
        expect(cap.copyCalls).toHaveLength(0);
        vi.unstubAllGlobals();
    });

    it("requires at least one URL (enforced by the tuple type)", () => {
        // Compile-only: the tuple type rejects an empty array. Never executed.
        const _typecheck = () =>
            // @ts-expect-error empty array is not assignable to readonly [string, ...string[]]
            createTexture2DArrayFromUrls(makeEngine({ copyCalls: [] }), []);
        expect(typeof _typecheck).toBe("function");
    });
});
