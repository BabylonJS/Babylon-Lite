import { afterEach, describe, expect, it, vi } from "vitest";
import {
    GLSamplingMode,
    clearDynamicTextureSource,
    createDynamicTexture,
    createGLEngine,
    createHtmlElementTexture,
    createRawTexture,
    createTextureFromHandle,
    generateTextureMipMaps,
    getSamplingModeFilters,
    loadTexture2D,
    updateDynamicTexture,
    updateRawTexture,
    updateHtmlElementTexture,
    updateTextureSamplingMode,
    isTextureReady,
    disposeTexture,
} from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL, fireLost, fireRestored, type MockGL } from "./_lite-gl-mock";

function setup() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    return { mock, canvas, engine, gl: engine.gl };
}

/** Last `[min, mag]` filters passed to `gl.texParameteri`. */
function filters(mock: MockGL, gl: WebGL2RenderingContext): [unknown, unknown] {
    const last = (pname: number): unknown => mock.log.filter((c) => c.name === "texParameteri" && c.args[1] === pname).at(-1)?.args[2];
    return [last(gl.TEXTURE_MIN_FILTER), last(gl.TEXTURE_MAG_FILTER)];
}

function raw(engine: ReturnType<typeof createGLEngine>, options?: Parameters<typeof createRawTexture>[6]) {
    return createRawTexture(engine, new Uint8Array(4), 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE, options);
}

function fakeSource(width: number, height: number): TexImageSource {
    return { width, height } as unknown as TexImageSource;
}

