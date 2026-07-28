import { describe, expect, it, vi } from "vitest";

/**
 * `RawTexture2DArray` + the `rawTexture2DArray.functions` helpers wrap Babylon
 * Lite's texture-array API (`createTexture2DArray` / `uploadImageToArrayLayer` /
 * `loadImageToArrayLayer` / `createTexture2DArrayFromUrls`). The real uploads need
 * a GPU device, so these tests mock the Lite factories to plain handles and verify
 * the compat surface GPU-free: forwarding + option mapping, the supported vs.
 * throwing (raw-bytes) paths, and the `_fromLite` construction path.
 */
vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        createTexture2DArray: vi.fn((_engine: unknown, width: number, height: number, layers: number) => ({ width, height, layers, _tag: "array" })),
        uploadImageToArrayLayer: vi.fn(),
        loadImageToArrayLayer: vi.fn(async () => undefined),
        createTexture2DArrayFromUrls: vi.fn(async (_engine: unknown, urls: readonly string[]) => ({ width: 4, height: 4, layers: urls.length, _tag: "array" })),
    };
});

import { createTexture2DArray, uploadImageToArrayLayer, loadImageToArrayLayer, createTexture2DArrayFromUrls } from "babylon-lite";
import {
    RawTexture2DArray,
    UploadImageToTexture2DArrayLayer,
    LoadImageToTexture2DArrayLayerAsync,
    CreateTexture2DArrayFromImageUrlsAsync,
} from "../src/textures/raw-texture-2d-array";
import { BaseTexture } from "../src/textures/textures";
import { LiteCompatError } from "../src/error";

const createArrayMock = vi.mocked(createTexture2DArray);
const uploadMock = vi.mocked(uploadImageToArrayLayer);
const loadMock = vi.mocked(loadImageToArrayLayer);
const fromUrlsMock = vi.mocked(createTexture2DArrayFromUrls);

const liteEngine = {};
function fakeScene(): { getEngine(): { _lite: object } } {
    const engine = { _lite: liteEngine };
    return { getEngine: () => engine };
}

const fakeSource = {} as ImageBitmap;

describe("RawTexture2DArray", () => {
    it("is a BaseTexture flagged 2DArray, and allocates an empty Lite array (data = null)", () => {
        createArrayMock.mockClear();
        const tex = new RawTexture2DArray(null, 8, 4, 3, 5, fakeScene() as never, true);
        expect(tex).toBeInstanceOf(BaseTexture);
        expect(tex.getClassName()).toBe("RawTexture2DArray");
        expect(tex.is2DArray).toBe(true);
        expect(tex.format).toBe(5);
        expect(tex.depth).toBe(3);
        expect(createArrayMock).toHaveBeenCalledTimes(1);
        const call = createArrayMock.mock.calls[0]!;
        expect([call[1], call[2], call[3]]).toEqual([8, 4, 3]);
        expect(call[4]).toEqual({ mipMaps: true });
    });

    it("throws for the raw-bytes constructor path (data !== null)", () => {
        expect(() => new RawTexture2DArray(new Uint8Array(4), 1, 1, 1, 5, fakeScene() as never)).toThrow(LiteCompatError);
    });

    it("throws on the raw-bytes update / updateMipLevel / CreateRGBATexture helpers", () => {
        const tex = new RawTexture2DArray(null, 1, 1, 1, 5, fakeScene() as never);
        expect(() => tex.update(new Uint8Array(4))).toThrow(LiteCompatError);
        expect(() => tex.updateMipLevel(new Uint8Array(4), 0)).toThrow(LiteCompatError);
        expect(() => RawTexture2DArray.CreateRGBATexture(new Uint8Array(4), 1, 1, 1, fakeScene() as never)).toThrow(LiteCompatError);
    });

    it("resolves whenReadyAsync immediately", async () => {
        const tex = new RawTexture2DArray(null, 1, 1, 1, 5, fakeScene() as never);
        await expect(tex.whenReadyAsync()).resolves.toBeUndefined();
    });
});

describe("UploadImageToTexture2DArrayLayer", () => {
    it("forwards the source/layer to Lite with BJS default invertY = false", () => {
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
        expect(call[2]).toEqual({ mipMaps: false });
        expect(tex).toBeInstanceOf(RawTexture2DArray);
        expect(tex.depth).toBe(3);
        expect(tex.format).toBe(5);
        expect(tex.getScene()).toBeDefined();
    });
});
