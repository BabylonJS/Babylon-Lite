import { describe, expect, it, beforeAll } from "vitest";
import {
    createGLEngine,
    registerTextRenderer,
    runRenderLoop,
    unregisterTextRenderer,
    type GLEngineContext,
    type GLTextRenderer,
} from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL } from "./_lite-gl-mock";

beforeAll(() => {
    // Node has no rAF. registerTextRenderer installs a render-loop callback via runRenderLoop,
    // which schedules the first frame with requestAnimationFrame; these tests never advance a
    // frame, so the stored callback is never invoked.
    const g = globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number; cancelAnimationFrame?: (h: number) => void };
    if (g.requestAnimationFrame === undefined) {
        g.requestAnimationFrame = () => 1;
    }
    if (g.cancelAnimationFrame === undefined) {
        g.cancelAnimationFrame = () => undefined;
    }
});

/** A minimal renderer stand-in: registration only reads `_engine`, `_disposed` and `_loopFn`,
 *  so no real Slug effect (which needs a live GL context) is compiled. */
function fakeRenderer(engine: GLEngineContext, disposed = false): GLTextRenderer {
    return { _engine: engine, _disposed: disposed, _loopFn: null } as unknown as GLTextRenderer;
}

describe("lite-gl text renderer — engine-loop registration", () => {
    it("registerTextRenderer installs exactly one render-loop callback (idempotent)", () => {
        const engine = createGLEngine(createMockCanvas(createMockGL()));
        const r = fakeRenderer(engine);
        registerTextRenderer(r);
        registerTextRenderer(r);
        registerTextRenderer(r);
        expect(engine._loops.length).toBe(1);
        expect(r._loopFn).not.toBeNull();
    });

    it("unregisterTextRenderer removes the callback and clears _loopFn (idempotent)", () => {
        const engine = createGLEngine(createMockCanvas(createMockGL()));
        const r = fakeRenderer(engine);
        registerTextRenderer(r);
        unregisterTextRenderer(r);
        expect(engine._loops.length).toBe(0);
        expect(r._loopFn).toBeNull();
        unregisterTextRenderer(r);
        expect(engine._loops.length).toBe(0);
    });

    it("registering one renderer leaves another engine callback untouched", () => {
        const engine = createGLEngine(createMockCanvas(createMockGL()));
        const r = fakeRenderer(engine);
        registerTextRenderer(r);
        const other = (): void => undefined;
        runRenderLoop(engine, other);
        unregisterTextRenderer(r);
        expect(engine._loops.length).toBe(1);
        expect(engine._loops[0]).toBe(other);
    });

    it("registerTextRenderer is a no-op on a disposed renderer", () => {
        const engine = createGLEngine(createMockCanvas(createMockGL()));
        const r = fakeRenderer(engine, true);
        registerTextRenderer(r);
        expect(engine._loops.length).toBe(0);
        expect(r._loopFn).toBeNull();
    });
});
