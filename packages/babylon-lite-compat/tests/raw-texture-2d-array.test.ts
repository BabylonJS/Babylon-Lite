import { describe, expect, it, vi } from "vitest";

/**
 * `RawTexture2DArray` + the `rawTexture2DArray.functions` helpers wrap Babylon
 * Lite's texture-array API (`createTexture2DArray` / `createTexture2DArrayFromPixels`
 * / `updateTexture2DArrayFromPixels` / `uploadImageToArrayLayer` /
 * `loadImageToArrayLayer` / `createTexture2DArrayFromUrls`). The real uploads need a
 * GPU device, so these tests mock the Lite factories to plain handles and verify the
 * compat surface GPU-free: forwarding, option mapping (notably BJS's `invertY = false`
 * default vs. Lite's `true`), the raw-bytes paths, and `_fromLite` construction.
 */
vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    const makeArray = (width: number, height: number, layers: number) => ({ width, height, layers, _tag: "array" });
    return {
        ...actual,
        createTexture2DArray: vi.fn((_engine: unknown, width: number, height: number, layers: number) => makeArray(width, height, layers)),
        createTexture2DArrayFromPixels: vi.fn((_engine: unknown, _data: Uint8Array, width: number, height: number, layers: number) => makeArray(width, height, layers)),
        updateTexture2DArrayFromPixels: vi.fn(),
        uploadImageToArrayLayer: vi.fn(),
        loadImageToArrayLayer: vi.fn(async () => undefined),
        createTexture2DArrayFromUrls: vi.fn(async (_engine: unknown, urls: readonly string[]) => makeArray(4, 4, urls.length)),
        createTexture2DArrayFromKtx2: vi.fn(async () => makeArray(16, 16, 4)),
    };
});

import {
    createTexture2DArray,
    createTexture2DArrayFromPixels,
    updateTexture2DArrayFromPixels,
    uploadImageToArrayLayer,
    loadImageToArrayLayer,
    createTexture2DArrayFromUrls,
    createTexture2DArrayFromKtx2,
} from "babylon-lite";
import {
    RawTexture2DArray,
    UploadImageToTexture2DArrayLayer,
    LoadImageToTexture2DArrayLayerAsync,
    CreateTexture2DArrayFromImageUrlsAsync,
    CreateTexture2DArrayFromKTX2Async,
} from "../src/textures/raw-texture-2d-array";
import { BaseTexture } from "../src/textures/textures";
import { LiteCompatError } from "../src/error";
import { AbstractEngine } from "../src/engine/engine";
import { Constants } from "../src/misc/engine-constants";

const createArrayMock = vi.mocked(createTexture2DArray);
const createFromPixelsMock = vi.mocked(createTexture2DArrayFromPixels);
const updateFromPixelsMock = vi.mocked(updateTexture2DArrayFromPixels);
const uploadMock = vi.mocked(uploadImageToArrayLayer);
const loadMock = vi.mocked(loadImageToArrayLayer);
const fromUrlsMock = vi.mocked(createTexture2DArrayFromUrls);
const fromKtx2Mock = vi.mocked(createTexture2DArrayFromKtx2);

const liteEngine = {};

/**
 * A scene stand-in whose engine borrows the real `AbstractEngine.updateTextureArrayLayerFromImageSource`
 * implementation, so the image-source helpers are exercised through the same engine
 * hop Babylon.js takes (helper → engine extension → backend upload).
 */
function fakeScene(): { getEngine(): { _lite: object } } {
    const engine = {
        _lite: liteEngine,
        updateTextureArrayLayerFromImageSource: AbstractEngine.prototype.updateTextureArrayLayerFromImageSource,
    };
    return { getEngine: () => engine };
}

const fakeSource = {} as ImageBitmap;

