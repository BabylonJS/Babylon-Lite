import { describe, expect, it } from "vitest";
import { bindTexture, createGLEngine, disposeGLEngine, type GLEffect } from "../../../packages/babylon-lite-gl/src/index";
import {
    bindRenderTarget,
    createFloatRenderTarget,
    createPingPong,
    createRenderTarget,
    disposePingPong,
    disposeRenderTarget,
    generateRenderTargetMipMaps,
    readRenderTargetPixels,
    resizePingPong,
    resizeRenderTarget,
} from "../../../packages/babylon-lite-gl/src/render-target";
import { createRawTexture } from "../../../packages/babylon-lite-gl/src/texture";
import { setEffectTexture } from "../../../packages/babylon-lite-gl/src/effect";
import { createMockCanvas, createMockGL, fireLost, fireRestored, type MockCall, type MockGL } from "./_lite-gl-mock";

function setup() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    // Distinct, non-square canvas so the default-FB viewport reset is
    // distinguishable from any RT size used in the tests.
    canvas.width = 800;
    canvas.height = 600;
    const engine = createGLEngine(canvas);
    mock.setParallelComplete(true);
    return { mock, canvas, engine, gl: engine.gl };
}

/** Build an engine after toggling specific getExtension caps (caps are sampled
 *  during createGLEngine, so the toggles must precede it). */
function setupWithExtensions(exts: Record<string, boolean>) {
    const mock = createMockGL();
    for (const [name, available] of Object.entries(exts)) {
        mock.setExtensionAvailable(name, available);
    }
    const canvas = createMockCanvas(mock);
    canvas.width = 800;
    canvas.height = 600;
    const engine = createGLEngine(canvas);
    mock.setParallelComplete(true);
    return { mock, canvas, engine, gl: engine.gl };
}

/** All recorded calls with the given name, in order. */
function callsNamed(mock: MockGL, name: string): MockCall[] {
    return mock.log.filter((c) => c.name === name);
}

/** The most recent recorded call with the given name (or undefined). */
function lastCall(mock: MockGL, name: string): MockCall | undefined {
    const all = callsNamed(mock, name);
    return all[all.length - 1];
}

describe("lite-gl render-target: createRenderTarget", () => {
    it("creates one FBO, attaches the color texture at COLOR_ATTACHMENT0, validates completeness, and registers in _renderTargets", () => {
        const { mock, engine, gl } = setup();
        mock.clear();
        const rt = createRenderTarget(engine, { width: 256, height: 128 });
        expect(mock.count("createFramebuffer")).toBe(1);
        const attach = callsNamed(mock, "framebufferTexture2D");
        expect(attach).toHaveLength(1);
        expect(attach[0]?.args[0]).toBe(gl.FRAMEBUFFER);
        expect(attach[0]?.args[1]).toBe(gl.COLOR_ATTACHMENT0);
        expect(attach[0]?.args[2]).toBe(gl.TEXTURE_2D);
        expect(attach[0]?.args[3]).toBe(rt.texture.handle);
        expect(attach[0]?.args[4]).toBe(0);
        expect(mock.count("checkFramebufferStatus")).toBe(1);
        // Default has no depth/stencil renderbuffer.
        expect(mock.count("createRenderbuffer")).toBe(0);
        expect(mock.count("renderbufferStorage")).toBe(0);
        expect(rt._depthStencil).toBeNull();
        expect(rt._framebuffer).not.toBeNull();
        expect(rt.width).toBe(256);
        expect(rt.height).toBe(128);
        expect(rt.texture.width).toBe(256);
        expect(rt.isReady).toBe(true);
        // Registered as a render target; the OWNED color texture is NOT in the
        // engine `_textures` registry (the RT owns / restores / deletes it).
        expect(engine._renderTargets).toContain(rt);
        expect(engine._renderTargets).toHaveLength(1);
        expect(engine._textures).not.toContain(rt.texture);
    });

    it("uses a sized RGBA8 internal format + RGBA/UNSIGNED_BYTE for a byte target", () => {
        const { mock, engine, gl } = setup();
        mock.clear();
        createRenderTarget(engine, { width: 64, height: 32 });
        const ti = callsNamed(mock, "texImage2D");
        expect(ti).toHaveLength(1);
        // texImage2D(target, level, internalFormat, w, h, border, format, type, data)
        expect(ti[0]?.args[0]).toBe(gl.TEXTURE_2D);
        expect(ti[0]?.args[2]).toBe(gl.RGBA8);
        expect(ti[0]?.args[3]).toBe(64);
        expect(ti[0]?.args[4]).toBe(32);
        expect(ti[0]?.args[6]).toBe(gl.RGBA);
        expect(ti[0]?.args[7]).toBe(gl.UNSIGNED_BYTE);
        expect(ti[0]?.args[8]).toBeNull();
    });

    it("restores the previous framebuffer binding after building (leaves the default FB bound)", () => {
        const { engine } = setup();
        createRenderTarget(engine, { width: 16, height: 16 });
        expect(engine._state.boundFramebuffer).toBeNull();
    });

    it("honors custom filter / wrap options on the color texture", () => {
        const { mock, engine, gl } = setup();
        mock.clear();
        createRenderTarget(engine, {
            width: 8,
            height: 8,
            minFilter: gl.NEAREST,
            magFilter: gl.NEAREST,
            wrapS: gl.REPEAT,
            wrapT: gl.REPEAT,
        });
        const params = callsNamed(mock, "texParameteri").map((c) => c.args[2]);
        expect(params).toContain(gl.NEAREST);
        expect(params).toContain(gl.REPEAT);
    });

    it("rejects non-positive / non-integer sizes", () => {
        const { engine } = setup();
        expect(() => createRenderTarget(engine, { width: 0, height: 16 })).toThrow();
        expect(() => createRenderTarget(engine, { width: 16, height: 0 })).toThrow();
        expect(() => createRenderTarget(engine, { width: -4, height: 16 })).toThrow();
        expect(() => createRenderTarget(engine, { width: 1.5, height: 16 })).toThrow();
    });
});

