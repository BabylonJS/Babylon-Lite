/**
 * Babylon Native backend — behavior of the receiver-first public API (parity
 * with the WebGL barrel) and of the declared divergences. Everything goes
 * through the public native barrel, against the `_native` mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockNative, type MockNative } from "./_native-mock";
import {
    GLBlendEquation,
    GLBlendMode,
    GLSamplingMode,
    beginFrame,
    bindRenderTarget,
    bindTexture,
    bindTexture3D,
    captureGPUFrameTime,
    clearEngine,
    createEffect,
    createGlyphStorage,
    createRawTexture,
    createRenderTarget,
    createFloatRenderTarget,
    createTextLayer,
    createTextRenderer,
    createTexture3DFromPixels,
    createTextureFromSource,
    disposeEffect,
    disposeTexture,
    disableBlend,
    disposeTexture3D,
    endFrame,
    generateRenderTargetMipMaps,
    generateRenderTargetStencil,
    generateTexture3DMipMaps,
    generateTextureMipMaps,
    getAlphaToCoverage,
    getCurrentSampleCount,
    getEffectCompilationError,
    getGPUFrameTimeCounter,
    getRenderingCanvas,
    getRenderWidth,
    isEffectReady,
    isTextureReady,
    readRenderTargetPixels,
    readRenderTargetPixelsToBuffer,
    restoreDefaultFramebuffer,
    setAlphaToCoverage,
    setBlendMode,
    setBlendState,
    setDepthState,
    setEffectTexture3D,
    setGLEngineSize,
    setScissor,
    setTextLayerPosition,
    setStencilOpSeparate,
    setStencilState,
    setViewport,
    unbindTexture,
    unbindTexture3D,
    updateTextureSamplingPreset,
    useEffect,
    waitForEffect,
    wipeGLStateCache,
    type GLEffect,
    type GLEngineContext,
    type GLTextData,
} from "../../../packages/babylon-lite-gl/src/index.native";
import { createNativeGLEngine, disposeNativeGLEngine } from "../../../packages/babylon-lite-gl/src/native/native-context";

const GL_FRONT = 0x0404;
const GL_BACK = 0x0405;
const GL_FRONT_AND_BACK = 0x0408;
const GL_LEQUAL = 0x0203;
const GL_GREATER = 0x0204;
const GL_ALWAYS = 0x0207;
const GL_KEEP = 0x1e00;
const GL_REPLACE = 0x1e01;
const GL_INCR = 0x1e02;
const GL_RED = 0x1903;
const GL_RG = 0x8227;
const GL_FLOAT = 0x1406;
const GL_HALF_FLOAT = 0x140b;
const GL_ONE = 1;
const GL_SRC_ALPHA = 0x0302;
const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
const GL_LINEAR = 0x2601;
const GL_LINEAR_MIPMAP_LINEAR = 0x2703;

const VS = "#version 300 es\nin vec2 position;\nvoid main(){gl_Position=vec4(position,0.0,1.0);}";
const FS = "#version 300 es\nprecision highp float;\nuniform sampler2D s0;\nout vec4 o;\nvoid main(){o=texture(s0,vec2(0.5));}";

let mock: MockNative;
let engine: GLEngineContext;

function commandCount(name: string): number {
    const tag = mock.tag(name);
    return mock.streamWords.reduce((acc, w) => acc + (w === tag ? 1 : 0), 0);
}

/** Args of the LAST emission of `name`, as float32 (`float`) or raw uint32 words. */
function lastCommandArgs(name: string, argCount: number, float: boolean): number[] {
    const tag = mock.tag(name);
    const i = mock.streamWords.lastIndexOf(tag);
    if (i === -1) {
        throw new Error(`command ${name} not found`);
    }
    return (float ? mock.streamFloats : mock.streamWords).slice(i + 1, i + 1 + argCount);
}

function samplerEffect(target: GLEngineContext, name = "sampled"): GLEffect {
    return createEffect(target, { name, vertexSource: VS, fragmentSource: FS, uniformNames: [], samplerNames: ["s0"] });
}

