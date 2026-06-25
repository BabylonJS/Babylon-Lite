import { describe, expect, it } from "vitest";
import { createGLEngine } from "../../../packages/babylon-lite-gl/src/context";
import {
    createRawTexture,
    createFloatTexture,
    generateTextureMipMaps,
    updateRawTexture,
    updateTextureSamplingMode,
    updateTextureWrapMode,
    createTextureFromHandle,
} from "../../../packages/babylon-lite-gl/src/texture";
import { createMockCanvas, createMockGL, fireLost, fireRestored, type MockCall, type MockGL } from "./_lite-gl-mock";

function makeEngine() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    return { mock, canvas, engine };
}

function callsNamed(mock: MockGL, name: string): MockCall[] {
    return mock.log.filter((c) => c.name === name);
}

describe("lite-gl context caps: float render", () => {
    it("reports float/half-float render caps from the extensions", () => {
        const { engine } = makeEngine();
        expect(engine.caps.textureFloatRender).toBe(true);
        expect(engine.caps.textureFloatLinearFiltering).toBe(true);
        expect(engine.caps.textureHalfFloatRender).toBe(true);
        expect(engine.caps.textureHalfFloatLinearFiltering).toBe(true);
        expect(engine.caps.needPOTTextures).toBe(false);
    });

    it("reports textureFloatRender=false when EXT_color_buffer_float is absent", () => {
        const mock = createMockGL();
        mock.setExtensionAvailable("EXT_color_buffer_float", false);
        const engine = createGLEngine(createMockCanvas(mock));
        expect(engine.caps.textureFloatRender).toBe(false);
        // half-float still renderable via the dedicated extension
        expect(engine.caps.textureHalfFloatRender).toBe(true);
    });
});