describe("RawTexture2DArray", () => {
    it("is a BaseTexture flagged 2DArray, and allocates an empty Lite array (data = null)", () => {
        createArrayMock.mockClear();
        createFromPixelsMock.mockClear();
        const tex = new RawTexture2DArray(null, 8, 4, 3, 5, fakeScene() as never, true);
        expect(tex).toBeInstanceOf(BaseTexture);
        expect(tex.getClassName()).toBe("RawTexture2DArray");
        expect(tex.is2DArray).toBe(true);
        expect(tex.format).toBe(5);
        expect(tex.depth).toBe(3);
        expect(createFromPixelsMock).not.toHaveBeenCalled();
        expect(createArrayMock).toHaveBeenCalledTimes(1);
        const call = createArrayMock.mock.calls[0]!;
        expect([call[1], call[2], call[3]]).toEqual([8, 4, 3]);
        expect(call[4]).toEqual({ mipMaps: true });
    });

    it("uploads raw multi-layer bytes through Lite's pixel path (data !== null)", () => {
        createArrayMock.mockClear();
        createFromPixelsMock.mockClear();
        const data = new Uint8Array(2 * 2 * 3 * 4).fill(7);
        const tex = new RawTexture2DArray(data, 2, 2, 3, 5, fakeScene() as never, false);
        expect(tex.depth).toBe(3);
        expect(createArrayMock).not.toHaveBeenCalled();
        expect(createFromPixelsMock).toHaveBeenCalledTimes(1);
        const call = createFromPixelsMock.mock.calls[0]!;
        expect(call[0]).toBe(liteEngine);
        expect(call[1]).toEqual(data);
        expect([call[2], call[3], call[4]]).toEqual([2, 2, 3]);
        expect(call[5]).toEqual({ mipMaps: false });
    });

    it("coerces a non-Uint8Array view and trims to width*height*layers*4", () => {
        createFromPixelsMock.mockClear();
        // 2 extra trailing bytes past the 1x1x2 RGBA payload must not be uploaded.
        const view = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 9]);
        new RawTexture2DArray(view, 1, 1, 2, 5, fakeScene() as never);
        expect(Array.from(createFromPixelsMock.mock.calls[0]![1])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("update() re-uploads the base mip of every layer", () => {
        updateFromPixelsMock.mockClear();
        const tex = new RawTexture2DArray(null, 4, 4, 2, 5, fakeScene() as never);
        const data = new Uint8Array(4 * 4 * 2 * 4).fill(3);
        tex.update(data);
        expect(updateFromPixelsMock).toHaveBeenCalledTimes(1);
        const call = updateFromPixelsMock.mock.calls[0]!;
        expect(call[0]).toBe(liteEngine);
        expect(call[1]).toBe(tex._liteArray);
        expect(call[2]).toEqual(data);
        expect(call[3]).toBe(0);
    });

    it("updateMipLevel() sizes the payload to the requested mip level", () => {
        updateFromPixelsMock.mockClear();
        const tex = new RawTexture2DArray(null, 8, 8, 2, 5, fakeScene() as never);
        // Mip 1 of an 8x8x2 array is 4x4x2 RGBA = 128 bytes.
        tex.updateMipLevel(new Uint8Array(256).fill(1), 1);
        const call = updateFromPixelsMock.mock.calls[0]!;
        expect(call[2].length).toBe(4 * 4 * 2 * 4);
        expect(call[3]).toBe(1);
    });

    it("CreateRGBATexture builds an RGBA-format array from raw bytes", () => {
        createFromPixelsMock.mockClear();
        const tex = RawTexture2DArray.CreateRGBATexture(new Uint8Array(1 * 1 * 2 * 4), 1, 1, 2, fakeScene() as never);
        expect(tex).toBeInstanceOf(RawTexture2DArray);
        expect(tex.format).toBe(5);
        expect(tex.depth).toBe(2);
        expect(createFromPixelsMock).toHaveBeenCalledTimes(1);
    });

    it("exposes the Lite array handle as the internal texture", () => {
        const tex = new RawTexture2DArray(null, 4, 4, 2, 5, fakeScene() as never);
        expect(tex.getInternalTexture()).toBe(tex._liteArray);
    });

    it("resolves whenReadyAsync immediately", async () => {
        const tex = new RawTexture2DArray(null, 1, 1, 1, 5, fakeScene() as never);
        await expect(tex.whenReadyAsync()).resolves.toBeUndefined();
    });
});

describe("UploadImageToTexture2DArrayLayer", () => {
    it("forwards the source/layer to Lite via the engine extension, with BJS default invertY = false", () => {
        uploadMock.mockClear();
        const tex = new RawTexture2DArray(null, 4, 4, 2, 5, fakeScene() as never);
        UploadImageToTexture2DArrayLayer(tex, fakeSource, 1);
        expect(uploadMock).toHaveBeenCalledTimes(1);
        const call = uploadMock.mock.calls[0]!;
        expect(call[0]).toBe(liteEngine);
        expect(call[1]).toBe(tex._liteArray);
        expect(call[2]).toBe(1);
        expect(call[3]).toBe(fakeSource);
        expect(call[4]).toEqual({ invertY: false, premultiplyAlpha: false });
    });

    it("threads explicit invertY / premultiplyAlpha through", () => {
        uploadMock.mockClear();
        const tex = new RawTexture2DArray(null, 4, 4, 2, 5, fakeScene() as never);
        UploadImageToTexture2DArrayLayer(tex, fakeSource, 0, { invertY: true, premultiplyAlpha: true });
        expect(uploadMock.mock.calls[0]![4]).toEqual({ invertY: true, premultiplyAlpha: true });
    });

    it("rejects out-of-range / non-integer layers like Babylon.js", () => {
        uploadMock.mockClear();
        const tex = new RawTexture2DArray(null, 4, 4, 2, 5, fakeScene() as never);
        expect(() => UploadImageToTexture2DArrayLayer(tex, fakeSource, 2)).toThrow(/out of range/);
        expect(() => UploadImageToTexture2DArrayLayer(tex, fakeSource, -1)).toThrow(/out of range/);
        expect(() => UploadImageToTexture2DArrayLayer(tex, fakeSource, 1.5)).toThrow(/out of range/);
        expect(uploadMock).not.toHaveBeenCalled();
    });
});

describe("LoadImageToTexture2DArrayLayerAsync", () => {
    it("forwards the url/layer to Lite's loadImageToArrayLayer", async () => {
        loadMock.mockClear();
        const tex = new RawTexture2DArray(null, 4, 4, 2, 5, fakeScene() as never);
        await LoadImageToTexture2DArrayLayerAsync(tex, "grass.png", 1, { invertY: true });
        expect(loadMock).toHaveBeenCalledTimes(1);
        const call = loadMock.mock.calls[0]!;
        expect(call[1]).toBe(tex._liteArray);
        expect(call[2]).toBe(1);
        expect(call[3]).toBe("grass.png");
        expect(call[4]).toEqual({ invertY: true, premultiplyAlpha: false });
    });
});

describe("CreateTexture2DArrayFromImageUrlsAsync", () => {
    it("builds a RawTexture2DArray over Lite's createTexture2DArrayFromUrls", async () => {
        fromUrlsMock.mockClear();
        const tex = await CreateTexture2DArrayFromImageUrlsAsync(fakeScene() as never, ["a.png", "b.png", "c.png"], { generateMipMaps: false });
        expect(fromUrlsMock).toHaveBeenCalledTimes(1);
        const call = fromUrlsMock.mock.calls[0]!;
        expect(call[1]).toEqual(["a.png", "b.png", "c.png"]);
        // Lite's per-layer upload defaults invertY to true; BJS defaults it to false,
        // so the flag must be passed explicitly rather than left to the Lite default.
        expect(call[2]).toEqual({ mipMaps: false, invertY: false, premultiplyAlpha: false });
        expect(tex).toBeInstanceOf(RawTexture2DArray);
        expect(tex.depth).toBe(3);
        expect(tex.format).toBe(5);
        expect(tex.getScene()).toBeDefined();
    });

    it("threads invertY / premultiplyAlpha into the Lite call", async () => {
        fromUrlsMock.mockClear();
        await CreateTexture2DArrayFromImageUrlsAsync(fakeScene() as never, ["a.png"], { invertY: true, premultiplyAlpha: true });
        expect(fromUrlsMock.mock.calls[0]![2]).toEqual({ mipMaps: true, invertY: true, premultiplyAlpha: true });
    });
});

describe("CreateTexture2DArrayFromKTX2Async", () => {
    it("forwards a pre-fetched buffer to Lite's createTexture2DArrayFromKtx2 (BJS default generateMipMaps = true)", async () => {
        fromKtx2Mock.mockClear();
        const buffer = new Uint8Array([1, 2, 3, 4]);
        const tex = await CreateTexture2DArrayFromKTX2Async(fakeScene() as never, buffer);
        expect(fromKtx2Mock).toHaveBeenCalledTimes(1);
        const call = fromKtx2Mock.mock.calls[0]!;
        expect(call[0]).toBe(liteEngine);
        expect(call[1]).toBe(buffer);
        expect(call[2]).toEqual({
            generateMipMaps: true,
            invertY: false,
            minFilter: "linear",
            magFilter: "linear",
            mipmapFilter: "linear",
        });
        expect(tex).toBeInstanceOf(RawTexture2DArray);
        expect(tex.depth).toBe(4);
        expect(tex.format).toBe(5);
    });

    it("threads an explicit generateMipMaps = false through", async () => {
        fromKtx2Mock.mockClear();
        await CreateTexture2DArrayFromKTX2Async(fakeScene() as never, new Uint8Array(4), {
            generateMipMaps: false,
            invertY: true,
            samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
        });
        expect(fromKtx2Mock.mock.calls[0]![2]).toEqual({
            generateMipMaps: false,
            invertY: true,
            minFilter: "nearest",
            magFilter: "nearest",
            mipmapFilter: "nearest",
        });
    });

    it("fetches a URL string, then forwards the decoded bytes", async () => {
        fromKtx2Mock.mockClear();
        const bytes = new Uint8Array([9, 9, 9, 9]).buffer;
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, arrayBuffer: async () => bytes } as Response);
        try {
            await CreateTexture2DArrayFromKTX2Async(fakeScene() as never, "atlas.ktx2");
            expect(fetchSpy).toHaveBeenCalledWith("atlas.ktx2");
            expect(Array.from(fromKtx2Mock.mock.calls[0]![1] as Uint8Array)).toEqual([9, 9, 9, 9]);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("rejects a failed URL fetch", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" } as Response);
        try {
            await expect(CreateTexture2DArrayFromKTX2Async(fakeScene() as never, "missing.ktx2")).rejects.toThrow(/Failed to fetch KTX2/);
        } finally {
            fetchSpy.mockRestore();
        }
    });
});

describe("CreateTexture2DArrayFromKTX2Async", () => {
    // Justified throwing stub: Lite's KTX2 decoder models single-image 2D textures
    // only (no per-array-layer RGBA output), and adding a multi-layer decode path
    // means changing the bundled `ktx2-loader.ts` — a Lite-core design task, not a
    // mechanical compat addition. See the 🔧 Needs Lite core row in COMPAT-STATUS.
    it("rejects with a LiteCompatError until Lite exposes a multi-layer KTX2 decode", async () => {
        await expect(CreateTexture2DArrayFromKTX2Async(fakeScene() as never, "atlas.ktx2")).rejects.toBeInstanceOf(LiteCompatError);
    });
});