describe("lite-gl render-target: depth attachment", () => {
    it("depth-only → DEPTH_COMPONENT16 on DEPTH_ATTACHMENT", () => {
        const { mock, engine, gl } = setup();
        mock.clear();
        const rt = createRenderTarget(engine, { width: 100, height: 100, generateDepthBuffer: true });
        expect(mock.count("createRenderbuffer")).toBe(1);
        const store = callsNamed(mock, "renderbufferStorage");
        expect(store).toHaveLength(1);
        expect(store[0]?.args[1]).toBe(gl.DEPTH_COMPONENT16);
        expect(store[0]?.args[2]).toBe(100);
        expect(store[0]?.args[3]).toBe(100);
        const fbr = callsNamed(mock, "framebufferRenderbuffer");
        expect(fbr).toHaveLength(1);
        expect(fbr[0]?.args[1]).toBe(gl.DEPTH_ATTACHMENT);
        expect(fbr[0]?.args[3]).toBe(rt._depthStencil);
        expect(rt._depthStencil).not.toBeNull();
    });

    it("no depth requested → no renderbuffer + a null _depthStencil", () => {
        const { mock, engine } = setup();
        mock.clear();
        const rt = createRenderTarget(engine, { width: 8, height: 8 });
        expect(mock.count("createRenderbuffer")).toBe(0);
        expect(mock.count("renderbufferStorage")).toBe(0);
        expect(rt._depthStencil).toBeNull();
    });
});

describe("lite-gl render-target: createFloatRenderTarget (HDR opt-in)", () => {
    it("defaults to HALF_FLOAT → RGBA16F", () => {
        const { mock, engine, gl } = setup();
        mock.clear();
        const rt = createFloatRenderTarget(engine, { width: 4, height: 4 });
        const ti = callsNamed(mock, "texImage2D")[0];
        expect(ti?.args[2]).toBe(gl.RGBA16F);
        expect(ti?.args[7]).toBe(gl.HALF_FLOAT);
        expect(engine._renderTargets).toContain(rt);
    });

    it("keeps FLOAT → RGBA32F when EXT_color_buffer_float is present", () => {
        const { mock, engine, gl } = setup();
        mock.clear();
        createFloatRenderTarget(engine, { width: 4, height: 4, type: gl.FLOAT });
        expect(callsNamed(mock, "texImage2D")[0]?.args[2]).toBe(gl.RGBA32F);
        expect(callsNamed(mock, "texImage2D")[0]?.args[7]).toBe(gl.FLOAT);
    });

    it("downgrades FLOAT → HALF_FLOAT (RGBA16F) when only half-float is renderable", () => {
        const { mock, engine, gl } = setupWithExtensions({ EXT_color_buffer_float: false });
        mock.clear();
        createFloatRenderTarget(engine, { width: 4, height: 4, type: gl.FLOAT });
        expect(callsNamed(mock, "texImage2D")[0]?.args[2]).toBe(gl.RGBA16F);
        expect(callsNamed(mock, "texImage2D")[0]?.args[7]).toBe(gl.HALF_FLOAT);
    });

    it("downgrades FLOAT → UNSIGNED_BYTE (RGBA8) when neither float nor half-float is renderable", () => {
        const { mock, engine, gl } = setupWithExtensions({ EXT_color_buffer_float: false, EXT_color_buffer_half_float: false });
        mock.clear();
        createFloatRenderTarget(engine, { width: 4, height: 4, type: gl.FLOAT });
        expect(callsNamed(mock, "texImage2D")[0]?.args[2]).toBe(gl.RGBA8);
        expect(callsNamed(mock, "texImage2D")[0]?.args[7]).toBe(gl.UNSIGNED_BYTE);
    });
});

