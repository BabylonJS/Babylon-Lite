import { describe, expect, it } from "vitest";
import { createGLEngine } from "../../../packages/babylon-lite-gl/src/context";
import { setDepthState, setCullState, setStencilState, setColorMask, clearEngine, generateRenderTargetStencil } from "../../../packages/babylon-lite-gl/src/depth-stencil";
import { applyGLStates } from "../../../packages/babylon-lite-gl/src/apply-states";
import { createRenderTarget, disposeRenderTarget, resizeRenderTarget, bindRenderTarget } from "../../../packages/babylon-lite-gl/src/render-target";
import { createMockCanvas, createMockGL, fireLost, fireRestored, type MockCall, type MockGL } from "./_lite-gl-mock";

function makeEngine() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    return { mock, canvas, engine };
}

/** Engine + sized canvas for the render-target stencil opt-in tests. */
function makeRTEngine() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    canvas.width = 256;
    canvas.height = 256;
    const engine = createGLEngine(canvas);
    mock.setParallelComplete(true);
    return { mock, canvas, engine };
}

function callsNamed(mock: MockGL, name: string): MockCall[] {
    return mock.log.filter((c) => c.name === name);
}

describe("lite-gl depth state", () => {
    it("enables/disables DEPTH_TEST, sets mask + func, all cached", () => {
        const { mock, engine } = makeEngine();
        setDepthState(engine, { test: true, write: true, func: engine.gl.LESS });
        applyGLStates(engine);
        expect(callsNamed(mock, "enable").some((c) => c.args[0] === engine.gl.DEPTH_TEST)).toBe(true);
        expect(callsNamed(mock, "depthMask")[0]?.args).toEqual([true]);
        expect(callsNamed(mock, "depthFunc")[0]?.args).toEqual([engine.gl.LESS]);
        mock.clear();
        setDepthState(engine, { test: true, write: true, func: engine.gl.LESS });
        applyGLStates(engine);
        expect(callsNamed(mock, "enable")).toHaveLength(0);
        expect(callsNamed(mock, "depthMask")).toHaveLength(0);
        expect(callsNamed(mock, "depthFunc")).toHaveLength(0);
    });

    it("only re-issues the field that changed", () => {
        const { mock, engine } = makeEngine();
        setDepthState(engine, { test: true, write: true });
        applyGLStates(engine);
        mock.clear();
        setDepthState(engine, { write: false });
        applyGLStates(engine);
        expect(callsNamed(mock, "depthMask")[0]?.args).toEqual([false]);
        expect(callsNamed(mock, "enable")).toHaveLength(0);
        expect(callsNamed(mock, "disable")).toHaveLength(0);
    });

    it("omitted fields are untouched", () => {
        const { mock, engine } = makeEngine();
        setDepthState(engine, { func: engine.gl.LESS });
        applyGLStates(engine);
        expect(callsNamed(mock, "depthMask")).toHaveLength(0);
        expect(callsNamed(mock, "enable")).toHaveLength(0);
    });

    it("intra-frame churn collapses to a single applied value (write true→false→true, one flush)", () => {
        const { mock, engine } = makeEngine();
        setDepthState(engine, { write: true });
        setDepthState(engine, { write: false });
        setDepthState(engine, { write: true });
        applyGLStates(engine);
        // Only the surviving desired value (true) reaches GL — vs the sentinel -1.
        expect(callsNamed(mock, "depthMask")).toHaveLength(1);
        expect(callsNamed(mock, "depthMask")[0]?.args).toEqual([true]);
    });
});

describe("lite-gl cull state", () => {
    it("enables CULL_FACE + sets cullFace, cached", () => {
        const { mock, engine } = makeEngine();
        setCullState(engine, true, engine.gl.BACK);
        applyGLStates(engine);
        expect(callsNamed(mock, "enable").some((c) => c.args[0] === engine.gl.CULL_FACE)).toBe(true);
        expect(callsNamed(mock, "cullFace")[0]?.args).toEqual([engine.gl.BACK]);
        mock.clear();
        setCullState(engine, true, engine.gl.BACK);
        applyGLStates(engine);
        expect(callsNamed(mock, "enable")).toHaveLength(0);
        expect(callsNamed(mock, "cullFace")).toHaveLength(0);
    });
});