function pixelStore(mock: MockGL, pname: number): unknown {
    return mock.log.filter((c) => c.name === "pixelStorei" && c.args[0] === pname).at(-1)?.args[1];
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("lite-gl getSamplingModeFilters (#81)", () => {
    it("maps presets like Babylon's _getSamplingParameters, without mipmaps by default", () => {
        const { gl } = setup();
        expect(getSamplingModeFilters(GLSamplingMode.NEAREST)).toEqual({ minFilter: gl.NEAREST, magFilter: gl.NEAREST });
        expect(getSamplingModeFilters(GLSamplingMode.BILINEAR)).toEqual({ minFilter: gl.LINEAR, magFilter: gl.LINEAR });
        expect(getSamplingModeFilters(GLSamplingMode.TRILINEAR)).toEqual({ minFilter: gl.LINEAR, magFilter: gl.LINEAR });
    });

    it("only TRILINEAR uses a mipmapped min filter when useMipMaps is true (≙ Babylon modes 1/2/3)", () => {
        const { gl } = setup();
        expect(getSamplingModeFilters(GLSamplingMode.NEAREST, true)).toEqual({ minFilter: gl.NEAREST, magFilter: gl.NEAREST });
        expect(getSamplingModeFilters(GLSamplingMode.BILINEAR, true)).toEqual({ minFilter: gl.LINEAR, magFilter: gl.LINEAR });
        expect(getSamplingModeFilters(GLSamplingMode.TRILINEAR, true)).toEqual({ minFilter: gl.LINEAR_MIPMAP_LINEAR, magFilter: gl.LINEAR });
    });

    it("spreads into factory options, with later explicit filters taking precedence", () => {
        const { mock, engine, gl } = setup();
        raw(engine);
        expect(filters(mock, gl)).toEqual([gl.LINEAR, gl.LINEAR]);
        raw(engine, { ...getSamplingModeFilters(GLSamplingMode.NEAREST) });
        expect(filters(mock, gl)).toEqual([gl.NEAREST, gl.NEAREST]);
        raw(engine, { ...getSamplingModeFilters(GLSamplingMode.NEAREST), minFilter: gl.LINEAR });
        expect(filters(mock, gl)).toEqual([gl.LINEAR, gl.NEAREST]);
        createDynamicTexture(engine, 4, 4, { ...getSamplingModeFilters(GLSamplingMode.TRILINEAR, true) });
        expect(filters(mock, gl)).toEqual([gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR]);
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("feeds updateTextureSamplingMode", () => {
        const { mock, engine, gl } = setup();
        const tex = raw(engine);
        mock.clear();
        const { minFilter, magFilter } = getSamplingModeFilters(GLSamplingMode.NEAREST);
        updateTextureSamplingMode(tex, minFilter, magFilter);
        expect(filters(mock, gl)).toEqual([gl.NEAREST, gl.NEAREST]);
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("updateTextureSamplingMode accepts a preset like Babylon's (no mips by default)", () => {
        const { mock, engine, gl } = setup();
        const tex = raw(engine);
        mock.clear();
        updateTextureSamplingMode(tex, GLSamplingMode.TRILINEAR);
        expect(filters(mock, gl)).toEqual([gl.LINEAR, gl.LINEAR]);
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("updateTextureSamplingMode preset with generateMipMaps generates and retains the chain", () => {
        const { mock, engine, gl } = setup();
        const tex = raw(engine);
        mock.clear();
        updateTextureSamplingMode(tex, GLSamplingMode.TRILINEAR, true);
        expect(filters(mock, gl)).toEqual([gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR]);
        expect(mock.count("generateMipmap")).toBe(1);
        updateRawTexture(tex, new Uint8Array(4));
        expect(mock.count("generateMipmap")).toBe(2);
    });

    it("updateTextureSamplingMode preset ignores generateMipMaps for non-mipmapped presets (≙ Babylon hasMipMaps)", () => {
        const { mock, engine, gl } = setup();
        const tex = raw(engine);
        mock.clear();
        updateTextureSamplingMode(tex, GLSamplingMode.BILINEAR, true);
        expect(filters(mock, gl)).toEqual([gl.LINEAR, gl.LINEAR]);
        expect(mock.count("generateMipmap")).toBe(0);
        expect(tex._hasMipMaps).not.toBe(true);
    });

    it("updateTextureSamplingMode preset does not regenerate an existing chain", () => {
        const { mock, engine, gl } = setup();
        const tex = raw(engine);
        generateTextureMipMaps(tex);
        mock.clear();
        updateTextureSamplingMode(tex, GLSamplingMode.TRILINEAR, true);
        expect(filters(mock, gl)).toEqual([gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR]);
        expect(mock.count("generateMipmap")).toBe(0);
        expect(tex._hasMipMaps).toBe(true);
    });

    it("updateRawTexture applies per-update invertY / premultiplyAlpha and replays them on restore", () => {
        const { mock, canvas, engine, gl } = setup();
        const flags = (): [unknown, unknown] => {
            const last = (pname: number): unknown => mock.log.filter((c) => c.name === "pixelStorei" && c.args[0] === pname).at(-1)?.args[1];
            return [last(gl.UNPACK_FLIP_Y_WEBGL), last(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)];
        };
        const tex = raw(engine, { invertY: false, premultiplyAlpha: false });
        updateRawTexture(tex, new Uint8Array(4), { invertY: true, premultiplyAlpha: true });
        expect(flags()).toEqual([1, 1]);
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(flags()).toEqual([1, 1]);
        // Omitted flags fall back to the creation options.
        updateRawTexture(tex, new Uint8Array(4), { premultiplyAlpha: true });
        expect(flags()).toEqual([0, 1]);
        updateRawTexture(tex, new Uint8Array(4));
        expect(flags()).toEqual([0, 0]);
    });

    it("updateTextureSamplingMode preset uses mip filters once the texture has mipmaps", () => {
        const { mock, engine, gl } = setup();
        const tex = raw(engine);
        generateTextureMipMaps(tex);
        mock.clear();
        updateTextureSamplingMode(tex, GLSamplingMode.TRILINEAR);
        expect(filters(mock, gl)).toEqual([gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR]);
        updateTextureSamplingMode(tex, GLSamplingMode.NEAREST);
        expect(filters(mock, gl)).toEqual([gl.NEAREST, gl.NEAREST]);
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("createTextureFromHandle applies spread preset filters once, without uploading", () => {
        const { mock, engine, gl } = setup();
        const handle = gl.createTexture() as WebGLTexture;
        mock.clear();
        createTextureFromHandle(engine, handle, 4, 4, { ...getSamplingModeFilters(GLSamplingMode.TRILINEAR, true) });
        expect(filters(mock, gl)).toEqual([gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR]);
        expect(mock.count("texImage2D")).toBe(0);
    });
});

describe("lite-gl generateTextureMipMaps retains the mip intent (#81)", () => {
    it("generates now, and not before it is called", () => {
        const { mock, engine } = setup();
        const tex = raw(engine);
        updateRawTexture(tex, new Uint8Array(4));
        expect(mock.count("generateMipmap")).toBe(0);
        generateTextureMipMaps(tex);
        expect(mock.count("generateMipmap")).toBe(1);
    });

    it("rebuilds the chain after updateRawTexture and on context restore", () => {
        const { mock, canvas, engine } = setup();
        const tex = raw(engine);
        generateTextureMipMaps(tex);
        mock.clear();
        updateRawTexture(tex, new Uint8Array(4));
        expect(mock.count("texImage2D")).toBe(1);
        expect(mock.count("generateMipmap")).toBe(1);
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(mock.count("texImage2D")).toBe(1);
        expect(mock.count("generateMipmap")).toBe(1);
    });

    it("wraps the upload only once when called repeatedly", () => {
        const { mock, canvas, engine } = setup();
        const tex = raw(engine);
        generateTextureMipMaps(tex);
        generateTextureMipMaps(tex);
        expect(mock.count("generateMipmap")).toBe(2);
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(mock.count("generateMipmap")).toBe(1);
    });

    it("rebuilds the chain after each dynamic update and for the blank re-allocation on restore", () => {
        const { mock, canvas, engine } = setup();
        const tex = createDynamicTexture(engine, 4, 4);
        generateTextureMipMaps(tex);
        mock.clear();
        updateDynamicTexture(tex, fakeSource(4, 4));
        expect(mock.count("generateMipmap")).toBe(1);
        clearDynamicTextureSource(tex);
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(mock.count("generateMipmap")).toBe(1);
    });

    it("rebuilds the chain when the loadTexture2D image arrives", async () => {
        vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, blob: () => Promise.resolve({}) }));
        vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 8, height: 4, close: () => undefined } as ImageBitmap));
        const { mock, engine } = setup();
        let tex: ReturnType<typeof loadTexture2D> | undefined;
        const loaded = new Promise<void>((resolve) => {
            tex = loadTexture2D(engine, "x.png", undefined, () => resolve());
        });
        generateTextureMipMaps(tex!);
        mock.clear();
        await loaded;
        expect(mock.count("texImage2D")).toBe(1);
        expect(mock.count("generateMipmap")).toBe(1);
    });

    it("is a no-op while the context is lost", () => {
        const { mock, canvas, engine } = setup();
        const tex = raw(engine);
        fireLost(canvas);
        mock.clear();
        generateTextureMipMaps(tex);
        expect(mock.count("generateMipmap")).toBe(0);
    });
});

describe("lite-gl texture upload options (#81)", () => {
    it("dynamic size tracking prefers the source's intrinsic size", () => {
        const { engine } = setup();
        const tex = createDynamicTexture(engine, 4, 4);
        updateDynamicTexture(tex, { videoWidth: 32, videoHeight: 16, width: 1, height: 1 } as unknown as TexImageSource);
        expect([tex.width, tex.height]).toEqual([32, 16]);
    });

    it("html element textures honor premultiplyAlpha", () => {
        const { mock, engine, gl } = setup();
        createHtmlElementTexture(engine, fakeSource(2, 2) as HTMLCanvasElement, { premultiplyAlpha: true });
        expect(pixelStore(mock, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(1);
    });

    it("loadTexture2D decodes with the requested premultiplyAlpha / invertY", async () => {
        const decode = vi.fn((_blob: Blob, _opts: ImageBitmapOptions) => Promise.resolve({ width: 8, height: 4, close: () => undefined } as ImageBitmap));
        vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, blob: () => Promise.resolve({}) }));
        vi.stubGlobal("createImageBitmap", decode);
        const { mock, engine, gl } = setup();
        const loaded = new Promise<void>((resolve) => {
            loadTexture2D(engine, "x.png", { premultiplyAlpha: true, invertY: true, ...getSamplingModeFilters(GLSamplingMode.NEAREST) }, () => resolve());
        });
        expect(filters(mock, gl)).toEqual([gl.NEAREST, gl.NEAREST]);
        await loaded;
        expect(decode.mock.calls[0]?.[1]).toEqual({ premultiplyAlpha: "premultiply", imageOrientation: "flipY" });
    });
});

describe("lite-gl dynamic texture consistency (#81)", () => {
    it("tracks the uploaded source size and restores the blank size after clearing", () => {
        const { canvas, engine } = setup();
        const tex = createDynamicTexture(engine, 4, 4);
        updateDynamicTexture(tex, fakeSource(16, 8));
        expect([tex.width, tex.height]).toEqual([16, 8]);
        clearDynamicTextureSource(tex);
        fireLost(canvas);
        fireRestored(canvas);
        expect([tex.width, tex.height]).toEqual([4, 4]);
    });

    it("omitted update flags fall back to the creation options", () => {
        const { mock, engine, gl } = setup();
        const tex = createDynamicTexture(engine, 4, 4, { invertY: true, premultiplyAlpha: true });
        updateDynamicTexture(tex, fakeSource(4, 4), { invertY: false, premultiplyAlpha: false });
        updateDynamicTexture(tex, fakeSource(4, 4));
        expect(pixelStore(mock, gl.UNPACK_FLIP_Y_WEBGL)).toBe(1);
        expect(pixelStore(mock, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(1);
        updateDynamicTexture(tex, fakeSource(4, 4), { invertY: false });
        expect(pixelStore(mock, gl.UNPACK_FLIP_Y_WEBGL)).toBe(0);
        expect(pixelStore(mock, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(1);
    });
});

describe("lite-gl html element texture update options (#81)", () => {
    it("per-update flags override the creation options and are reused on restore", () => {
        const { mock, canvas, engine, gl } = setup();
        const tex = createHtmlElementTexture(engine, fakeSource(2, 2) as HTMLCanvasElement, { invertY: true });
        expect(pixelStore(mock, gl.UNPACK_FLIP_Y_WEBGL)).toBe(1);
        updateHtmlElementTexture(tex, { invertY: false, premultiplyAlpha: true });
        expect(pixelStore(mock, gl.UNPACK_FLIP_Y_WEBGL)).toBe(0);
        expect(pixelStore(mock, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(1);
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(mock.count("texImage2D")).toBe(1);
        expect(pixelStore(mock, gl.UNPACK_FLIP_Y_WEBGL)).toBe(0);
        expect(pixelStore(mock, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(1);
    });

    it("omitted update flags fall back to the creation options", () => {
        const { mock, engine, gl } = setup();
        const tex = createHtmlElementTexture(engine, fakeSource(2, 2) as HTMLCanvasElement, { invertY: true });
        updateHtmlElementTexture(tex, { invertY: false });
        updateHtmlElementTexture(tex);
        expect(pixelStore(mock, gl.UNPACK_FLIP_Y_WEBGL)).toBe(1);
    });
});

describe("lite-gl isTextureReady (#81)", () => {
    it("mirrors tex.isReady, and is false after disposal or while the context is lost", async () => {
        vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, blob: () => Promise.resolve({}) }));
        vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 8, height: 4, close: () => undefined } as ImageBitmap));
        const { canvas, engine } = setup();
        let tex: ReturnType<typeof loadTexture2D> | undefined;
        const loaded = new Promise<void>((resolve) => {
            tex = loadTexture2D(engine, "x.png", undefined, () => resolve());
        });
        expect(isTextureReady(tex!)).toBe(false);
        await loaded;
        expect(isTextureReady(tex!)).toBe(true);
        fireLost(canvas);
        expect(isTextureReady(tex!)).toBe(false);
        fireRestored(canvas);
        expect(isTextureReady(tex!)).toBe(true);
        disposeTexture(tex!);
        expect(isTextureReady(tex!)).toBe(false);
    });
});