beforeEach(() => {
    mock = createMockNative();
    mock.install();
    engine = createNativeGLEngine();
});

afterEach(() => {
    disposeNativeGLEngine(engine);
    mock.uninstall();
    vi.restoreAllMocks();
});

describe("native receiver-first API", () => {
    it("routes resource calls to the resource's own engine", () => {
        const other = createNativeGLEngine();
        try {
            const tex = createRawTexture(other, new Uint8Array(4), 1, 1);
            bindTexture(tex, 2);
            expect(other._state.boundTextures[2]).toBe(tex.handle);
            expect(engine._state.boundTextures[2] ?? null).toBeNull();

            const rt = createRenderTarget(other, 8, 8);
            bindRenderTarget(rt);
            expect(other._currentRenderTarget).toBe(rt);
            expect(engine._currentRenderTarget).toBeNull();
            restoreDefaultFramebuffer(other);
            expect(other._currentRenderTarget).toBeNull();
        } finally {
            disposeNativeGLEngine(other);
        }
    });

    it("splits bind/unbind: bindTexture(tex, unit) + unbindTexture(engine, unit) drive the current program's sampler", () => {
        const effect = samplerEffect(engine);
        mock.fireProgramReady();
        expect(isEffectReady(effect)).toBe(true);
        useEffect(effect);
        const tex = createRawTexture(engine, new Uint8Array(4), 1, 1);
        const setBefore = commandCount("COMMAND_SETTEXTURE");
        bindTexture(tex, 0);
        bindTexture(tex, 0); // cached
        expect(commandCount("COMMAND_SETTEXTURE")).toBe(setBefore + 1);

        const unsetBefore = commandCount("COMMAND_UNSETTEXTURE");
        unbindTexture(engine, 0);
        unbindTexture(engine, 0); // cached
        expect(engine._state.boundTextures[0]).toBeNull();
        expect(commandCount("COMMAND_UNSETTEXTURE")).toBe(unsetBefore + 1);
    });

    it("retains mip intent: generateTextureMipMaps re-uploads with mips and keeps them on later updates", () => {
        const tex = createRawTexture(engine, new Uint8Array(16), 2, 2);
        const uploads = (): unknown[][] => mock.calls.filter((c) => c.name === "loadRawTexture").map((c) => c.args);
        expect(uploads().at(-1)![5]).toBe(false);
        generateTextureMipMaps(tex);
        expect(tex._hasMipMaps).toBe(true);
        expect(uploads().at(-1)![5]).toBe(true);
    });

    it("updateTextureSamplingPreset(TRILINEAR, true) generates mips once; other presets never do", () => {
        const tex = createRawTexture(engine, new Uint8Array(16), 2, 2);
        updateTextureSamplingPreset(tex, GLSamplingMode.BILINEAR, true);
        expect(tex._hasMipMaps).toBeUndefined();
        const before = mock.count("loadRawTexture");
        updateTextureSamplingPreset(tex, GLSamplingMode.TRILINEAR, true);
        expect(tex._hasMipMaps).toBe(true);
        expect(mock.count("loadRawTexture")).toBe(before + 1);
        updateTextureSamplingPreset(tex, GLSamplingMode.TRILINEAR, true);
        expect(mock.count("loadRawTexture")).toBe(before + 1);
    });

    it("isTextureReady follows disposal", () => {
        const tex = createRawTexture(engine, new Uint8Array(4), 1, 1);
        expect(isTextureReady(tex)).toBe(true);
        disposeTexture(tex);
        expect(isTextureReady(tex)).toBe(false);
    });
});