describe("lite-gl render-target: bindRenderTarget", () => {
    it("binds the FBO and sets the viewport to the RT size", () => {
        const { mock, engine, gl } = setup();
        const rt = createRenderTarget(engine, { width: 320, height: 240 });
        mock.clear();
        bindRenderTarget(engine, rt);
        const bind = callsNamed(mock, "bindFramebuffer");
        expect(bind).toHaveLength(1);
        expect(bind[0]?.args[0]).toBe(gl.FRAMEBUFFER);
        expect(bind[0]?.args[1]).toBe(rt._framebuffer);
        expect(engine._state.boundFramebuffer).toBe(rt._framebuffer);
        expect(lastCall(mock, "viewport")?.args).toEqual([0, 0, 320, 240]);
    });

    it("elides a redundant bind of the same RT (one bindFramebuffer + one viewport for two calls)", () => {
        const { mock, engine } = setup();
        const rt = createRenderTarget(engine, { width: 128, height: 128 });
        mock.clear();
        bindRenderTarget(engine, rt);
        bindRenderTarget(engine, rt);
        expect(mock.count("bindFramebuffer")).toBe(1);
        expect(mock.count("viewport")).toBe(1);
    });

    it("bind(null) restores the default framebuffer and the canvas viewport", () => {
        const { mock, engine, gl } = setup();
        const rt = createRenderTarget(engine, { width: 128, height: 128 });
        bindRenderTarget(engine, rt);
        mock.clear();
        bindRenderTarget(engine, null);
        const bind = callsNamed(mock, "bindFramebuffer");
        expect(bind).toHaveLength(1);
        expect(bind[0]?.args[0]).toBe(gl.FRAMEBUFFER);
        expect(bind[0]?.args[1]).toBeNull();
        expect(engine._state.boundFramebuffer).toBeNull();
        expect(lastCall(mock, "viewport")?.args).toEqual([0, 0, 800, 600]);
    });

    it("is a no-op on a lost context and does not throw", () => {
        const { mock, canvas, engine } = setup();
        const rt = createRenderTarget(engine, { width: 64, height: 64 });
        fireLost(canvas);
        mock.clear();
        expect(() => bindRenderTarget(engine, rt)).not.toThrow();
        expect(mock.count("bindFramebuffer")).toBe(0);
    });

    it("is a no-op for a disposed RT", () => {
        const { mock, engine } = setup();
        const rt = createRenderTarget(engine, { width: 64, height: 64 });
        disposeRenderTarget(engine, rt);
        mock.clear();
        bindRenderTarget(engine, rt);
        expect(mock.count("bindFramebuffer")).toBe(0);
    });
});