describe("lite-gl stencil state", () => {
    it("applies the func triple as a unit and caches it", () => {
        const { mock, engine } = makeEngine();
        setStencilState(engine, { test: true, mask: 0xff, func: engine.gl.ALWAYS, ref: 1, funcMask: 0xff });
        applyGLStates(engine);
        expect(callsNamed(mock, "enable").some((c) => c.args[0] === engine.gl.STENCIL_TEST)).toBe(true);
        expect(callsNamed(mock, "stencilMask")[0]?.args).toEqual([0xff]);
        expect(callsNamed(mock, "stencilFunc")[0]?.args).toEqual([engine.gl.ALWAYS, 1, 0xff]);
        mock.clear();
        setStencilState(engine, { func: engine.gl.ALWAYS, ref: 1, funcMask: 0xff });
        applyGLStates(engine);
        expect(callsNamed(mock, "stencilFunc")).toHaveLength(0);
    });

    it("applies the op triple independently of the func triple", () => {
        const { mock, engine } = makeEngine();
        setStencilState(engine, { opFail: engine.gl.INCR_WRAP, opZFail: engine.gl.INCR_WRAP, opZPass: engine.gl.INCR_WRAP });
        applyGLStates(engine);
        expect(callsNamed(mock, "stencilOp")[0]?.args).toEqual([engine.gl.INCR_WRAP, engine.gl.INCR_WRAP, engine.gl.INCR_WRAP]);
        expect(callsNamed(mock, "stencilFunc")).toHaveLength(0);
    });

    it("partial func update merges unspecified members from cache", () => {
        const { mock, engine } = makeEngine();
        setStencilState(engine, { func: engine.gl.ALWAYS, ref: 0, funcMask: 0x3 });
        applyGLStates(engine);
        mock.clear();
        setStencilState(engine, { func: engine.gl.NOTEQUAL });
        applyGLStates(engine);
        expect(callsNamed(mock, "stencilFunc")[0]?.args).toEqual([engine.gl.NOTEQUAL, 0, 0x3]);
    });
});

describe("lite-gl color mask", () => {
    it("issues colorMask and caches the packed value", () => {
        const { mock, engine } = makeEngine();
        setColorMask(engine, true, true, true, true);
        applyGLStates(engine);
        expect(callsNamed(mock, "colorMask")[0]?.args).toEqual([true, true, true, true]);
        mock.clear();
        setColorMask(engine, true, true, true, true);
        applyGLStates(engine);
        expect(callsNamed(mock, "colorMask")).toHaveLength(0);
        setColorMask(engine, false, false, false, false);
        applyGLStates(engine);
        expect(callsNamed(mock, "colorMask")[0]?.args).toEqual([false, false, false, false]);
    });
});

describe("lite-gl clearEngine", () => {
    it("clears color with the right bit + clearColor", () => {
        const { mock, engine } = makeEngine();
        clearEngine(engine, { color: { r: 0.1, g: 0.2, b: 0.3 } });
        expect(callsNamed(mock, "clearColor")[0]?.args).toEqual([0.1, 0.2, 0.3, 1]);
        expect(callsNamed(mock, "clear")[0]?.args).toEqual([engine.gl.COLOR_BUFFER_BIT]);
    });

    it("ORs depth + stencil bits", () => {
        const { mock, engine } = makeEngine();
        clearEngine(engine, { depth: true, stencil: true });
        expect(callsNamed(mock, "clear")[0]?.args[0]).toBe(engine.gl.DEPTH_BUFFER_BIT | engine.gl.STENCIL_BUFFER_BIT);
    });

    it("is a no-op when nothing is requested", () => {
        const { mock, engine } = makeEngine();
        clearEngine(engine, {});
        expect(callsNamed(mock, "clear")).toHaveLength(0);
    });

    it("flushes deferred write-mask state before clearing (Babylon parity — clear respects masks)", () => {
        const { mock, engine } = makeEngine();
        // A deferred colorMask has NOT been applied yet (setter is lazy).
        setColorMask(engine, true, false, true, false);
        expect(callsNamed(mock, "colorMask")).toHaveLength(0);
        clearEngine(engine, { color: { r: 0, g: 0, b: 0 } });
        // clearEngine flushed the mask, and it precedes gl.clear in the log.
        expect(callsNamed(mock, "colorMask")[0]?.args).toEqual([true, false, true, false]);
        const idxMask = mock.log.findIndex((c) => c.name === "colorMask");
        const idxClear = mock.log.findIndex((c) => c.name === "clear");
        expect(idxMask).toBeGreaterThanOrEqual(0);
        expect(idxClear).toBeGreaterThan(idxMask);
    });
});

