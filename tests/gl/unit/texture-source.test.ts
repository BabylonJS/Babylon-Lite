import { afterEach, describe, expect, it, vi } from "vitest";
import {
    bindTexture,
    createGLEngine,
    createRawTexture,
    createTextureFromSource,
    disposeGLEngine,
    disposeTexture,
    onContextRestored,
    type GLTextureSourceOptions,
} from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL, fireLost, fireRestored } from "./_lite-gl-mock";

function setup() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    mock.clear();
    return { mock, canvas, engine, gl: engine.gl };
}

function bitmap(width = 64, height = 32): ImageBitmap {
    return { width, height, close: vi.fn() } as ImageBitmap;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("lite-gl createTextureFromSource", () => {
    it("issues exactly one source upload and four sampling parameters, with no blank allocation", () => {
        const { mock, engine, gl } = setup();
        const source = bitmap();
        const tex = createTextureFromSource(engine, source);
        expect(mock.log).toEqual([
            { name: "createTexture", args: [] },
            { name: "pixelStorei", args: [gl.UNPACK_FLIP_Y_WEBGL, 0] },
            { name: "pixelStorei", args: [gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0] },
            { name: "pixelStorei", args: [gl.UNPACK_ALIGNMENT, 4] },
            { name: "bindTexture", args: [gl.TEXTURE_2D, tex.handle] },
            { name: "texImage2D", args: [gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE] },
        ]);
        expect(tex).toMatchObject({ target: gl.TEXTURE_2D, width: 64, height: 32, isReady: true });
        expect(Array.from(engine._textures)).toEqual([tex]);
        expect(source.close).not.toHaveBeenCalled();
        mock.clear();
        bindTexture(engine, 0, tex);
        expect(mock.log).toEqual([]);
    });

    it("honors unpack and sampling options without generating mipmaps", () => {
        const { mock, engine, gl } = setup();
        const source = bitmap();
        const options: GLTextureSourceOptions = {
            invertY: true,
            premultiplyAlpha: true,
            unpackAlignment: 1,
            minFilter: gl.NEAREST,
            magFilter: gl.NEAREST,
            wrapS: gl.REPEAT,
            wrapT: gl.MIRRORED_REPEAT,
        };
        const tex = createTextureFromSource(engine, source, options);
        expect(mock.log).toEqual([
            { name: "createTexture", args: [] },
            { name: "pixelStorei", args: [gl.UNPACK_FLIP_Y_WEBGL, 1] },
            { name: "pixelStorei", args: [gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1] },
            { name: "pixelStorei", args: [gl.UNPACK_ALIGNMENT, 1] },
            { name: "bindTexture", args: [gl.TEXTURE_2D, tex.handle] },
            { name: "texImage2D", args: [gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT] },
        ]);
    });

    it("elides unchanged unpack flags across consecutive texture creations", () => {
        const { mock, engine, gl } = setup();
        createTextureFromSource(engine, bitmap());
        mock.clear();
        const source = bitmap(20, 10);
        const tex = createTextureFromSource(engine, source);
        expect(mock.log).toEqual([
            { name: "createTexture", args: [] },
            { name: "bindTexture", args: [gl.TEXTURE_2D, tex.handle] },
            { name: "texImage2D", args: [gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE] },
        ]);
    });

    it("resets previous unpack flags and selects unit zero after multi-sampler use", () => {
        const { mock, engine, gl } = setup();
        const previous = createRawTexture(engine, null, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, {
            invertY: true,
            premultiplyAlpha: true,
            unpackAlignment: 1,
        });
        bindTexture(engine, 3, previous);
        mock.clear();
        const source = bitmap();
        const tex = createTextureFromSource(engine, source);
        expect(mock.log.slice(0, 7)).toEqual([
            { name: "createTexture", args: [] },
            { name: "pixelStorei", args: [gl.UNPACK_FLIP_Y_WEBGL, 0] },
            { name: "pixelStorei", args: [gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0] },
            { name: "pixelStorei", args: [gl.UNPACK_ALIGNMENT, 4] },
            { name: "activeTexture", args: [gl.TEXTURE0] },
            { name: "bindTexture", args: [gl.TEXTURE_2D, tex.handle] },
            { name: "texImage2D", args: [gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source] },
        ]);
        expect(engine._state.activeTextureUnit).toBe(0);
        expect(engine._state.boundTextures[0]).toBe(tex.handle);
        expect(engine._state.boundTextures[3]).toBe(previous.handle);
    });

    it.each([
        ["bitmap", { width: 80, height: 40 }],
        ["canvas", { width: 80, height: 40, getContext: () => null }],
        ["image data", { width: 80, height: 40, data: new Uint8ClampedArray(80 * 40 * 4) }],
        ["image", { width: 10, height: 5, naturalWidth: 80, naturalHeight: 40 }],
        ["video", { width: 10, height: 5, videoWidth: 80, videoHeight: 40, readyState: 2 }],
        ["video frame", { codedWidth: 100, codedHeight: 60, displayWidth: 80, displayHeight: 40 }],
    ])("reads intrinsic dimensions for %s without DOM constructor globals", (_name, source) => {
        const { engine } = setup();
        const tex = createTextureFromSource(engine, source as TexImageSource);
        expect([tex.width, tex.height]).toEqual([80, 40]);
    });

    it.each([
        [0, 32],
        [64, 0],
        [-1, 32],
        [64, -1],
        [1.5, 32],
        [64, NaN],
        [Infinity, 32],
        [4097, 32],
        [64, 4097],
    ])("rejects invalid intrinsic dimensions %s x %s before allocating", (width, height) => {
        const { mock, engine } = setup();
        expect(() => createTextureFromSource(engine, bitmap(width, height))).toThrow("source texture dimensions");
        expect(mock.log).toEqual([]);
        expect(engine._textures.size).toBe(0);
    });

    it("rejects an undecoded image instead of using its layout size", () => {
        const { mock, engine } = setup();
        const image = { width: 80, height: 40, naturalWidth: 0, naturalHeight: 0 } as HTMLImageElement;
        expect(() => createTextureFromSource(engine, image)).toThrow("source texture dimensions");
        expect(mock.log).toEqual([]);
    });

    it.each([0, 1])("rejects a video without a current frame at readyState %s before any GL call", (readyState) => {
        const { mock, engine } = setup();
        const source = { videoWidth: 80, videoHeight: 40, readyState } as HTMLVideoElement;
        expect(() => createTextureFromSource(engine, source)).toThrow("source video has no decoded current frame");
        expect(mock.log).toEqual([]);
        expect(engine._textures.size).toBe(0);
    });

    it.each([2, 3, 4])("uploads a video with a current frame at readyState %s exactly once", (readyState) => {
        const { mock, engine, gl } = setup();
        const source = { videoWidth: 80, videoHeight: 40, readyState } as HTMLVideoElement;
        const tex = createTextureFromSource(engine, source);
        expect(tex).toMatchObject({ width: 80, height: 40, isReady: true });
        expect(Array.from(engine._textures)).toEqual([tex]);
        expect(mock.log).toEqual([
            { name: "createTexture", args: [] },
            { name: "pixelStorei", args: [gl.UNPACK_FLIP_Y_WEBGL, 0] },
            { name: "pixelStorei", args: [gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0] },
            { name: "pixelStorei", args: [gl.UNPACK_ALIGNMENT, 4] },
            { name: "bindTexture", args: [gl.TEXTURE_2D, tex.handle] },
            { name: "texImage2D", args: [gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE] },
        ]);
    });

    it.each([0, 3, NaN])("rejects invalid unpack alignment %s before allocating", (unpackAlignment) => {
        const { mock, engine } = setup();
        expect(() => createTextureFromSource(engine, bitmap(), { unpackAlignment })).toThrow("unpackAlignment");
        expect(mock.log).toEqual([]);
    });

    it("accepts dimensions at the engine limit", () => {
        const { engine } = setup();
        const tex = createTextureFromSource(engine, bitmap(engine.caps.maxTextureSize, engine.caps.maxTextureSize));
        expect(tex.width).toBe(engine.caps.maxTextureSize);
        expect(tex.height).toBe(engine.caps.maxTextureSize);
    });

    it("throws on allocation failure without registering a texture", () => {
        const { engine, gl } = setup();
        const allocator: { createTexture(): WebGLTexture | null } = gl;
        vi.spyOn(allocator, "createTexture").mockReturnValueOnce(null);
        expect(() => createTextureFromSource(engine, bitmap())).toThrow("gl.createTexture returned null");
        expect(engine._textures.size).toBe(0);
    });

    it("cleans up a failed source upload and propagates the original error", () => {
        const { mock, engine, gl } = setup();
        const error = new Error("source is closed");
        vi.spyOn(gl, "texImage2D").mockImplementationOnce(() => {
            throw error;
        });
        expect(() => createTextureFromSource(engine, bitmap())).toThrow(error);
        expect(mock.count("deleteTexture")).toBe(1);
        expect(mock.count("texParameteri")).toBe(0);
        expect(engine._state.boundTextures[0]).toBeNull();
        expect(engine._textures.size).toBe(0);
    });

    it("throws without GL calls on a lost or disposed engine", () => {
        const { mock, canvas, engine } = setup();
        fireLost(canvas);
        mock.clear();
        expect(() => createTextureFromSource(engine, bitmap())).toThrow("lost or disposed engine");
        expect(mock.log).toEqual([]);
        disposeGLEngine(engine);
        mock.clear();
        expect(() => createTextureFromSource(engine, bitmap())).toThrow("lost or disposed engine");
        expect(mock.log).toEqual([]);
    });

    it("disposes once, removes the registry entry and clears all matching binding slots", () => {
        const { mock, canvas, engine, gl } = setup();
        const source = bitmap();
        const tex = createTextureFromSource(engine, source);
        bindTexture(engine, 2, tex);
        mock.clear();
        disposeTexture(engine, tex);
        disposeTexture(engine, tex);
        bindTexture(engine, 0, tex);
        expect(mock.log).toEqual([{ name: "deleteTexture", args: [tex.handle] }]);
        expect(engine._textures.size).toBe(0);
        expect(engine._state.boundTextures[0]).toBeNull();
        expect(engine._state.boundTextures[2]).toBeNull();
        expect(source.close).not.toHaveBeenCalled();
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(mock.count("createTexture")).toBe(0);
        expect(mock.count("texImage2D")).toBe(0);
        expect(tex.target).toBe(gl.TEXTURE_2D);
    });

    it("replays the retained source and creation parameters exactly once on each restoration", () => {
        const { mock, canvas, engine, gl } = setup();
        const source = bitmap();
        const tex = createTextureFromSource(engine, source, { invertY: true, premultiplyAlpha: true, unpackAlignment: 8, minFilter: gl.NEAREST, wrapS: gl.REPEAT });
        for (let cycle = 0; cycle < 2; cycle++) {
            const oldHandle = tex.handle;
            fireLost(canvas);
            expect(tex.isReady).toBe(false);
            mock.clear();
            fireRestored(canvas);
            expect(tex.handle).not.toBe(oldHandle);
            expect(tex.isReady).toBe(true);
            expect(Array.from(engine._textures)).toEqual([tex]);
            expect(mock.log).toEqual([
                { name: "createTexture", args: [] },
                { name: "pixelStorei", args: [gl.UNPACK_FLIP_Y_WEBGL, 1] },
                { name: "pixelStorei", args: [gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1] },
                { name: "pixelStorei", args: [gl.UNPACK_ALIGNMENT, 8] },
                { name: "bindTexture", args: [gl.TEXTURE_2D, tex.handle] },
                { name: "texImage2D", args: [gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source] },
                { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST] },
                { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR] },
                { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT] },
                { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE] },
            ]);
        }
        expect(source.close).not.toHaveBeenCalled();
    });

    it("replays the current intrinsic size of a retained mutable source", () => {
        const { mock, canvas, engine } = setup();
        const source = { width: 64, height: 32 } as OffscreenCanvas;
        const tex = createTextureFromSource(engine, source);
        source.width = 128;
        source.height = 16;
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect([tex.width, tex.height]).toEqual([128, 16]);
        expect(mock.log.find((call) => call.name === "texImage2D")?.args[5]).toBe(source);
    });

    it("restores a retained metadata-only video as blank and drops the source", () => {
        const { mock, canvas, engine, gl } = setup();
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const restored = vi.fn();
        onContextRestored(engine, restored);
        const source = { videoWidth: 80, videoHeight: 40, readyState: 2 };
        const tex = createTextureFromSource(engine, source as HTMLVideoElement);
        source.readyState = 1;
        for (let cycle = 0; cycle < 2; cycle++) {
            const oldHandle = tex.handle;
            fireLost(canvas);
            expect(tex.isReady).toBe(false);
            mock.clear();
            fireRestored(canvas);
            expect(tex.handle).not.toBe(oldHandle);
            expect(tex).toMatchObject({ width: 80, height: 40, isReady: true });
            expect(engine._isLost).toBe(false);
            expect(restored).toHaveBeenCalledTimes(cycle + 1);
            expect(errors).toHaveBeenCalledExactlyOnceWith(
                "lite-gl: retained texture source unusable on restore; restored blank",
                new Error("lite-gl: source video has no decoded current frame")
            );
            expect(mock.log).toEqual([
                { name: "createTexture", args: [] },
                { name: "pixelStorei", args: [gl.UNPACK_FLIP_Y_WEBGL, 0] },
                { name: "pixelStorei", args: [gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0] },
                { name: "pixelStorei", args: [gl.UNPACK_ALIGNMENT, 4] },
                { name: "bindTexture", args: [gl.TEXTURE_2D, tex.handle] },
                { name: "texImage2D", args: [gl.TEXTURE_2D, 0, gl.RGBA8, 80, 40, 0, gl.RGBA, gl.UNSIGNED_BYTE, null] },
                { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR] },
                { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR] },
                { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE] },
                { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE] },
            ]);
            Object.defineProperty(source, "readyState", {
                get: () => {
                    throw new Error("dropped video source read");
                },
            });
        }
    });

    it("uploads once without retention and restores blank at the original dimensions", () => {
        const { mock, canvas, engine, gl } = setup();
        const source = bitmap();
        const tex = createTextureFromSource(engine, source, { retainSource: false, magFilter: gl.NEAREST, wrapT: gl.REPEAT });
        expect(mock.log.filter((call) => call.name === "texImage2D")).toEqual([{ name: "texImage2D", args: [gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source] }]);
        source.close();
        // Closed/detached source dimensions must never be read during replay.
        Object.defineProperties(source, {
            width: {
                get: () => {
                    throw new Error("closed source read");
                },
            },
            height: {
                get: () => {
                    throw new Error("closed source read");
                },
            },
        });
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(tex.isReady).toBe(true);
        expect([tex.width, tex.height]).toEqual([64, 32]);
        expect(mock.log).toEqual([
            { name: "createTexture", args: [] },
            { name: "pixelStorei", args: [gl.UNPACK_FLIP_Y_WEBGL, 0] },
            { name: "pixelStorei", args: [gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0] },
            { name: "pixelStorei", args: [gl.UNPACK_ALIGNMENT, 4] },
            { name: "bindTexture", args: [gl.TEXTURE_2D, tex.handle] },
            { name: "texImage2D", args: [gl.TEXTURE_2D, 0, gl.RGBA8, 64, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, null] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE] },
            { name: "texParameteri", args: [gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT] },
        ]);
        expect(source.close).toHaveBeenCalledTimes(1);
    });

    it("rejects an ImageData with a transferred buffer before any GL call", () => {
        const { mock, engine } = setup();
        const data = new Uint8ClampedArray(4 * 4 * 4);
        const source = { width: 4, height: 4, data, colorSpace: "srgb" } as ImageData;
        structuredClone(data.buffer, { transfer: [data.buffer] });
        expect(data.length).toBe(0);
        expect(() => createTextureFromSource(engine, source)).toThrow(/detached/);
        expect(mock.log).toEqual([]);
        expect(engine._textures.size).toBe(0);
    });

    it("restores blank when a retained ImageData buffer is transferred after creation", () => {
        const { mock, canvas, engine, gl } = setup();
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const data = new Uint8ClampedArray(8 * 2 * 4);
        const source = { width: 8, height: 2, data, colorSpace: "srgb" } as ImageData;
        const tex = createTextureFromSource(engine, source);
        structuredClone(data.buffer, { transfer: [data.buffer] });
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(errors).toHaveBeenCalledTimes(1);
        expect(engine._isLost).toBe(false);
        expect(tex.isReady).toBe(true);
        expect(mock.log.filter((call) => call.name === "texImage2D")).toEqual([
            { name: "texImage2D", args: [gl.TEXTURE_2D, 0, gl.RGBA8, 8, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null] },
        ]);
    });

    it("restores a closed retained bitmap as blank without aborting the engine-wide restore", () => {
        const { mock, canvas, engine, gl } = setup();
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const source = bitmap();
        const tex = createTextureFromSource(engine, source);
        const later = createRawTexture(engine, null, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE);
        // ImageBitmap.close() reports 0x0 dimensions.
        Object.assign(source, { width: 0, height: 0 });
        fireLost(canvas);
        const laterHandle = later.handle;
        mock.clear();
        fireRestored(canvas);
        expect(errors).toHaveBeenCalledTimes(1);
        expect(engine._isLost).toBe(false);
        expect(later.handle).not.toBe(laterHandle);
        expect(later.isReady).toBe(true);
        expect(tex.isReady).toBe(true);
        expect([tex.width, tex.height]).toEqual([64, 32]);
        expect(mock.log.filter((call) => call.name === "texImage2D")[0]).toEqual({
            name: "texImage2D",
            args: [gl.TEXTURE_2D, 0, gl.RGBA8, 64, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, null],
        });

        // The unusable source is dropped: the next restore goes straight to blank.
        Object.defineProperty(source, "width", {
            get: () => {
                throw new Error("closed source read");
            },
        });
        fireLost(canvas);
        fireRestored(canvas);
        expect(errors).toHaveBeenCalledTimes(1);
        expect(engine._isLost).toBe(false);
    });

    it("falls back to blank at the last uploaded size when the restore upload throws", () => {
        const { mock, canvas, engine, gl } = setup();
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const source = { width: 64, height: 32 } as OffscreenCanvas;
        const tex = createTextureFromSource(engine, source, { minFilter: gl.NEAREST });
        source.width = 128;
        fireLost(canvas);
        const uploadError = new DOMException("detached", "InvalidStateError");
        vi.spyOn(gl, "texImage2D").mockImplementationOnce(() => {
            throw uploadError;
        });
        mock.clear();
        fireRestored(canvas);
        expect(errors).toHaveBeenCalledWith(expect.stringContaining("restored blank"), uploadError);
        expect(engine._isLost).toBe(false);
        expect(tex.isReady).toBe(true);
        expect([tex.width, tex.height]).toEqual([64, 32]);
        expect(mock.log.filter((call) => call.name === "texImage2D")).toEqual([
            { name: "texImage2D", args: [gl.TEXTURE_2D, 0, gl.RGBA8, 64, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, null] },
        ]);
        expect(mock.log.filter((call) => call.name === "texParameteri")[0]?.args).toEqual([gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST]);
    });
});
