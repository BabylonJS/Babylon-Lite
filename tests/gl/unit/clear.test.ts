import { describe, expect, it } from "vitest";
import { clearEngine, createGLEngine, disposeGLEngine, resizeGLEngine, setGLEngineSize, setHardwareScalingLevel } from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL, fireLost, fireRestored, type MockCall, type MockGL } from "./_lite-gl-mock";

// Adapted from the tinylottie branch's `clear.test.ts`. The converged API exposes
// `clearEngine(engine, { color, depth, stencil })` (from the depth-stencil module)
// rather than the branch-local `clear(engine, color, ...)`. `setGLEngineSize`
// (explicit drawing-buffer resize, used by the Lottie animationController) is part
// of the converged surface alongside the CSS-derived `resizeGLEngine`.

function setup() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    mock.setParallelComplete(true);
    return { mock, canvas, engine, gl: engine.gl };
}

function callsNamed(mock: MockGL, name: string): MockCall[] {
    return mock.log.filter((c) => c.name === name);
}

describe("lite-gl clearEngine(): color", () => {
    it("clears the color buffer with the supplied color", () => {
        const { mock, engine, gl } = setup();
        mock.clear();
        clearEngine(engine, { color: { r: 0.1, g: 0.2, b: 0.3, a: 0.4 } });
        const cc = callsNamed(mock, "clearColor");
        expect(cc).toHaveLength(1);
        expect(cc[0]?.args).toEqual([0.1, 0.2, 0.3, 0.4]);
        const c = callsNamed(mock, "clear");
        expect(c).toHaveLength(1);
        expect(c[0]?.args[0]).toBe(gl.COLOR_BUFFER_BIT);
    });

    it("defaults alpha to 1 when omitted", () => {
        const { mock, engine } = setup();
        mock.clear();
        clearEngine(engine, { color: { r: 0, g: 0, b: 0 } });
        expect(callsNamed(mock, "clearColor")[0]?.args).toEqual([0, 0, 0, 1]);
    });

    it("does not clear the color buffer (or call clearColor) when no color is given", () => {
        const { mock, engine } = setup();
        mock.clear();
        clearEngine(engine, {});
        expect(mock.count("clearColor")).toBe(0);
        // No bits set => no gl.clear issued.
        expect(mock.count("clear")).toBe(0);
    });

    it("combines depth and stencil bits with color", () => {
        const { mock, engine, gl } = setup();
        mock.clear();
        clearEngine(engine, { color: { r: 0, g: 0, b: 0, a: 0 }, depth: true, stencil: true });
        const c = callsNamed(mock, "clear");
        expect(c).toHaveLength(1);
        expect(c[0]?.args[0]).toBe(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    });

    it("is a no-op on a lost context", () => {
        const { mock, canvas, engine } = setup();
        fireLost(canvas);
        mock.clear();
        clearEngine(engine, { color: { r: 1, g: 1, b: 1, a: 1 } });
        expect(mock.count("clear")).toBe(0);
        expect(mock.count("clearColor")).toBe(0);
    });

    it("is a no-op after dispose", () => {
        const { mock, engine } = setup();
        disposeGLEngine(engine);
        mock.clear();
        clearEngine(engine, { color: { r: 1, g: 1, b: 1, a: 1 } });
        expect(mock.count("clear")).toBe(0);
    });
});

describe("lite-gl setGLEngineSize(): explicit drawing-buffer resize", () => {
    it("sets the drawing buffer to the explicit size", () => {
        const { canvas, engine } = setup();
        setGLEngineSize(engine, 800, 600);
        expect(canvas.width).toBe(800);
        expect(canvas.height).toBe(600);
    });

    it("divides the requested size by the hardware-scaling level", () => {
        const { canvas, engine } = setup();
        setHardwareScalingLevel(engine, 2);
        setGLEngineSize(engine, 800, 600);
        expect(canvas.width).toBe(400);
        expect(canvas.height).toBe(300);
    });

    it("clamps to a minimum of 1×1", () => {
        const { canvas, engine } = setup();
        setGLEngineSize(engine, 0, 0);
        expect(canvas.width).toBe(1);
        expect(canvas.height).toBe(1);
    });

    it("is a no-op after dispose", () => {
        const { canvas, engine } = setup();
        disposeGLEngine(engine);
        const w = canvas.width;
        const h = canvas.height;
        setGLEngineSize(engine, 1234, 5678);
        expect(canvas.width).toBe(w);
        expect(canvas.height).toBe(h);
    });

    it("supports an OffscreenCanvas-style surface (no CSS box): resizeGLEngine is a no-op, setGLEngineSize still works", () => {
        const mock = createMockGL();
        const canvas = createMockCanvas(mock);
        // Simulate an OffscreenCanvas (worker render path, e.g. the Lottie player):
        // no clientWidth/clientHeight, sized explicitly.
        delete (canvas as { clientWidth?: number }).clientWidth;
        delete (canvas as { clientHeight?: number }).clientHeight;
        canvas.width = 320;
        canvas.height = 240;
        const engine = createGLEngine(canvas);
        // CSS-derived auto-resize must NOT touch an explicitly-sized offscreen surface.
        resizeGLEngine(engine);
        expect(canvas.width).toBe(320);
        expect(canvas.height).toBe(240);
        // Explicit sizing still applies.
        setGLEngineSize(engine, 640, 480);
        expect(canvas.width).toBe(640);
        expect(canvas.height).toBe(480);
    });
});

describe("lite-gl clearEngine(): clearColor cache", () => {
    it("elides gl.clearColor when the color is unchanged, but still clears", () => {
        const { mock, engine } = setup();
        clearEngine(engine, { color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } });
        mock.clear();
        clearEngine(engine, { color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } });
        clearEngine(engine, { color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } });
        // Same color → gl.clearColor elided (the redundant-call fix)...
        expect(callsNamed(mock, "clearColor")).toHaveLength(0);
        // ...but the actual clear still runs each call.
        expect(callsNamed(mock, "clear")).toHaveLength(2);
    });

    it("re-issues gl.clearColor when the color changes", () => {
        const { mock, engine } = setup();
        clearEngine(engine, { color: { r: 0.1, g: 0.2, b: 0.3 } });
        mock.clear();
        clearEngine(engine, { color: { r: 0.4, g: 0.5, b: 0.6 } });
        const cc = callsNamed(mock, "clearColor");
        expect(cc).toHaveLength(1);
        expect(cc[0]?.args).toEqual([0.4, 0.5, 0.6, 1]);
    });

    it("a changed alpha alone re-issues gl.clearColor", () => {
        const { mock, engine } = setup();
        clearEngine(engine, { color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } });
        mock.clear();
        clearEngine(engine, { color: { r: 0.1, g: 0.2, b: 0.3, a: 0.5 } });
        expect(callsNamed(mock, "clearColor")).toHaveLength(1);
    });

    it("resets the clearColor cache on context loss so the next clear re-issues", () => {
        const { mock, canvas, engine } = setup();
        clearEngine(engine, { color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } });
        fireLost(canvas);
        fireRestored(canvas);
        mock.clear();
        // The restored context's gl.clearColor is back at the GL default, so the
        // reset cache must re-issue rather than wrongly elide.
        clearEngine(engine, { color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } });
        expect(callsNamed(mock, "clearColor")).toHaveLength(1);
    });
});