describe("native non-blocking effect compilation", () => {
    it("does not throw on a compile error and reports it through getEffectCompilationError", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const effect = samplerEffect(engine, "broken");
        expect(getEffectCompilationError(effect)).toBeNull();
        mock.fireProgramError("ERROR: 0:1: syntax error");
        expect(getEffectCompilationError(effect)).toBe("ERROR: 0:1: syntax error");
        expect(isEffectReady(effect)).toBe(false);
    });

    it("waitForEffect resolves once the host links the program", async () => {
        const effect = samplerEffect(engine);
        const pending = waitForEffect(effect);
        mock.fireProgramReady();
        mock.fireAnimationFrame();
        await expect(pending).resolves.toBe(effect);
    });

    it("waitForEffect rejects with the compile error", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const effect = samplerEffect(engine, "bad");
        const pending = waitForEffect(effect);
        mock.fireProgramError("link failed");
        mock.fireAnimationFrame();
        await expect(pending).rejects.toThrow("lite-gl: bad link failed");
    });

    it("waitForEffect rejects on abort and on disposal", async () => {
        const controller = new AbortController();
        const aborted = waitForEffect(samplerEffect(engine, "a"), { signal: controller.signal });
        controller.abort();
        await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

        const effect = createEffect(engine, { name: "d", vertexSource: VS, fragmentSource: FS + "\n", uniformNames: [], samplerNames: [] });
        const disposed = waitForEffect(effect);
        disposeEffect(effect);
        // The aborted wait's retired poll is queued first.
        mock.fireAnimationFrame();
        mock.fireAnimationFrame();
        await expect(disposed).rejects.toThrow("disposed while waiting");
    });
});

