import { describe, expect, it } from "vitest";
import {
    bindTexture,
    bindTexture3D,
    createEffect,
    createGLEngine,
    createRawTexture,
    createTexture3DFromPixels,
    disposeTexture3D,
    generateTexture3DMipMaps,
    isEffectReady,
    setEffectTexture3D,
    updateTexture3DSamplingMode,
    updateTexture3DWrapMode,
    wipeGLStateCache,
} from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL, fireLost, fireRestored } from "./_lite-gl-mock";

function makeEngine() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    return { mock, canvas, engine };
}

describe("lite-gl native 3D pixel textures", () => {
    it("uploads slice-major RGBA8 bytes and configures trilinear, clamped sampling on all axes", () => {
        const { mock, engine } = makeEngine();
        const data = new Uint8Array(2 * 3 * 4 * 4);
        const tex = createTexture3DFromPixels(engine, data, 2, 3, 4);
        expect(tex).toMatchObject({ target: engine.gl.TEXTURE_3D, width: 2, height: 3, depth: 4, isReady: true });
        expect(engine._textures).toContain(tex);
        expect(mock.log.find((c) => c.name === "texImage3D")?.args).toEqual([engine.gl.TEXTURE_3D, 0, engine.gl.RGBA8, 2, 3, 4, 0, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE, data]);
        expect(mock.log.filter((c) => c.name === "texParameteri").map((c) => c.args)).toEqual([
            [engine.gl.TEXTURE_3D, engine.gl.TEXTURE_MIN_FILTER, engine.gl.LINEAR],
            [engine.gl.TEXTURE_3D, engine.gl.TEXTURE_MAG_FILTER, engine.gl.LINEAR],
            [engine.gl.TEXTURE_3D, engine.gl.TEXTURE_WRAP_S, engine.gl.CLAMP_TO_EDGE],
            [engine.gl.TEXTURE_3D, engine.gl.TEXTURE_WRAP_T, engine.gl.CLAMP_TO_EDGE],
            [engine.gl.TEXTURE_3D, engine.gl.TEXTURE_WRAP_R, engine.gl.CLAMP_TO_EDGE],
        ]);
        expect(engine._state._boundTextures3D?.[0]).toBe(tex.handle);
    });

    it("honors sRGB, wrap and filter overrides", () => {
        const { mock, engine } = makeEngine();
        const tex = createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1, { srgb: true, filter: engine.gl.NEAREST, addressMode: engine.gl.REPEAT });
        expect(mock.log.find((c) => c.name === "texImage3D")?.args[2]).toBe(engine.gl.SRGB8_ALPHA8);
        expect(mock.log.filter((c) => c.name === "texParameteri").map((c) => c.args[2])).toEqual([
            engine.gl.NEAREST,
            engine.gl.NEAREST,
            engine.gl.REPEAT,
            engine.gl.REPEAT,
            engine.gl.REPEAT,
        ]);
        expect(tex.depth).toBe(1);
    });

    it("accepts a 64-cube LUT in Lumina's x-fastest RGBA layout", () => {
        const { mock, engine } = makeEngine();
        const size = 64;
        const data = new Uint8Array(size ** 3 * 4);
        const last = ((size - 1) * size * size + (size - 1) * size + (size - 1)) * 4;
        data.set([255, 128, 64, 255], last);
        const tex = createTexture3DFromPixels(engine, data, size, size, size);
        expect(tex.depth).toBe(size);
        const upload = mock.log.find((c) => c.name === "texImage3D")?.args;
        expect(upload?.slice(3, 6)).toEqual([size, size, size]);
        expect(upload?.[9]).toBe(data);
    });

    it("rejects invalid dimensions and short data before allocating a texture", () => {
        const { mock, engine } = makeEngine();
        for (const size of [0, 1.5, Number.NaN, 257]) {
            expect(() => createTexture3DFromPixels(engine, new Uint8Array(4), size, 1, 1)).toThrow(/dimensions/);
        }
        expect(() => createTexture3DFromPixels(engine, new Uint8Array(31), 2, 2, 2)).toThrow(/data too short/);
        expect(() => createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1, { filter: engine.gl.LINEAR_MIPMAP_LINEAR })).toThrow(/filter/);
        expect(() => createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1, { addressMode: engine.gl.TEXTURE_2D })).toThrow(/addressMode/);
        expect(mock.count("createTexture")).toBe(0);
    });

    it("keeps 2D and 3D unit caches independent and unbinds only the requested target", () => {
        const { mock, engine } = makeEngine();
        const volume = createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1);
        const flat = createRawTexture(engine, new Uint8Array(4), 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        mock.clear();
        bindTexture3D(engine, 1, volume);
        bindTexture3D(engine, 1, volume);
        bindTexture(engine, 1, flat);
        bindTexture(engine, 1, flat);
        expect(mock.log.filter((c) => c.name === "bindTexture").map((c) => c.args[0])).toEqual([engine.gl.TEXTURE_3D, engine.gl.TEXTURE_2D]);
        expect(mock.log.filter((c) => c.name === "activeTexture")).toHaveLength(1);
        mock.clear();
        bindTexture(engine, 1, null);
        expect(mock.log.filter((c) => c.name === "bindTexture").map((c) => c.args)).toEqual([[engine.gl.TEXTURE_2D, null]]);
        expect(engine._state._boundTextures3D?.[1]).toBe(volume.handle);
        bindTexture3D(engine, 1, null);
        expect(mock.log.filter((c) => c.name === "bindTexture").map((c) => c.args[0])).toEqual([engine.gl.TEXTURE_2D, engine.gl.TEXTURE_3D]);
        bindTexture3D(engine, 1, null);
        expect(mock.count("bindTexture")).toBe(2);
    });

    it("forces texture unit zero active before a 3D upload even when its binding is cached", () => {
        const { mock, engine } = makeEngine();
        const first = createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1);
        bindTexture3D(engine, 1, first);
        mock.clear();
        const second = createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1);
        expect(mock.log.filter((c) => c.name === "activeTexture").map((c) => c.args)).toEqual([[engine.gl.TEXTURE0]]);
        expect(mock.log.find((c) => c.name === "bindTexture")?.args).toEqual([engine.gl.TEXTURE_3D, second.handle]);
        expect(engine._state._boundTextures3D?.[1]).toBe(first.handle);
    });

    it("resets unpack flags after a differently configured 2D upload", () => {
        const { mock, engine } = makeEngine();
        createRawTexture(engine, new Uint8Array(3), 1, 1, engine.gl.RGB, engine.gl.UNSIGNED_BYTE, {
            invertY: true,
            premultiplyAlpha: true,
            unpackAlignment: 1,
        });
        mock.clear();
        createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1);
        expect(mock.log.filter((c) => c.name === "pixelStorei").map((c) => c.args)).toEqual([
            [engine.gl.UNPACK_FLIP_Y_WEBGL, 0],
            [engine.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0],
            [engine.gl.UNPACK_ALIGNMENT, 4],
        ]);
    });

    it("disposing a 3D texture leaves a 2D texture on the same unit bound", () => {
        const { mock, engine } = makeEngine();
        const volume = createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1);
        const flat = createRawTexture(engine, new Uint8Array(4), 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        bindTexture3D(engine, 2, volume);
        bindTexture(engine, 2, flat);
        disposeTexture3D(engine, volume);
        expect(engine._state._boundTextures3D?.[2]).toBeNull();
        expect(engine._state.boundTextures[2]).toBe(flat.handle);
        mock.clear();
        bindTexture(engine, 2, flat);
        expect(mock.count("bindTexture")).toBe(0);
    });

    it("binds a sampler3D through setEffectTexture3D and uses TEXTURE_3D for mip, filter and wrap updates", () => {
        const { mock, engine } = makeEngine();
        const effect = createEffect(engine, {
            name: "lut",
            vertexSource: "#version 300 es\nin vec2 position; void main(){ gl_Position=vec4(position,0.,1.); }",
            fragmentSource: "#version 300 es\nprecision highp float; precision highp sampler3D; uniform sampler3D lut; out vec4 color; void main(){ color=texture(lut,vec3(.5)); }",
            uniformNames: [],
            samplerNames: ["lut"],
        });
        expect(isEffectReady(engine, effect)).toBe(true);
        const tex = createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1);
        mock.clear();
        setEffectTexture3D(engine, effect, "lut", tex);
        setEffectTexture3D(engine, effect, "lut", tex);
        generateTexture3DMipMaps(engine, tex);
        updateTexture3DSamplingMode(engine, tex, engine.gl.NEAREST, engine.gl.NEAREST);
        updateTexture3DWrapMode(engine, tex, engine.gl.REPEAT, engine.gl.MIRRORED_REPEAT, engine.gl.CLAMP_TO_EDGE);
        expect(mock.count("uniform1i")).toBe(0);
        expect(mock.log.find((c) => c.name === "generateMipmap")?.args).toEqual([engine.gl.TEXTURE_3D]);
        expect(mock.log.filter((c) => c.name === "texParameteri").map((c) => c.args[1])).toEqual([
            engine.gl.TEXTURE_MIN_FILTER,
            engine.gl.TEXTURE_MAG_FILTER,
            engine.gl.TEXTURE_WRAP_S,
            engine.gl.TEXTURE_WRAP_T,
        ]);
    });

    it("elides unchanged sampling and wrapping updates without rebinding or changing the active unit", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        const tex = createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1);
        bindTexture3D(engine, 1, tex);
        mock.clear();
        updateTexture3DSamplingMode(engine, tex, gl.LINEAR, gl.LINEAR);
        updateTexture3DWrapMode(engine, tex, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE);
        expect(mock.log).toEqual([]);

        updateTexture3DSamplingMode(engine, tex, gl.NEAREST, gl.LINEAR);
        updateTexture3DWrapMode(engine, tex, gl.CLAMP_TO_EDGE, gl.REPEAT, gl.CLAMP_TO_EDGE);
        expect(mock.log.filter((c) => c.name === "texParameteri").map((c) => c.args)).toEqual([
            [gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST],
            [gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT],
        ]);
        bindTexture3D(engine, 2, tex);
        mock.clear();
        updateTexture3DSamplingMode(engine, tex, gl.NEAREST, gl.LINEAR);
        updateTexture3DWrapMode(engine, tex, gl.CLAMP_TO_EDGE, gl.REPEAT, gl.CLAMP_TO_EDGE);
        expect(mock.log).toEqual([]);
        expect(engine._state.activeTextureUnit).toBe(2);
    });

    it("rejects invalid filter and wrap updates without poisoning the cached parameters", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        const tex = createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1);
        mock.clear();
        expect(() => updateTexture3DSamplingMode(engine, tex, gl.TEXTURE_2D, gl.NEAREST)).toThrow(/minification filter/);
        expect(() => updateTexture3DSamplingMode(engine, tex, gl.NEAREST, gl.LINEAR_MIPMAP_LINEAR)).toThrow(/magnification filter/);
        expect(() => updateTexture3DWrapMode(engine, tex, gl.REPEAT, gl.REPEAT, gl.TEXTURE_2D)).toThrow(/wrap mode/);
        expect(mock.log).toEqual([]);
        updateTexture3DSamplingMode(engine, tex, gl.NEAREST, gl.LINEAR);
        updateTexture3DWrapMode(engine, tex, gl.REPEAT, gl.REPEAT, gl.REPEAT);
        expect(mock.count("texParameteri")).toBe(4);
    });

    it("regenerates an opted-in mip chain after every context restore before replaying the mip filter", () => {
        const { mock, canvas, engine } = makeEngine();
        const gl = engine.gl;
        const data = new Uint8Array(2 * 2 * 2 * 4);
        const tex = createTexture3DFromPixels(engine, data, 2, 2, 2);
        generateTexture3DMipMaps(engine, tex);
        updateTexture3DSamplingMode(engine, tex, gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
        fireLost(canvas);
        mock.clear();
        generateTexture3DMipMaps(engine, tex);
        expect(mock.log).toEqual([]);

        fireRestored(canvas);
        const upload = mock.log.findIndex((c) => c.name === "texImage3D");
        const mipmap = mock.log.findIndex((c) => c.name === "generateMipmap");
        const minFilter = mock.log.findIndex((c) => c.name === "texParameteri" && c.args[1] === gl.TEXTURE_MIN_FILTER);
        expect(mock.log[upload]?.args[9]).toBe(data);
        expect(mock.log[mipmap]?.args).toEqual([gl.TEXTURE_3D]);
        expect(upload).toBeLessThan(mipmap);
        expect(mipmap).toBeLessThan(minFilter);
        expect(mock.log[minFilter]?.args[2]).toBe(gl.LINEAR_MIPMAP_LINEAR);
        expect(mock.count("generateMipmap")).toBe(1);

        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(mock.count("generateMipmap")).toBe(1);
        mock.clear();
        updateTexture3DSamplingMode(engine, tex, gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
        expect(mock.log).toEqual([]);
    });

    it("restores the same logical texture with its pixels, 3D binding and parameters; disposal invalidates its cache", () => {
        const { mock, canvas, engine } = makeEngine();
        const data = new Uint8Array([10, 20, 30, 255]);
        const tex = createTexture3DFromPixels(engine, data, 1, 1, 1);
        bindTexture3D(engine, 1, tex);
        const oldHandle = tex.handle;
        fireLost(canvas);
        expect(tex.isReady).toBe(false);
        mock.clear();
        bindTexture3D(engine, 1, tex);
        expect(mock.count("bindTexture")).toBe(0);
        fireRestored(canvas);
        expect(tex.isReady).toBe(true);
        expect(tex.handle).not.toBe(oldHandle);
        expect(mock.log.find((c) => c.name === "texImage3D")?.args[9]).toBe(data);
        expect(mock.log.filter((c) => c.name === "texParameteri")).toHaveLength(5);
        expect(mock.count("generateMipmap")).toBe(0);
        mock.clear();
        bindTexture3D(engine, 1, tex);
        bindTexture3D(engine, 1, tex);
        expect(mock.count("bindTexture")).toBe(1);
        disposeTexture3D(engine, tex);
        expect(engine._state._boundTextures3D?.[1]).toBeNull();
        expect(engine._textures).not.toContain(tex);
        expect(mock.count("deleteTexture")).toBe(1);
        mock.clear();
        bindTexture3D(engine, 1, tex);
        expect(mock.count("bindTexture")).toBe(0);
    });

    it("invalidates the optional 3D cache when external GL state is wiped", () => {
        const { mock, engine } = makeEngine();
        const tex = createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1);
        bindTexture3D(engine, 1, tex);
        mock.clear();
        wipeGLStateCache(engine);
        bindTexture3D(engine, 1, tex);
        expect(mock.log.find((c) => c.name === "bindTexture")?.args).toEqual([engine.gl.TEXTURE_3D, tex.handle]);
    });

    it("unbinds a 3D texture after a cache wipe even when the previous binding is unknown", () => {
        const { mock, engine } = makeEngine();
        const tex = createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1);
        bindTexture3D(engine, 1, tex);
        mock.clear();
        wipeGLStateCache(engine);
        bindTexture3D(engine, 1, null);
        expect(mock.log.filter((c) => c.name === "bindTexture").map((c) => c.args)).toEqual([[engine.gl.TEXTURE_3D, null]]);
        expect(engine._state._boundTextures3D?.[1]).toBeNull();
        mock.clear();
        bindTexture3D(engine, 1, null);
        expect(mock.count("bindTexture")).toBe(0);
    });

    it("replays updated 3D sampling and wrap parameters on restore", () => {
        const { mock, canvas, engine } = makeEngine();
        const tex = createTexture3DFromPixels(engine, new Uint8Array(4), 1, 1, 1);
        updateTexture3DSamplingMode(engine, tex, engine.gl.NEAREST, engine.gl.LINEAR);
        updateTexture3DWrapMode(engine, tex, engine.gl.REPEAT, engine.gl.MIRRORED_REPEAT, engine.gl.CLAMP_TO_EDGE);
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        expect(mock.log.filter((c) => c.name === "texParameteri").map((c) => c.args)).toEqual([
            [engine.gl.TEXTURE_3D, engine.gl.TEXTURE_MIN_FILTER, engine.gl.NEAREST],
            [engine.gl.TEXTURE_3D, engine.gl.TEXTURE_MAG_FILTER, engine.gl.LINEAR],
            [engine.gl.TEXTURE_3D, engine.gl.TEXTURE_WRAP_S, engine.gl.REPEAT],
            [engine.gl.TEXTURE_3D, engine.gl.TEXTURE_WRAP_T, engine.gl.MIRRORED_REPEAT],
            [engine.gl.TEXTURE_3D, engine.gl.TEXTURE_WRAP_R, engine.gl.CLAMP_TO_EDGE],
        ]);
    });
});
