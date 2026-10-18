import { afterEach, describe, expect, it, vi } from "vitest";
import {
    GLSamplingMode,
    clearDynamicTextureSource,
    createDynamicTexture,
    createGLEngine,
    createHtmlElementTexture,
    createRawTexture,
    createTextureFromHandle,
    loadTexture2D,
    updateDynamicTexture,
    updateRawTexture,
    updateTextureSamplingMode,
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

describe("lite-gl GLTextureOptions — samplingMode / generateMipMaps (#81)", () => {
    it("defaults to LINEAR / LINEAR without mipmaps", () => {
        const { mock, engine, gl } = setup();
        raw(engine);
        expect(filters(mock, gl)).toEqual([gl.LINEAR, gl.LINEAR]);
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("NEAREST preset → NEAREST / NEAREST", () => {
        const { mock, engine, gl } = setup();
        raw(engine, { samplingMode: GLSamplingMode.NEAREST });
        expect(filters(mock, gl)).toEqual([gl.NEAREST, gl.NEAREST]);
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("TRILINEAR preset generates mipmaps by default and uses LINEAR_MIPMAP_LINEAR", () => {
        const { mock, engine, gl } = setup();
        raw(engine, { samplingMode: GLSamplingMode.TRILINEAR });
        expect(filters(mock, gl)).toEqual([gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR]);
        expect(mock.count("generateMipmap")).toBe(1);
    });

    it("TRILINEAR with generateMipMaps: false never samples the (missing) mip chain", () => {
        const { mock, engine, gl } = setup();
        raw(engine, { samplingMode: GLSamplingMode.TRILINEAR, generateMipMaps: false });
        expect(filters(mock, gl)).toEqual([gl.LINEAR, gl.LINEAR]);
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("BILINEAR / NEAREST with generateMipMaps: true use Babylon's mipmapped min filters", () => {
        const { mock, engine, gl } = setup();
        raw(engine, { samplingMode: GLSamplingMode.BILINEAR, generateMipMaps: true });
        expect(filters(mock, gl)).toEqual([gl.LINEAR_MIPMAP_NEAREST, gl.LINEAR]);
        raw(engine, { samplingMode: GLSamplingMode.NEAREST, generateMipMaps: true });
        expect(filters(mock, gl)).toEqual([gl.NEAREST_MIPMAP_LINEAR, gl.NEAREST]);
        expect(mock.count("generateMipmap")).toBe(2);
    });

    it("explicit minFilter / magFilter take precedence over the preset", () => {
        const { mock, engine, gl } = setup();
        raw(engine, { samplingMode: GLSamplingMode.NEAREST, minFilter: gl.LINEAR });
        expect(filters(mock, gl)).toEqual([gl.LINEAR, gl.NEAREST]);
    });

    it("regenerates mipmaps on context restore", () => {
        const { mock, canvas, engine } = setup();
        raw(engine, { generateMipMaps: true });
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(mock.count("texImage2D")).toBe(1);
        expect(mock.count("generateMipmap")).toBe(1);
    });

    it("dynamic textures honor samplingMode and regenerate mips after each update", () => {
        const { mock, engine, gl } = setup();
        const tex = createDynamicTexture(engine, 4, 4, { samplingMode: GLSamplingMode.TRILINEAR });
        expect(filters(mock, gl)).toEqual([gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR]);
        mock.clear();
        updateDynamicTexture(engine, tex, fakeSource(4, 4));
        expect(mock.count("generateMipmap")).toBe(1);
    });

    it("blank dynamic textures build their mip chain so a mipmapped filter is complete", () => {
        const { mock, canvas, engine } = setup();
        const tex = createDynamicTexture(engine, 4, 4, { samplingMode: GLSamplingMode.TRILINEAR });
        expect(mock.count("generateMipmap")).toBe(1);
        updateDynamicTexture(engine, tex, fakeSource(4, 4));
        clearDynamicTextureSource(engine, tex);
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(mock.count("generateMipmap")).toBe(1);
    });

    it("dynamic size tracking prefers the source's intrinsic size", () => {
        const { engine } = setup();
        const tex = createDynamicTexture(engine, 4, 4);
        updateDynamicTexture(engine, tex, { videoWidth: 32, videoHeight: 16, width: 1, height: 1 } as unknown as TexImageSource);
        expect([tex.width, tex.height]).toEqual([32, 16]);
    });

    it("html element textures honor premultiplyAlpha", () => {
        const { mock, engine, gl } = setup();
        createHtmlElementTexture(engine, fakeSource(2, 2) as HTMLCanvasElement, { premultiplyAlpha: true });
        expect(pixelStore(mock, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(1);
    });

    it("createTextureFromHandle applies samplingMode and a one-shot mip generation", () => {
        const { mock, engine, gl } = setup();
        const handle = gl.createTexture() as WebGLTexture;
        mock.clear();
        createTextureFromHandle(engine, handle, 4, 4, { samplingMode: GLSamplingMode.TRILINEAR });
        expect(filters(mock, gl)).toEqual([gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR]);
        expect(mock.count("generateMipmap")).toBe(1);
        expect(mock.count("texImage2D")).toBe(0);
    });

    it("loadTexture2D decodes with the requested premultiplyAlpha / invertY", async () => {
        const decode = vi.fn((_blob: Blob, _opts: ImageBitmapOptions) => Promise.resolve({ width: 8, height: 4, close: () => undefined } as ImageBitmap));
        vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, blob: () => Promise.resolve({}) }));
        vi.stubGlobal("createImageBitmap", decode);
        const { mock, engine, gl } = setup();
        const loaded = new Promise<void>((resolve) => {
            loadTexture2D(engine, "x.png", { premultiplyAlpha: true, invertY: true, samplingMode: GLSamplingMode.NEAREST }, () => resolve());
        });
        expect(filters(mock, gl)).toEqual([gl.NEAREST, gl.NEAREST]);
        await loaded;
        expect(decode.mock.calls[0]?.[1]).toEqual({ premultiplyAlpha: "premultiply", imageOrientation: "flipY" });
    });
});

describe("lite-gl updateTextureSamplingMode overloads (#81)", () => {
    it("preset form resolves Babylon filters", () => {
        const { mock, engine, gl } = setup();
        const tex = raw(engine);
        mock.clear();
        updateTextureSamplingMode(engine, tex, GLSamplingMode.NEAREST);
        expect(filters(mock, gl)).toEqual([gl.NEAREST, gl.NEAREST]);
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("preset form with generateMipMaps: true generates the mip chain once", () => {
        const { mock, engine, gl } = setup();
        const tex = raw(engine);
        mock.clear();
        updateTextureSamplingMode(engine, tex, GLSamplingMode.TRILINEAR, true);
        expect(filters(mock, gl)).toEqual([gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR]);
        expect(mock.count("generateMipmap")).toBe(1);
    });

    it("preset form keeps the mip chain of a texture that already uses mips (≙ Babylon useMipMaps)", () => {
        const { mock, engine, gl } = setup();
        const tex = raw(engine, { samplingMode: GLSamplingMode.TRILINEAR });
        mock.clear();
        updateTextureSamplingMode(engine, tex, GLSamplingMode.TRILINEAR);
        expect(filters(mock, gl)).toEqual([gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR]);
        updateTextureSamplingMode(engine, tex, GLSamplingMode.NEAREST);
        expect(filters(mock, gl)).toEqual([gl.NEAREST_MIPMAP_LINEAR, gl.NEAREST]);
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("preset form with generateMipMaps: true keeps mips up to date on later uploads and restore", () => {
        const { mock, canvas, engine, gl } = setup();
        const tex = raw(engine);
        updateTextureSamplingMode(engine, tex, GLSamplingMode.BILINEAR, true);
        mock.clear();
        updateRawTexture(engine, tex, new Uint8Array(4));
        expect(mock.count("generateMipmap")).toBe(1);
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(mock.count("generateMipmap")).toBe(1);
        // A later preset update without the flag still samples the (rebuilt) chain.
        updateTextureSamplingMode(engine, tex, GLSamplingMode.BILINEAR);
        expect(filters(mock, gl)[0]).toBe(gl.LINEAR_MIPMAP_NEAREST);
    });

    it("raw form still sets the given GL filters", () => {
        const { mock, engine, gl } = setup();
        const tex = raw(engine);
        mock.clear();
        updateTextureSamplingMode(engine, tex, gl.NEAREST, gl.LINEAR);
        expect(filters(mock, gl)).toEqual([gl.NEAREST, gl.LINEAR]);
    });
});

describe("lite-gl dynamic texture consistency (#81)", () => {
    it("tracks the uploaded source size and restores the blank size after clearing", () => {
        const { canvas, engine } = setup();
        const tex = createDynamicTexture(engine, 4, 4);
        updateDynamicTexture(engine, tex, fakeSource(16, 8));
        expect([tex.width, tex.height]).toEqual([16, 8]);
        clearDynamicTextureSource(engine, tex);
        fireLost(canvas);
        fireRestored(canvas);
        expect([tex.width, tex.height]).toEqual([4, 4]);
    });

    it("omitted update flags fall back to the creation options", () => {
        const { mock, engine, gl } = setup();
        const tex = createDynamicTexture(engine, 4, 4, { invertY: true, premultiplyAlpha: true });
        updateDynamicTexture(engine, tex, fakeSource(4, 4), false, false);
        updateDynamicTexture(engine, tex, fakeSource(4, 4));
        expect(pixelStore(mock, gl.UNPACK_FLIP_Y_WEBGL)).toBe(1);
        expect(pixelStore(mock, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(1);
        updateDynamicTexture(engine, tex, fakeSource(4, 4), false);
        expect(pixelStore(mock, gl.UNPACK_FLIP_Y_WEBGL)).toBe(0);
        expect(pixelStore(mock, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(1);
    });
});