describe("lite-gl render-target: manual mipmap generation", () => {
    it("creation never generates a mip chain (mipmaps are an explicit opt-in function)", () => {
        const { mock, engine } = setup();
        mock.clear();
        createRenderTarget(engine, { width: 16, height: 16 });
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("bindRenderTarget never auto-regenerates mips across switch / unbind", () => {
        const { mock, engine } = setup();
        const a = createRenderTarget(engine, { width: 16, height: 16 });
        const b = createRenderTarget(engine, { width: 16, height: 16 });
        bindRenderTarget(engine, a);
        mock.clear();
        bindRenderTarget(engine, b); // leaving `a` — no auto-regen anymore
        bindRenderTarget(engine, null); // leaving `b` — no auto-regen anymore
        expect(mock.count("generateMipmap")).toBe(0);
        expect(engine._currentRenderTarget).toBeNull();
    });

    it("generateRenderTargetMipMaps regenerates the color texture's mip chain on demand", () => {
        const { mock, engine } = setup();
        const rt = createRenderTarget(engine, { width: 16, height: 16 });
        // Displace texture unit 0 so the manual call's bind-for-upload is observable.
        const other = createRawTexture(engine, null, 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        bindTexture(engine, 0, other);
        mock.clear();
        generateRenderTargetMipMaps(engine, rt);
        expect(mock.count("generateMipmap")).toBe(1);
        // The generateMipmap targets the RT's color texture (bound for the upload).
        const bind = lastCall(mock, "bindTexture");
        expect(bind?.args[1]).toBe(rt.texture.handle);
    });

    it("generateRenderTargetMipMaps is a no-op on a disposed target", () => {
        const { mock, engine } = setup();
        const rt = createRenderTarget(engine, { width: 16, height: 16 });
        disposeRenderTarget(engine, rt);
        mock.clear();
        generateRenderTargetMipMaps(engine, rt);
        expect(mock.count("generateMipmap")).toBe(0);
    });

    it("disposing the current target clears the tracked reference", () => {
        const { engine } = setup();
        const rt = createRenderTarget(engine, { width: 16, height: 16 });
        bindRenderTarget(engine, rt);
        disposeRenderTarget(engine, rt);
        expect(engine._currentRenderTarget).toBeNull();
    });
});

describe("lite-gl render-target: color texture is a usable GLTexture", () => {
    it("can be bound directly via bindTexture without throwing", () => {
        const { mock, engine } = setup();
        const rt = createRenderTarget(engine, { width: 32, height: 32 });
        mock.clear();
        // Bind onto a unit that did NOT hold it (unit 1) — issues a real bind.
        expect(() => bindTexture(engine, 1, rt.texture)).not.toThrow();
        expect(mock.count("bindTexture")).toBe(1);
    });

    it("routes through setEffectTexture when a sampler unit exists", () => {
        const { engine } = setup();
        const rt = createRenderTarget(engine, { width: 32, height: 32 });
        const effect = { isReady: true, samplerUnits: { src: 2 } } as unknown as GLEffect;
        expect(() => setEffectTexture(engine, effect, "src", rt.texture)).not.toThrow();
        expect(engine._state.boundTextures[2]).toBe(rt.texture.handle);
    });
});

describe("lite-gl render-target: readback", () => {
    it("binds the FBO and reads RGBA / UNSIGNED_BYTE into a Uint8Array", () => {
        const { mock, engine, gl } = setup();
        const rt = createRenderTarget(engine, { width: 4, height: 4 });
        mock.clear();
        const out = readRenderTargetPixels(engine, rt, 0, 0, 4, 4);
        expect(out).toBeInstanceOf(Uint8Array);
        expect(out.byteLength).toBe(4 * 4 * 4);
        const rp = callsNamed(mock, "readPixels")[0];
        expect(rp?.args[4]).toBe(gl.RGBA);
        expect(rp?.args[5]).toBe(gl.UNSIGNED_BYTE);
    });

    it("a FLOAT target reads into a Float32Array with type FLOAT", () => {
        const { mock, engine, gl } = setup();
        const rt = createFloatRenderTarget(engine, { width: 2, height: 2, type: gl.FLOAT });
        mock.clear();
        const out = readRenderTargetPixels(engine, rt, 0, 0, 2, 2);
        expect(out).toBeInstanceOf(Float32Array);
        expect(callsNamed(mock, "readPixels")[0]?.args[5]).toBe(gl.FLOAT);
    });

    it("a HALF_FLOAT target reads into a Uint16Array with type HALF_FLOAT", () => {
        const { mock, engine, gl } = setup();
        const rt = createFloatRenderTarget(engine, { width: 2, height: 2 });
        mock.clear();
        const out = readRenderTargetPixels(engine, rt, 0, 0, 2, 2);
        expect(out).toBeInstanceOf(Uint16Array);
        expect(callsNamed(mock, "readPixels")[0]?.args[5]).toBe(gl.HALF_FLOAT);
    });

    it("reuses a provided buffer", () => {
        const { engine } = setup();
        const rt = createRenderTarget(engine, { width: 2, height: 2 });
        const into = new Uint8Array(2 * 2 * 4);
        const out = readRenderTargetPixels(engine, rt, 0, 0, 2, 2, into);
        expect(out).toBe(into);
    });
});

describe("lite-gl render-target: disposeRenderTarget", () => {
    it("deletes the FBO, the depth renderbuffer, and the owned color texture, and unregisters", () => {
        const { mock, engine } = setup();
        const rt = createRenderTarget(engine, { width: 64, height: 64, generateDepthBuffer: true });
        const fbo = rt._framebuffer;
        const rb = rt._depthStencil;
        const texHandle = rt.texture.handle;
        mock.clear();
        disposeRenderTarget(engine, rt);
        expect(callsNamed(mock, "deleteFramebuffer").map((c) => c.args[0])).toContain(fbo);
        expect(callsNamed(mock, "deleteRenderbuffer").map((c) => c.args[0])).toContain(rb);
        expect(callsNamed(mock, "deleteTexture").map((c) => c.args[0])).toContain(texHandle);
        expect(rt._framebuffer).toBeNull();
        expect(rt._depthStencil).toBeNull();
        expect(rt._disposed).toBe(true);
        expect(engine._renderTargets).not.toContain(rt);
    });

    it("is idempotent", () => {
        const { mock, engine } = setup();
        const rt = createRenderTarget(engine, { width: 64, height: 64 });
        disposeRenderTarget(engine, rt);
        mock.clear();
        expect(() => disposeRenderTarget(engine, rt)).not.toThrow();
        expect(mock.count("deleteFramebuffer")).toBe(0);
        expect(mock.count("deleteTexture")).toBe(0);
    });

    it("clears bound-texture slots that held the color texture", () => {
        const { engine } = setup();
        const rt = createRenderTarget(engine, { width: 64, height: 64 });
        bindTexture(engine, 3, rt.texture);
        expect(engine._state.boundTextures[3]).toBe(rt.texture.handle);
        disposeRenderTarget(engine, rt);
        expect(engine._state.boundTextures[3]).toBeNull();
    });

    it("resets boundFramebuffer to default when disposing the currently-bound RT", () => {
        const { engine } = setup();
        const rt = createRenderTarget(engine, { width: 64, height: 64 });
        bindRenderTarget(engine, rt);
        expect(engine._state.boundFramebuffer).toBe(rt._framebuffer);
        disposeRenderTarget(engine, rt);
        expect(engine._state.boundFramebuffer).toBeNull();
    });

    it("does not touch boundFramebuffer when disposing a non-bound RT", () => {
        const { engine } = setup();
        const bound = createRenderTarget(engine, { width: 64, height: 64 });
        const other = createRenderTarget(engine, { width: 64, height: 64 });
        bindRenderTarget(engine, bound);
        disposeRenderTarget(engine, other);
        expect(engine._state.boundFramebuffer).toBe(bound._framebuffer);
    });

    it("engine dispose frees render-target GPU objects", () => {
        const { mock, engine } = setup();
        createRenderTarget(engine, { width: 8, height: 8 });
        mock.clear();
        disposeGLEngine(engine);
        expect(mock.count("deleteFramebuffer")).toBe(1);
        expect(mock.count("deleteTexture")).toBe(1);
    });
});

describe("lite-gl render-target: resizeRenderTarget", () => {
    it("reallocates the color texture and rebuilds the FBO at the new size", () => {
        const { mock, engine } = setup();
        const rt = createRenderTarget(engine, { width: 64, height: 64, generateDepthBuffer: true });
        const oldFbo = rt._framebuffer;
        mock.clear();
        resizeRenderTarget(engine, rt, 128, 256);
        expect(rt.width).toBe(128);
        expect(rt.height).toBe(256);
        expect(rt.texture.width).toBe(128);
        expect(rt.texture.height).toBe(256);
        const ti = lastCall(mock, "texImage2D");
        expect(ti?.args[3]).toBe(128);
        expect(ti?.args[4]).toBe(256);
        expect(callsNamed(mock, "deleteFramebuffer").map((c) => c.args[0])).toContain(oldFbo);
        expect(mock.count("createFramebuffer")).toBe(1);
        const store = lastCall(mock, "renderbufferStorage");
        expect(store?.args[2]).toBe(128);
        expect(store?.args[3]).toBe(256);
    });

    it("is a no-op when the size is unchanged", () => {
        const { mock, engine } = setup();
        const rt = createRenderTarget(engine, { width: 64, height: 64 });
        mock.clear();
        resizeRenderTarget(engine, rt, 64, 64);
        expect(mock.count("createFramebuffer")).toBe(0);
        expect(mock.count("texImage2D")).toBe(0);
    });

    it("is a no-op for a disposed RT", () => {
        const { mock, engine } = setup();
        const rt = createRenderTarget(engine, { width: 64, height: 64 });
        disposeRenderTarget(engine, rt);
        mock.clear();
        resizeRenderTarget(engine, rt, 32, 32);
        expect(mock.count("createFramebuffer")).toBe(0);
    });
});

describe("lite-gl render-target: resizeRenderTarget preserves a live binding", () => {
    it("rebinds the freshly-built FBO and resets the viewport to the new size", () => {
        const { mock, engine } = setup();
        const rt = createRenderTarget(engine, { width: 64, height: 64 });
        bindRenderTarget(engine, rt);
        expect(engine._state.boundFramebuffer).toBe(rt._framebuffer);
        mock.clear();
        resizeRenderTarget(engine, rt, 200, 100);
        // Still bound to THIS target's rebuilt FBO — not silently reverted to the
        // default framebuffer (the canvas).
        expect(engine._state.boundFramebuffer).toBe(rt._framebuffer);
        expect(engine._state.boundFramebuffer).not.toBeNull();
        expect(lastCall(mock, "viewport")?.args).toEqual([0, 0, 200, 100]);
    });

    it("does not steal the binding when resizing a non-bound target", () => {
        const { engine } = setup();
        const bound = createRenderTarget(engine, { width: 32, height: 32 });
        const other = createRenderTarget(engine, { width: 32, height: 32 });
        bindRenderTarget(engine, bound);
        resizeRenderTarget(engine, other, 64, 64);
        expect(engine._state.boundFramebuffer).toBe(bound._framebuffer);
    });
});

describe("lite-gl render-target: context lost / restore", () => {
    it("recreates the FBO and reattaches the (fresh) color texture handle on restore", () => {
        const { mock, canvas, engine } = setup();
        const rt = createRenderTarget(engine, { width: 128, height: 128, generateDepthBuffer: true });
        const oldTexHandle = rt.texture.handle;
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        // The owned color texture got a fresh handle from the RT restore hook.
        expect(rt.texture.handle).not.toBe(oldTexHandle);
        expect(rt._framebuffer).not.toBeNull();
        expect(rt._depthStencil).not.toBeNull();
        expect(mock.count("createFramebuffer")).toBe(1);
        const attach = lastCall(mock, "framebufferTexture2D");
        expect(attach?.args[3]).toBe(rt.texture.handle);
        expect(mock.count("checkFramebufferStatus")).toBe(1);
    });

    it("can bind + draw into the target again after restore", () => {
        const { mock, canvas, engine } = setup();
        const rt = createRenderTarget(engine, { width: 64, height: 64 });
        fireLost(canvas);
        fireRestored(canvas);
        mock.clear();
        bindRenderTarget(engine, rt);
        const bind = lastCall(mock, "bindFramebuffer");
        expect(bind?.args[1]).toBe(rt._framebuffer);
        expect(bind?.args[1]).not.toBeNull();
        expect(lastCall(mock, "viewport")?.args).toEqual([0, 0, 64, 64]);
    });
});

describe("lite-gl render-target: BYO (bring-your-own) color texture", () => {
    it("attaches a caller-supplied GLTexture without creating a new one; it is not owned", () => {
        const { mock, engine } = setup();
        const byo = createRawTexture(engine, null, 32, 32, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        mock.clear();
        const rt = createRenderTarget(engine, { width: 32, height: 32, colorTexture: byo });
        // No new color texture was created — the BYO handle was attached.
        expect(mock.count("createTexture")).toBe(0);
        expect(mock.count("createFramebuffer")).toBe(1);
        expect(lastCall(mock, "framebufferTexture2D")?.args[3]).toBe(byo.handle);
        expect(rt.texture).toBe(byo);
        expect(rt._config.ownsColorTexture).toBe(false);
        // BYO stays in the engine `_textures` registry (engine-restored).
        expect(engine._textures).toContain(byo);
    });

    it("disposing the RT does NOT delete or dispose the BYO texture", () => {
        const { mock, engine } = setup();
        const byo = createRawTexture(engine, null, 16, 16, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        const rt = createRenderTarget(engine, { width: 16, height: 16, colorTexture: byo });
        const byoHandle = byo.handle;
        mock.clear();
        disposeRenderTarget(engine, rt);
        // FBO freed, but the BYO color texture is left intact for its owner.
        expect(mock.count("deleteFramebuffer")).toBe(1);
        expect(callsNamed(mock, "deleteTexture").map((c) => c.args[0])).not.toContain(byoHandle);
        expect(byo._disposed).toBe(false);
        expect(byo.handle).toBe(byoHandle);
        expect(engine._textures).toContain(byo);
    });

    it("re-attaches the BYO's freshly-restored handle after context restore (textures restored first)", () => {
        const { canvas, engine } = setup();
        const byo = createRawTexture(engine, null, 64, 64, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        const rt = createRenderTarget(engine, { width: 64, height: 64, colorTexture: byo });
        const oldHandle = byo.handle;
        fireLost(canvas);
        fireRestored(canvas);
        // The engine restored the BYO texture (new handle) BEFORE the RT restore
        // hook ran; the RT then re-attached that fresh handle.
        expect(byo.handle).not.toBe(oldHandle);
        expect(rt.texture.handle).toBe(byo.handle);
        expect(rt._framebuffer).not.toBeNull();
    });

    it("resizes the BYO storage to the new size (not the stale original) when resized", () => {
        const { mock, engine } = setup();
        const byo = createRawTexture(engine, null, 16, 16, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        const rt = createRenderTarget(engine, { width: 16, height: 16, colorTexture: byo });
        mock.clear();
        resizeRenderTarget(engine, rt, 48, 24);
        // The caller's storage was re-specified at the NEW size via the raw-update
        // hook, so the attachment matches the FBO.
        const ti = lastCall(mock, "texImage2D");
        expect(ti?.args[3]).toBe(48);
        expect(ti?.args[4]).toBe(24);
        expect(byo.width).toBe(48);
        expect(byo.height).toBe(24);
    });
});

describe("lite-gl render-target: ping-pong", () => {
    it("creates two distinct targets; read starts as A, write as B", () => {
        const { engine } = setup();
        const pp = createPingPong(engine, { width: 64, height: 64 });
        expect(pp.read).toBe(pp._a);
        expect(pp.write).toBe(pp._b);
        expect(pp.read).not.toBe(pp.write);
    });

    it("swap flips read/write and is allocation-free (same two target instances)", () => {
        const { engine } = setup();
        const pp = createPingPong(engine, { width: 64, height: 64 });
        const a = pp.read;
        const b = pp.write;
        pp.swap();
        expect(pp.read).toBe(b);
        expect(pp.write).toBe(a);
        pp.swap();
        expect(pp.read).toBe(a);
        expect(pp.write).toBe(b);
    });

    it("resizePingPong resizes both targets", () => {
        const { engine } = setup();
        const pp = createPingPong(engine, { width: 32, height: 32 });
        resizePingPong(engine, pp, 128, 64);
        expect(pp._a.width).toBe(128);
        expect(pp._a.height).toBe(64);
        expect(pp._b.width).toBe(128);
        expect(pp._b.height).toBe(64);
    });

    it("disposePingPong disposes both targets and is idempotent", () => {
        const { mock, engine } = setup();
        const pp = createPingPong(engine, { width: 32, height: 32 });
        disposePingPong(engine, pp);
        expect(pp._a._disposed).toBe(true);
        expect(pp._b._disposed).toBe(true);
        expect(pp._disposed).toBe(true);
        mock.clear();
        expect(() => disposePingPong(engine, pp)).not.toThrow();
        expect(mock.count("deleteFramebuffer")).toBe(0);
    });

    it("both targets survive a context restore", () => {
        const { canvas, engine } = setup();
        const pp = createPingPong(engine, { width: 64, height: 64 });
        fireLost(canvas);
        fireRestored(canvas);
        expect(pp._a._framebuffer).not.toBeNull();
        expect(pp._b._framebuffer).not.toBeNull();
    });
});

describe("lite-gl render-target: atomic failure cleanup", () => {
    // FRAMEBUFFER_UNSUPPORTED (≠ FRAMEBUFFER_COMPLETE) — forces the completeness
    // check to report an incomplete framebuffer.
    const FRAMEBUFFER_UNSUPPORTED = 0x8cdd;

    it("deletes the partial FBO + depth renderbuffer and the owned color texture, and restores the previous binding, when the framebuffer is incomplete", () => {
        const { mock, engine } = setup();
        // Bind a sentinel target first so there is a NON-default previous
        // framebuffer the failed build must restore to.
        const sentinel = createRenderTarget(engine, { width: 16, height: 16 });
        bindRenderTarget(engine, sentinel);
        expect(engine._state.boundFramebuffer).toBe(sentinel._framebuffer);
        const rtCountBefore = engine._renderTargets.length;
        mock.clear();
        (engine.gl as unknown as { checkFramebufferStatus: () => number }).checkFramebufferStatus = () => FRAMEBUFFER_UNSUPPORTED;

        expect(() => createRenderTarget(engine, { width: 32, height: 32, generateDepthBuffer: true })).toThrow(/incomplete/);

        // No leaked handles: every GL object created during the failed build was
        // deleted again.
        expect(mock.count("createFramebuffer")).toBe(1);
        expect(mock.count("deleteFramebuffer")).toBe(1);
        expect(mock.count("createRenderbuffer")).toBe(1);
        expect(mock.count("deleteRenderbuffer")).toBe(1);
        expect(mock.count("createTexture")).toBe(1);
        expect(mock.count("deleteTexture")).toBe(1);
        // The failed target was never registered.
        expect(engine._renderTargets.length).toBe(rtCountBefore);
        // The previous binding was restored despite the throw.
        expect(engine._state.boundFramebuffer).toBe(sentinel._framebuffer);
        expect(engine._state.boundFramebuffer).not.toBeNull();
    });

    it("disposes the owned color texture and restores the binding when createFramebuffer returns null", () => {
        const { mock, engine } = setup();
        const sentinel = createRenderTarget(engine, { width: 16, height: 16 });
        bindRenderTarget(engine, sentinel);
        mock.clear();
        (engine.gl as unknown as { createFramebuffer: () => WebGLFramebuffer | null }).createFramebuffer = () => null;

        expect(() => createRenderTarget(engine, { width: 32, height: 32 })).toThrow(/createFramebuffer/);

        expect(mock.count("deleteFramebuffer")).toBe(0);
        expect(mock.count("createTexture")).toBe(1);
        expect(mock.count("deleteTexture")).toBe(1);
        expect(engine._state.boundFramebuffer).toBe(sentinel._framebuffer);
    });

    it("disposes the FIRST ping-pong target when the SECOND one fails to build", () => {
        const { mock, engine } = setup();
        const rtCountBefore = engine._renderTargets.length;
        let builds = 0;
        const realCheck = engine.gl.checkFramebufferStatus;
        (engine.gl as unknown as { checkFramebufferStatus: (t: number) => number }).checkFramebufferStatus = (t: number): number => {
            builds += 1;
            return builds >= 2 ? FRAMEBUFFER_UNSUPPORTED : realCheck(t);
        };
        mock.clear();

        expect(() => createPingPong(engine, { width: 32, height: 32 })).toThrow(/incomplete/);

        // Both color textures + both FBOs were created and then freed — the first
        // target was released by createPingPong's cleanup path.
        expect(mock.count("createTexture")).toBe(2);
        expect(mock.count("deleteTexture")).toBe(2);
        expect(mock.count("createFramebuffer")).toBe(2);
        expect(mock.count("deleteFramebuffer")).toBe(2);
        expect(engine._renderTargets.length).toBe(rtCountBefore);
    });
});

describe("lite-gl render-target: null-safe dispose", () => {
    it("disposeRenderTarget(engine, null | undefined) is a no-op and does not throw", () => {
        const { mock, engine } = setup();
        mock.clear();
        expect(() => disposeRenderTarget(engine, null)).not.toThrow();
        expect(() => disposeRenderTarget(engine, undefined)).not.toThrow();
        expect(mock.count("deleteFramebuffer")).toBe(0);
        expect(mock.count("deleteTexture")).toBe(0);
    });

    it("disposePingPong(engine, null | undefined) is a no-op and does not throw", () => {
        const { mock, engine } = setup();
        mock.clear();
        expect(() => disposePingPong(engine, null)).not.toThrow();
        expect(() => disposePingPong(engine, undefined)).not.toThrow();
        expect(mock.count("deleteFramebuffer")).toBe(0);
    });
});