describe("lite-gl texture: raw update + sampling/wrap", () => {
    it("updateRawTexture re-uploads via texImage2D and can resize", () => {
        const { mock, engine } = makeEngine();
        const tex = createRawTexture(engine, new Uint8Array([0, 0, 0, 0]), 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        mock.clear();
        const next = new Uint8Array(2 * 2 * 4);
        updateRawTexture(engine, tex, next, { width: 2, height: 2 });
        const ti = callsNamed(mock, "texImage2D")[0];
        expect(ti?.args[3]).toBe(2); // width
        expect(ti?.args[4]).toBe(2); // height
        expect(tex.width).toBe(2);
        expect(tex.height).toBe(2);
    });

    it("updateRawTexture applies UNPACK_ALIGNMENT (cached) and restores 4 on the next default upload", () => {
        const { mock, engine } = makeEngine();
        const tex = createRawTexture(engine, new Uint8Array(3), 1, 1, engine.gl.RGB, engine.gl.UNSIGNED_BYTE);
        mock.clear();
        // Align-1 upload: a single cached pixelStorei(ALIGNMENT, 1) — no per-call reset.
        updateRawTexture(engine, tex, new Uint8Array(3), { unpackAlignment: 1 });
        let align = callsNamed(mock, "pixelStorei").filter((c) => c.args[0] === engine.gl.UNPACK_ALIGNMENT);
        expect(align.map((c) => c.args[1])).toEqual([1]);
        mock.clear();
        // A subsequent default-alignment upload restores it to 4 via the cache (1 → 4).
        updateRawTexture(engine, tex, new Uint8Array(3));
        align = callsNamed(mock, "pixelStorei").filter((c) => c.args[0] === engine.gl.UNPACK_ALIGNMENT);
        expect(align.map((c) => c.args[1])).toEqual([4]);
    });

    it("updateRawTexture survives context-restore with the latest data", () => {
        const { mock, canvas, engine } = makeEngine();
        const tex = createRawTexture(engine, new Uint8Array([1, 1, 1, 1]), 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        const latest = new Uint8Array([9, 9, 9, 9]);
        updateRawTexture(engine, tex, latest);
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        const ti = callsNamed(mock, "texImage2D")[0];
        expect(ti?.args[8]).toBe(latest);
    });

    it("updateTextureSamplingMode sets min/mag filters", () => {
        const { mock, engine } = makeEngine();
        const tex = createRawTexture(engine, null, 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        mock.clear();
        updateTextureSamplingMode(engine, tex, engine.gl.NEAREST, engine.gl.NEAREST);
        const tp = callsNamed(mock, "texParameteri");
        expect(tp.some((c) => c.args[1] === engine.gl.TEXTURE_MIN_FILTER && c.args[2] === engine.gl.NEAREST)).toBe(true);
        expect(tp.some((c) => c.args[1] === engine.gl.TEXTURE_MAG_FILTER && c.args[2] === engine.gl.NEAREST)).toBe(true);
    });

    it("updateTextureWrapMode supports MIRRORED_REPEAT", () => {
        const { mock, engine } = makeEngine();
        const tex = createRawTexture(engine, null, 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        mock.clear();
        updateTextureWrapMode(engine, tex, engine.gl.MIRRORED_REPEAT, engine.gl.REPEAT);
        const tp = callsNamed(mock, "texParameteri");
        expect(tp.some((c) => c.args[1] === engine.gl.TEXTURE_WRAP_S && c.args[2] === engine.gl.MIRRORED_REPEAT)).toBe(true);
        expect(tp.some((c) => c.args[1] === engine.gl.TEXTURE_WRAP_T && c.args[2] === engine.gl.REPEAT)).toBe(true);
    });
});

describe("lite-gl texture: external handle wrap", () => {
    it("wraps an existing WebGLTexture, ready, and NOT registered for restore", () => {
        const { engine } = makeEngine();
        const external = {} as WebGLTexture;
        const tex = createTextureFromHandle(engine, external, 16, 8);
        expect(tex.handle).toBe(external);
        expect(tex.width).toBe(16);
        expect(tex.height).toBe(8);
        expect(tex.isReady).toBe(true);
        expect(engine._textures).toHaveLength(0); // external — owner manages restore
    });
});

describe("lite-gl texture: LDR internal-format resolution + passthrough", () => {
    it("resolves RG / RED byte formats to the sized RG8 / R8 internal formats", () => {
        const { mock, engine } = makeEngine();
        mock.clear();
        createRawTexture(engine, null, 2, 2, engine.gl.RG, engine.gl.UNSIGNED_BYTE);
        expect(callsNamed(mock, "texImage2D")[0]?.args[2]).toBe(engine.gl.RG8);
        mock.clear();
        createRawTexture(engine, null, 2, 2, engine.gl.RED, engine.gl.UNSIGNED_BYTE);
        expect(callsNamed(mock, "texImage2D")[0]?.args[2]).toBe(engine.gl.R8);
    });

    it("honors an explicit options.internalFormat passthrough", () => {
        const { mock, engine } = makeEngine();
        mock.clear();
        createRawTexture(engine, null, 2, 2, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE, { internalFormat: engine.gl.RGBA8 });
        expect(callsNamed(mock, "texImage2D")[0]?.args[2]).toBe(engine.gl.RGBA8);
    });
});

describe("lite-gl texture: float / half-float (HDR opt-in)", () => {
    it("createFloatTexture defaults to HALF_FLOAT → RGBA16F", () => {
        const { mock, engine } = makeEngine();
        mock.clear();
        const tex = createFloatTexture(engine, null, 4, 4);
        const ti = callsNamed(mock, "texImage2D")[0];
        // texImage2D(target, level, internalFormat, w, h, border, format, type, data)
        expect(ti?.args[2]).toBe(engine.gl.RGBA16F);
        expect(ti?.args[6]).toBe(engine.gl.RGBA);
        expect(ti?.args[7]).toBe(engine.gl.HALF_FLOAT);
        // Registered like any raw texture, so it survives context restore.
        expect(engine._textures).toContain(tex);
    });

    it("createFloatTexture with type FLOAT → RGBA32F and uploads the provided data", () => {
        const { mock, engine } = makeEngine();
        mock.clear();
        const data = new Float32Array(4 * 4 * 4);
        createFloatTexture(engine, data, 4, 4, { type: engine.gl.FLOAT });
        const ti = callsNamed(mock, "texImage2D")[0];
        expect(ti?.args[2]).toBe(engine.gl.RGBA32F);
        expect(ti?.args[7]).toBe(engine.gl.FLOAT);
        expect(ti?.args[8]).toBe(data);
    });

    it("generateTextureMipMaps issues exactly one generateMipmap; a no-op on a lost context", () => {
        const { mock, canvas, engine } = makeEngine();
        const tex = createRawTexture(engine, null, 4, 4, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        mock.clear();
        generateTextureMipMaps(engine, tex);
        expect(mock.count("generateMipmap")).toBe(1);
        fireLost(canvas);
        mock.clear();
        generateTextureMipMaps(engine, tex);
        expect(mock.count("generateMipmap")).toBe(0);
    });
});

describe("lite-gl texture: UNPACK pixel-store state (no premultiply leak)", () => {
    function premultiplyCalls(mock: MockGL, gl: WebGL2RenderingContext): MockCall[] {
        return callsNamed(mock, "pixelStorei").filter((c) => c.args[0] === gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
    }

    it("resets UNPACK_PREMULTIPLY_ALPHA to 0 for a non-premultiply upload after a premultiply one", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        // A premultiplying raw texture sets the global flag to 1.
        createRawTexture(engine, new Uint8Array(4), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, { premultiplyAlpha: true });
        expect(premultiplyCalls(mock, gl).at(-1)?.args[1]).toBe(1);

        mock.clear();
        // A subsequent NON-premultiply upload MUST explicitly reset it to 0 — otherwise
        // it would inherit the leaked global 1 and silently premultiply.
        createRawTexture(engine, new Uint8Array(4), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE);
        const pm = premultiplyCalls(mock, gl);
        expect(pm).toHaveLength(1);
        expect(pm[0]?.args[1]).toBe(0);
    });

    it("elides a redundant UNPACK_PREMULTIPLY_ALPHA pixelStorei when it already matches the cache", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        createRawTexture(engine, new Uint8Array(4), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE); // sets premultiply 0
        mock.clear();
        // Same flag value again → cached, no pixelStorei for premultiply.
        createRawTexture(engine, new Uint8Array(4), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE);
        expect(premultiplyCalls(mock, gl)).toHaveLength(0);
    });
});