describe("native render-target readback", () => {
    it("readRenderTargetPixels resolves RGBA8 by default and packs RG / RED", async () => {
        const rt = createRenderTarget(engine, 2, 1);
        const rgba = (await readRenderTargetPixels(rt)) as Uint8Array;
        expect(Array.from(rgba)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(mock.count("readTexture")).toBe(1);

        const rg = (await readRenderTargetPixels(rt, { format: GL_RG })) as Uint8Array;
        expect(Array.from(rg)).toEqual([0, 1, 4, 5]);
        const into = new Uint8Array(2);
        const red = await readRenderTargetPixels(rt, { format: GL_RED, into });
        expect(red).toBe(into);
        expect(Array.from(into)).toEqual([0, 4]);
    });

    it("readRenderTargetPixels converts float targets from the host's RGBA8 readback", async () => {
        mock.readPattern = () => 255;
        const rt = createFloatRenderTarget(engine, 1, 1, { type: GL_FLOAT });
        const out = await readRenderTargetPixels(rt);
        expect(out).toBeInstanceOf(Float32Array);
        expect(Array.from(out as Float32Array)).toEqual([1, 1, 1, 1]);
    });

    it("readRenderTargetPixelsToBuffer writes at a byte offset and validates the destination", async () => {
        const rt = createRenderTarget(engine, 2, 1);
        const dst = new ArrayBuffer(12);
        await readRenderTargetPixelsToBuffer(rt, dst, { offset: 4 });
        expect(Array.from(new Uint8Array(dst))).toEqual([0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7]);

        await expect(readRenderTargetPixelsToBuffer(rt, new ArrayBuffer(4))).rejects.toThrow("destination is too small");
        await expect(readRenderTargetPixelsToBuffer(rt, {} as WebGLBuffer)).rejects.toThrow("WebGLBuffer is not supported");
        const float = createFloatRenderTarget(engine, 1, 1, { type: GL_FLOAT });
        await expect(readRenderTargetPixelsToBuffer(float, new ArrayBuffer(32), { offset: 2 })).rejects.toThrow("multiple of 4");
    });
});

describe("native engine-wide functions", () => {
    it("setGLEngineSize is a host-managed no-op (no native calls, viewport untouched)", () => {
        const calls = mock.calls.length;
        const words = mock.streamWords.length;
        setGLEngineSize(engine, 1024, 768);
        expect(mock.calls.length).toBe(calls);
        expect(mock.streamWords.length).toBe(words);
        expect(getRenderWidth(engine)).toBe(256);
    });

    it("wipeGLStateCache forces the next identical state call to be re-emitted", () => {
        setScissor(engine, 1, 2, 3, 4);
        setScissor(engine, 1, 2, 3, 4);
        expect(commandCount("COMMAND_SETSCISSOR")).toBe(1);
        wipeGLStateCache(engine);
        setScissor(engine, 1, 2, 3, 4);
        expect(commandCount("COMMAND_SETSCISSOR")).toBe(2);
    });

    it("measures GPU frame time through populateFrameStats between beginFrame/endFrame", () => {
        expect(engine.caps.gpuFrameTime).toBe(true);
        mock.frameStats = { gpuTimeNs: 2_000_000 };
        endFrame(engine);
        expect(getGPUFrameTimeCounter(engine).count).toBe(0);
        captureGPUFrameTime(engine, true);
        beginFrame(engine);
        endFrame(engine);
        const counter = getGPUFrameTimeCounter(engine);
        expect(counter.count).toBe(1);
        expect(counter.current).toBe(2_000_000);
        captureGPUFrameTime(engine, false);
        endFrame(engine);
        expect(counter.count).toBe(1);
    });

    it("maps the depth func to the native DEPTH_TEST_* value (disabled → ALWAYS)", () => {
        setDepthState(engine, { test: true, func: GL_GREATER });
        clearEngine(engine, {});
        expect(lastCommandArgs("COMMAND_SETDEPTHTEST", 1, false)).toEqual([_native.Engine.DEPTH_TEST_GREATER]);
        setDepthState(engine, { func: GL_LEQUAL });
        clearEngine(engine, {});
        expect(lastCommandArgs("COMMAND_SETDEPTHTEST", 1, false)).toEqual([_native.Engine.DEPTH_TEST_LEQUAL]);
        setDepthState(engine, { test: false });
        clearEngine(engine, {});
        expect(lastCommandArgs("COMMAND_SETDEPTHTEST", 1, false)).toEqual([_native.Engine.DEPTH_TEST_ALWAYS]);
    });

    it("carries the scissor over to a newly bound framebuffer (the host keeps one per framebuffer)", () => {
        const rt = createRenderTarget(engine, 64, 32);
        setScissor(engine, 1, 2, 3, 4);
        const before = commandCount("COMMAND_SETSCISSOR");
        bindRenderTarget(rt);
        expect(commandCount("COMMAND_SETSCISSOR")).toBe(before + 1);
        expect(lastCommandArgs("COMMAND_SETSCISSOR", 4, true)).toEqual([1, 2, 3, 4]);
    });

    it("normalizes setViewport by the bound render target size", () => {
        const rt = createRenderTarget(engine, 128, 64);
        bindRenderTarget(rt);
        setViewport(engine, { x: 32, y: 16, w: 64, h: 32 });
        expect(lastCommandArgs("COMMAND_SETVIEWPORT", 4, true)).toEqual([0.25, 0.25, 0.5, 0.5]);
        restoreDefaultFramebuffer(engine);
        setViewport(engine, { x: 0, y: 0, w: 128, h: 64 });
        expect(lastCommandArgs("COMMAND_SETVIEWPORT", 4, true)).toEqual([0, 0, 0.5, 0.25]);
    });

    it("generateRenderTargetStencil rebuilds the framebuffer once", () => {
        const rt = createRenderTarget(engine, 4, 4);
        const before = mock.count("createFrameBuffer");
        generateRenderTargetStencil(rt);
        generateRenderTargetStencil(rt);
        expect(mock.count("createFrameBuffer")).toBe(before + 1);
        expect(mock.calls.filter((c) => c.name === "createFrameBuffer").at(-1)!.args[4]).toBe(true);
    });

    it("createTextureFromSource uploads a createImageBitmap result (premultiplied on request)", () => {
        const bitmap = engine._engine.createImageBitmap!(new ArrayBuffer(8));
        const tex = createTextureFromSource(engine, bitmap, { premultiplyAlpha: true });
        expect(tex.width).toBe(2);
        expect(tex.height).toBe(2);
        expect(isTextureReady(tex)).toBe(true);
        const upload = mock.calls.filter((c) => c.name === "loadRawTexture").at(-1)!.args;
        expect(Array.from((upload[1] as Uint8Array).subarray(0, 4))).toEqual([5, 10, 15, 128]);
        // The source itself is not mutated.
        expect(Array.from(bitmap.data as Uint8Array).slice(0, 4)).toEqual([10, 20, 30, 128]);
        expect(() => createTextureFromSource(engine, {} as ImageBitmap)).toThrow("DOM sources are not supported");
    });
});

describe("native declared divergences", () => {
    it("advertises the unsupported features through caps flags", () => {
        expect(engine.caps.alphaToCoverage).toBe(false);
        expect(engine.caps.separateStencil).toBe(false);
        expect(engine.caps.textRendering).toBe(false);
    });

    it("hosts without loadRawTexture3D report no 3D support and refuse to create volumes", () => {
        expect(engine.caps.texture3D).toBe(false);
        expect(() => createTexture3DFromPixels(engine, new Uint8Array(32), 2, 2, 2)).toThrow("needs a Babylon Native host with loadRawTexture3D");
        expect(() => setEffectTexture3D(samplerEffect(engine), "s0", null)).not.toThrow();
        expect(() => unbindTexture3D(engine, 0)).not.toThrow();
    });

    it("hosts without the newer commands keep the legacy blend / stencil / mip behavior", async () => {
        setBlendState(engine, { srcRGB: GL_ONE, dstRGB: GL_ONE, srcAlpha: GL_ONE, dstAlpha: GL_ONE, equationRGB: GLBlendEquation.MAX });
        setStencilState(engine, { test: true, func: GL_ALWAYS, ref: 1, funcMask: 0x0f });
        clearEngine(engine, { stencil: true });
        // No ONEONE_ONEONE preset: nearest by RGB factors; equation dropped.
        expect(lastCommandArgs("COMMAND_SETBLENDMODE", 1, false)).toEqual([_native.Engine.ALPHA_ONEONE]);
        expect(lastCommandArgs("COMMAND_SETSTENCIL", 7, false)[6]).not.toBe(0x0f);

        const rt = createRenderTarget(engine, 4, 4);
        const handle = rt.texture.handle;
        const textures = mock.count("createTexture");
        generateRenderTargetMipMaps(rt);
        expect(rt.texture.handle).toBe(handle);
        expect(mock.count("createTexture")).toBe(textures);

        await readRenderTargetPixels(rt);
        expect(mock.count("readTexture")).toBe(1);
    });

    it("alpha-to-coverage: enabling throws, disabling no-ops, queries are neutral", () => {
        expect(() => setAlphaToCoverage(engine, true)).toThrow("setAlphaToCoverage is not supported on Babylon Native");
        expect(() => setAlphaToCoverage(engine, false)).not.toThrow();
        expect(getAlphaToCoverage(engine)).toBe(false);
        expect(getCurrentSampleCount(engine)).toBe(1);
    });

    it("getRenderingCanvas throws (the host owns the surface)", () => {
        expect(engine.canvas).toBeNull();
        expect(() => getRenderingCanvas(engine)).toThrow("getRenderingCanvas is not supported on Babylon Native");
    });

    it("two-sided stencil: identical faces use the single-sided path; differing faces throw when flushed with the test on", () => {
        setStencilState(engine, { test: true, func: GL_ALWAYS, ref: 1 });
        setStencilOpSeparate(engine, GL_FRONT, { opZPass: GL_REPLACE });
        setStencilOpSeparate(engine, GL_BACK, { opZPass: GL_REPLACE });
        expect(() => clearEngine(engine, { stencil: true })).not.toThrow();
        expect(commandCount("COMMAND_SETSTENCIL")).toBeGreaterThan(0);

        setStencilOpSeparate(engine, GL_BACK, { opZPass: GL_INCR });
        expect(() => clearEngine(engine, { stencil: true })).toThrow("setStencilOpSeparate with different front/back ops is not supported on Babylon Native");

        // Irrelevant while the stencil test is off.
        setStencilState(engine, { test: false });
        setStencilOpSeparate(engine, GL_BACK, { opZPass: GL_INCR });
        setStencilOpSeparate(engine, GL_FRONT, { opZPass: GL_KEEP });
        expect(() => clearEngine(engine, {})).not.toThrow();

        // FRONT_AND_BACK re-unifies the faces.
        setStencilState(engine, { test: true });
        setStencilOpSeparate(engine, GL_FRONT_AND_BACK, { opZPass: GL_REPLACE });
        expect(() => clearEngine(engine, {})).not.toThrow();
        expect(() => setStencilOpSeparate(engine, 0, { opZPass: GL_KEEP })).toThrow("invalid face");
    });

    it("Slug text rendering throws with a clear message; pure layer helpers still work", () => {
        expect(() => createGlyphStorage()).toThrow("createGlyphStorage is not supported on Babylon Native");
        expect(() => createTextRenderer(engine, {} as never)).toThrow("createTextRenderer is not supported on Babylon Native");
        const layer = createTextLayer({} as GLTextData, { positionPx: { x: 3, y: 4 } });
        expect(layer.positionPx).toEqual({ x: 3, y: 4 });
        setTextLayerPosition(layer, 5, 6);
        expect(layer.positionPx).toEqual({ x: 5, y: 6 });
    });
});

describe("native mip-aware sampling preset", () => {
    it("uses the mipmapped TRILINEAR min filter only once the texture has mips", () => {
        const tex = createRawTexture(engine, new Uint8Array(4), 1, 1, { minFilter: GL_LINEAR, magFilter: GL_LINEAR });
        updateTextureSamplingPreset(tex, GLSamplingMode.TRILINEAR);
        const plain = tex._filter;
        generateTextureMipMaps(tex);
        updateTextureSamplingPreset(tex, GLSamplingMode.TRILINEAR);
        expect(tex._filter).not.toBe(plain);
        const mipped = createRawTexture(engine, new Uint8Array(4), 1, 1, { minFilter: GL_LINEAR_MIPMAP_LINEAR, magFilter: GL_LINEAR });
        expect(mipped._filter).toBe(tex._filter);
    });
});

describe("current Babylon Native host features", () => {
    beforeEach(() => {
        disposeNativeGLEngine(engine);
        mock.uninstall();
        mock = createMockNative({ host: "current" });
        mock.install();
        engine = createNativeGLEngine();
    });

    it("maps blend factors to the exact host preset and emits the equation only when it changes", () => {
        const E = _native.Engine;
        const equations = (): number[] => {
            const tag = mock.tag("COMMAND_SETBLENDEQUATION");
            return mock.streamWords.flatMap((w, i) => (w === tag ? [mock.streamWords[i + 1]!] : []));
        };
        setBlendState(engine, { srcRGB: GL_ONE, dstRGB: GL_ONE, srcAlpha: GL_ONE, dstAlpha: GL_ONE, equationRGB: GLBlendEquation.MAX, equationAlpha: GLBlendEquation.MAX });
        clearEngine(engine, {});
        expect(lastCommandArgs("COMMAND_SETBLENDMODE", 1, false)).toEqual([E.ALPHA_ONEONE_ONEONE]);
        expect(equations()).toEqual([E.ALPHA_EQUATION_MAX]);

        setBlendState(engine, { srcRGB: GL_SRC_ALPHA, dstRGB: GL_ONE_MINUS_SRC_ALPHA, srcAlpha: GL_ONE, dstAlpha: GL_ONE_MINUS_SRC_ALPHA, equationRGB: GLBlendEquation.MIN });
        clearEngine(engine, {});
        expect(lastCommandArgs("COMMAND_SETBLENDMODE", 1, false)).toEqual([E.ALPHA_LAYER_ACCUMULATE]);
        // MIN RGB + ADD alpha is the host's DARKEN equation.
        expect(equations()).toEqual([E.ALPHA_EQUATION_MAX, E.ALPHA_EQUATION_DARKEN]);

        // Presets blend with ADD; disabling keeps the equation, so re-enabling with
        // the same one re-emits nothing.
        setBlendMode(engine, GLBlendMode.ALPHA);
        clearEngine(engine, {});
        disableBlend(engine);
        clearEngine(engine, {});
        setBlendMode(engine, GLBlendMode.ADD);
        clearEngine(engine, {});
        expect(lastCommandArgs("COMMAND_SETBLENDMODE", 1, false)).toEqual([E.ALPHA_ADD]);
        expect(equations()).toEqual([E.ALPHA_EQUATION_MAX, E.ALPHA_EQUATION_DARKEN, E.ALPHA_EQUATION_ADD]);
    });

    it("sends the stencil func mask through COMMAND_SETSTENCIL2", () => {
        setStencilState(engine, { test: true, func: GL_ALWAYS, ref: 1, funcMask: 0x0f });
        clearEngine(engine, { stencil: true });
        expect(lastCommandArgs("COMMAND_SETSTENCIL2", 7, false)[6]).toBe(0x0f);
        expect(commandCount("COMMAND_SETSTENCIL")).toBe(0);
    });

    it("generateRenderTargetMipMaps re-allocates the color texture with mips once, then regenerates", () => {
        const rt = createRenderTarget(engine, 4, 4);
        bindRenderTarget(rt);
        const tex = rt.texture;
        const oldHandle = tex.handle;
        generateRenderTargetMipMaps(rt);
        expect(tex.handle).not.toBe(oldHandle);
        expect(mock.deletedTextures).toContain((oldHandle as unknown as Uint32Array)[0]);
        expect(mock.calls.filter((c) => c.name === "initializeTexture").at(-1)!.args[3]).toBe(true);
        expect(commandCount("COMMAND_COPYTEXTURE")).toBe(1);
        expect(engine._state.boundFramebuffer).toBe(rt._framebuffer);
        expect(commandCount("COMMAND_GENERATEMIPMAPS")).toBe(1);

        const framebuffers = mock.count("createFrameBuffer");
        generateRenderTargetMipMaps(rt);
        expect(mock.count("createFrameBuffer")).toBe(framebuffers);
        expect(commandCount("COMMAND_COPYTEXTURE")).toBe(1);
        expect(commandCount("COMMAND_GENERATEMIPMAPS")).toBe(2);
    });

    it("reads float targets at full precision through readTexture2", async () => {
        const float = createFloatRenderTarget(engine, 1, 1, { type: GL_FLOAT });
        expect(Array.from((await readRenderTargetPixels(float)) as Float32Array)).toEqual([0, 0.25, 0.5, 0.75]);
        mock.readFloatPattern = (i) => [0, 0.25, 65536, -2][i]!;
        const half = createFloatRenderTarget(engine, 1, 1, { type: GL_HALF_FLOAT });
        // 65536 overflows half precision to +Inf.
        expect(Array.from((await readRenderTargetPixels(half)) as Uint16Array)).toEqual([0, 0x3400, 0x7c00, 0xc000]);
        expect(mock.count("readTexture2")).toBe(2);
        expect(mock.count("readTexture")).toBe(0);
    });

    it("creates, binds and disposes 3D textures through loadRawTexture3D", () => {
        expect(engine.caps.texture3D).toBe(true);
        const data = new Uint8Array(32);
        const volume = createTexture3DFromPixels(engine, data, 2, 2, 2);
        expect(mock.calls.find((c) => c.name === "loadRawTexture3D")!.args.slice(1)).toEqual([data, 2, 2, 2, _native.Engine.TEXTURE_FORMAT_RGBA8, false, false]);
        expect(() => createTexture3DFromPixels(engine, data, 2, 2, 2, { srgb: true })).toThrow("sRGB 3D textures");
        expect(() => generateTexture3DMipMaps(volume)).toThrow("no 3D mip chains");

        const effect = samplerEffect(engine);
        mock.fireProgramReady();
        useEffect(effect);
        setEffectTexture3D(effect, "s0", volume);
        expect(engine._state.boundTextures[0]).toBe(volume.handle);

        // Clearing the 3D binding leaves a 2D texture on another unit alone.
        const flat = createRawTexture(engine, new Uint8Array(4), 1, 1);
        bindTexture(flat, 1);
        unbindTexture3D(engine, 1);
        expect(engine._state.boundTextures[1]).toBe(flat.handle);
        bindTexture3D(volume, 1);
        unbindTexture3D(engine, 1);
        expect(engine._state.boundTextures[1]).toBeNull();

        const handle = (volume.handle as unknown as Uint32Array)[0];
        disposeTexture3D(volume);
        expect(engine._state.boundTextures[0]).toBeNull();
        expect(mock.deletedTextures).toContain(handle);
    });
});