describe("lite-gl depth/stencil: lost-context safety", () => {
    it("all setters are no-ops on a lost context", () => {
        const { mock, canvas, engine } = makeEngine();
        fireLost(canvas);
        mock.clear();
        expect(() => {
            setDepthState(engine, { test: true });
            setStencilState(engine, { test: true });
            setColorMask(engine, true, false, true, false);
            clearEngine(engine, { color: { r: 0, g: 0, b: 0 } });
        }).not.toThrow();
        expect(mock.log).toHaveLength(0);
    });
});

describe("lite-gl render-target stencil opt-in (generateRenderTargetStencil)", () => {
    it("default → packed DEPTH24_STENCIL8 on DEPTH_STENCIL_ATTACHMENT, replacing the core depth-only buffer", () => {
        const { mock, engine } = makeRTEngine();
        const gl = engine.gl;
        const rt = createRenderTarget(engine, { width: 64, height: 64, generateDepthBuffer: true });
        const depthOnly = rt._depthStencil;
        mock.clear();
        generateRenderTargetStencil(engine, rt);
        // The packed buffer replaced (deleted) the core depth-only renderbuffer.
        expect(callsNamed(mock, "deleteRenderbuffer").map((c) => c.args[0])).toContain(depthOnly);
        const store = callsNamed(mock, "renderbufferStorage");
        expect(store).toHaveLength(1);
        expect(store[0]?.args[1]).toBe(gl.DEPTH24_STENCIL8);
        expect(callsNamed(mock, "framebufferRenderbuffer")[0]?.args[1]).toBe(gl.DEPTH_STENCIL_ATTACHMENT);
        // Completeness is validated; the field now holds the packed buffer.
        expect(mock.count("checkFramebufferStatus")).toBe(1);
        expect(rt._depthStencil).not.toBeNull();
        expect(rt._depthStencil).not.toBe(depthOnly);
    });

    it("{ depth: false } → stencil-only STENCIL_INDEX8 on STENCIL_ATTACHMENT", () => {
        const { mock, engine } = makeRTEngine();
        const gl = engine.gl;
        const rt = createRenderTarget(engine, { width: 64, height: 64 });
        mock.clear();
        generateRenderTargetStencil(engine, rt, { depth: false });
        const store = callsNamed(mock, "renderbufferStorage");
        expect(store).toHaveLength(1);
        expect(store[0]?.args[1]).toBe(gl.STENCIL_INDEX8);
        expect(store[0]?.args[2]).toBe(64);
        expect(store[0]?.args[3]).toBe(64);
        expect(callsNamed(mock, "framebufferRenderbuffer")[0]?.args[1]).toBe(gl.STENCIL_ATTACHMENT);
        expect(rt._depthStencil).not.toBeNull();
    });

    it("installs a rebuild hook that re-creates the packed buffer on context restore", () => {
        const { mock, canvas, engine } = makeRTEngine();
        const gl = engine.gl;
        const rt = createRenderTarget(engine, { width: 64, height: 64, generateDepthBuffer: true });
        generateRenderTargetStencil(engine, rt);
        expect(rt._rebuildDepthStencil).toBeDefined();
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        // After the RT's restore runs, the stencil hook fired and rebuilt the
        // packed depth+stencil attachment into the fresh FBO.
        expect(callsNamed(mock, "renderbufferStorage").some((c) => c.args[1] === gl.DEPTH24_STENCIL8)).toBe(true);
        expect(callsNamed(mock, "framebufferRenderbuffer").some((c) => c.args[1] === gl.DEPTH_STENCIL_ATTACHMENT)).toBe(true);
        expect(rt._depthStencil).not.toBeNull();
    });

    it("the hook rebuilds the packed buffer at the NEW size on resize", () => {
        const { mock, engine } = makeRTEngine();
        const gl = engine.gl;
        const rt = createRenderTarget(engine, { width: 64, height: 64, generateDepthBuffer: true });
        generateRenderTargetStencil(engine, rt);
        mock.clear();
        resizeRenderTarget(engine, rt, 128, 128);
        const packed = callsNamed(mock, "renderbufferStorage").filter((c) => c.args[1] === gl.DEPTH24_STENCIL8);
        expect(packed.length).toBeGreaterThanOrEqual(1);
        expect(packed[packed.length - 1]?.args[2]).toBe(128);
        expect(packed[packed.length - 1]?.args[3]).toBe(128);
        expect(rt._depthStencil).not.toBeNull();
    });

    it("is a no-op on a disposed target", () => {
        const { mock, engine } = makeRTEngine();
        const rt = createRenderTarget(engine, { width: 64, height: 64 });
        disposeRenderTarget(engine, rt);
        mock.clear();
        generateRenderTargetStencil(engine, rt);
        expect(mock.count("createRenderbuffer")).toBe(0);
    });

    it("is a no-op on a lost context", () => {
        const { mock, canvas, engine } = makeRTEngine();
        const rt = createRenderTarget(engine, { width: 64, height: 64 });
        fireLost(canvas);
        mock.clear();
        generateRenderTargetStencil(engine, rt);
        expect(mock.count("createRenderbuffer")).toBe(0);
    });

    it("is state-neutral — restores the previously-bound draw target after attaching", () => {
        const { mock, engine } = makeRTEngine();
        const other = createRenderTarget(engine, { width: 32, height: 32 });
        const rt = createRenderTarget(engine, { width: 64, height: 64, generateDepthBuffer: true });
        // Make another RT the active draw target, then add stencil to `rt`.
        bindRenderTarget(engine, other);
        const prevFb = engine._state.boundFramebuffer;
        expect(prevFb).toBe(other._framebuffer);
        mock.clear();
        generateRenderTargetStencil(engine, rt);
        // The helper must NOT leave rt's FBO bound — the caller's target is restored.
        expect(engine._state.boundFramebuffer).toBe(prevFb);
        const binds = callsNamed(mock, "bindFramebuffer");
        expect(binds[binds.length - 1]?.args[1]).toBe(prevFb);
    });

    it("deletes the new renderbuffer and restores the binding when the framebuffer is incomplete", () => {
        const { mock, engine } = makeRTEngine();
        const gl = engine.gl;
        const rt = createRenderTarget(engine, { width: 64, height: 64 }); // no depth/stencil yet
        expect(rt._depthStencil).toBeNull();
        const prevFb = engine._state.boundFramebuffer;
        mock.clear();
        // Force the post-attach completeness check to fail for this call only.
        const origCheck = gl.checkFramebufferStatus;
        gl.checkFramebufferStatus = () => 0x8cd6; // FRAMEBUFFER_INCOMPLETE_ATTACHMENT
        try {
            expect(() => generateRenderTargetStencil(engine, rt)).toThrow(/incomplete/);
        } finally {
            gl.checkFramebufferStatus = origCheck;
        }
        // The renderbuffer created for the failed attach was deleted exactly once
        // (no leak); the target's attachment is left as it was, and the draw target
        // the caller had bound is restored.
        expect(mock.count("createRenderbuffer")).toBe(1);
        expect(mock.count("deleteRenderbuffer")).toBe(1);
        expect(rt._depthStencil).toBeNull();
        expect(engine._state.boundFramebuffer).toBe(prevFb);
    });

    it("rolls back to the core depth buffer when a with-depth attach is incomplete", () => {
        const { mock, engine } = makeRTEngine();
        const gl = engine.gl;
        const rt = createRenderTarget(engine, { width: 64, height: 64, generateDepthBuffer: true });
        const coreDepth = rt._depthStencil;
        expect(coreDepth).not.toBeNull();
        mock.clear();
        const origCheck = gl.checkFramebufferStatus;
        gl.checkFramebufferStatus = () => 0x8cd6; // FRAMEBUFFER_INCOMPLETE_ATTACHMENT
        try {
            expect(() => generateRenderTargetStencil(engine, rt)).toThrow(/incomplete/);
        } finally {
            gl.checkFramebufferStatus = origCheck;
        }
        // The new packed buffer was created then deleted (no leak); the core depth
        // buffer is retained, not deleted.
        expect(mock.count("createRenderbuffer")).toBe(1);
        expect(mock.count("deleteRenderbuffer")).toBe(1);
        expect(rt._depthStencil).toBe(coreDepth);
        // The packed attach cleared DEPTH_ATTACHMENT; the rollback re-established the
        // core depth buffer there, so the target keeps a valid depth attachment.
        const reattach = callsNamed(mock, "framebufferRenderbuffer").filter((c) => c.args[1] === gl.DEPTH_ATTACHMENT && c.args[3] === coreDepth);
        expect(reattach.length).toBeGreaterThanOrEqual(1);
        // A failed first opt-in must not install the resize/restore hook.
        expect(rt._rebuildDepthStencil).toBeUndefined();
    });
});
